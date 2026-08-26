"""cron スケジュール ルータ (T-A-40)。

/cron-schedules[/{id}]。認証 (401) + RLS (cron_schedules_*_member) + 404/403。
状態変更は audit_logs 記録。target_action は task_replay / knowledge_organize /
industry_extract / report_summary / daily_digest / weekly_burndown のいずれか。
GAP-179: cron 式は保存時に検証し next_run_at を確定する (発火は dispatcher)。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.cron import (
    CronActionResponse,
    CronRunResponse,
    CronScheduleCreate,
    CronScheduleResponse,
    CronScheduleUpdate,
    PlatformJobResponse,
)
from src.services import cron as svc
from src.services import platform_jobs as platform_svc
from src.services.cron import history as history_svc
from src.services.cron.actions import ACTION_SPECS
from src.services.cron.expression import CronExpressionError

router = APIRouter(tags=["cron-schedules"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/cron-schedules", summary="cron スケジュール一覧")
async def list_schedules(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
    enabled: Annotated[bool | None, Query()] = None,
) -> dict[str, list[CronScheduleResponse]]:
    return {"data": await svc.list_schedules(session, project_id=project_id, enabled=enabled)}


@router.get(
    "/cron-actions",
    summary="自動実行の種類とコスト情報 (GAP-179 — 画面表示の唯一の信頼源)",
)
async def list_cron_actions(_user: UserDep) -> dict[str, list[CronActionResponse]]:
    """画面のコスト表示・説明はここを読む。

    実際に走る処理 (services/cron/actions.py) と同じ定義を返すので、
    「画面には BYOK API 使用と書いてあるが実際は動いていない」類の食い違いが
    構造的に起きない。
    """
    return {
        "data": [
            CronActionResponse(
                action=spec.action,  # pyright: ignore[reportArgumentType]
                title=spec.title,
                description=spec.description,
                group=spec.group,
                staff=spec.staff,
                requires_bridge=spec.requires_bridge,
                cost_label=spec.cost_label,
                cost_note=spec.cost_note,
            )
            for spec in ACTION_SPECS.values()
        ]
    }


@router.get("/cron-runs", summary="cron 実行履歴一覧 (GAP-013 / S-O01 実行履歴)")
async def list_cron_runs(
    session: SessionDep,
    _user: UserDep,
    name: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
) -> dict[str, list[CronRunResponse]]:
    return {"data": await history_svc.list_runs(session, name=name, limit=limit)}


@router.get(
    "/cron-platform-jobs",
    summary="プラットフォーム必須ジョブ一覧 (GAP-014 / S-O01 法令・運用、read-only)",
)
async def list_platform_jobs(
    session: SessionDep,
    _user: UserDep,
) -> dict[str, list[PlatformJobResponse]]:
    return {"data": await platform_svc.list_platform_jobs(session)}


@router.post(
    "/cron-schedules",
    status_code=status.HTTP_201_CREATED,
    summary="cron スケジュール作成",
)
async def create_schedule(
    body: CronScheduleCreate, session: SessionDep, user: UserDep
) -> dict[str, CronScheduleResponse]:
    try:
        created = await svc.create_schedule(session, actor_id=user.id, data=body)
    except CronExpressionError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    if created is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "自動実行の予定を作る権限がありません。")
    return {"data": created}


@router.get("/cron-schedules/{schedule_id}", summary="cron スケジュール詳細")
async def get_schedule(
    schedule_id: str, session: SessionDep, _user: UserDep
) -> dict[str, CronScheduleResponse]:
    item = await svc.get_schedule(session, schedule_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の自動実行の予定が見つかりません。")
    return {"data": item}


@router.patch("/cron-schedules/{schedule_id}", summary="cron スケジュール更新")
async def update_schedule(
    schedule_id: str,
    body: CronScheduleUpdate,
    session: SessionDep,
    user: UserDep,
) -> dict[str, CronScheduleResponse]:
    if await svc.get_schedule(session, schedule_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の自動実行の予定が見つかりません。")
    try:
        updated = await svc.update_schedule(
            session, actor_id=user.id, schedule_id=schedule_id, data=body
        )
    except CronExpressionError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    if updated is None:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "この自動実行の予定を変更する権限がありません。"
        )
    return {"data": updated}


@router.post(
    "/cron-schedules/{schedule_id}/run-now",
    summary="この自動実行を今すぐ実行 (GAP-185)",
)
async def run_schedule_now(
    schedule_id: str, session: SessionDep, _user: UserDep
) -> dict[str, dict[str, object]]:
    """止まっているもの・待ちきれないものを、人の操作で今すぐ動かす。

    次回時刻 (next_run_at) は変えない — 手動実行で定期スケジュールをずらさない。
    まだ実行できない (PC 未接続 / プラン枠の上限) 場合は deferred を返す。
    """
    from src.services.cron.dispatcher import run_one_now

    if await svc.get_schedule(session, schedule_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の自動実行の予定が見つかりません。")
    result = await run_one_now(session, schedule_id=schedule_id)
    if result.get("status") == "not_found":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の自動実行の予定が見つかりません。")
    return {"data": result}


@router.delete(
    "/cron-schedules/{schedule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="cron スケジュール削除 (owner のみ)",
)
async def delete_schedule(schedule_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_schedule(session, schedule_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の自動実行の予定が見つかりません。")
    if not await svc.delete_schedule(session, actor_id=user.id, schedule_id=schedule_id):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "自動実行の予定を削除できるのはオーナーだけです。"
        )
