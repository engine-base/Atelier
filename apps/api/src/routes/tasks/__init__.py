"""Task CRUD + 受入条件取得 ルータ (T-A-26)。

07_api_design/openapi.yaml の /tasks, /tasks/{id}, /tasks/{id}/acceptance-criteria。
認証は get_current_user (401)、可視性/権限は RLS (T-D-16) + 404/403。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.rate_limit import rate_limit_user
from src.schemas.tasks import (
    AcceptanceCriteriaResponse,
    PlayTaskRequest,
    PlayTaskResponse,
    RelatedResourceResponse,
    SpecChangeResolveRequest,
    SpecChangeResolveResponse,
    SpecChangeResponse,
    TaskBulkLifecycleRequest,
    TaskBulkLifecycleResponse,
    TaskCreate,
    TaskDecisionRequest,
    TaskExecutionResponse,
    TaskResponse,
    TaskUpdate,
)
from src.services import tasks as svc

router = APIRouter(tags=["tasks"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/tasks", summary="タスク一覧")
async def list_tasks(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
    lifecycle_stage: Annotated[str | None, Query()] = None,
    delivery_phase_id: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, list[TaskResponse]]:
    items = await svc.list_tasks(
        session,
        project_id=project_id,
        lifecycle_stage=lifecycle_stage,
        delivery_phase_id=delivery_phase_id,
        limit=limit,
    )
    return {"data": items}


@router.post("/tasks", status_code=status.HTTP_201_CREATED, summary="タスク作成")
async def create_task(
    body: TaskCreate, session: SessionDep, user: UserDep
) -> dict[str, TaskResponse]:
    return {"data": await svc.create_task(session, actor_id=user.id, data=body)}


@router.get("/tasks/{task_id}", summary="タスク詳細")
async def get_task(task_id: str, session: SessionDep, _user: UserDep) -> dict[str, TaskResponse]:
    task = await svc.get_task(session, task_id)
    if task is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    return {"data": task}


@router.patch("/tasks/{task_id}", summary="タスク更新")
async def update_task(
    task_id: str, body: TaskUpdate, session: SessionDep, user: UserDep
) -> dict[str, TaskResponse]:
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    try:
        updated = await svc.update_task(session, actor_id=user.id, task_id=task_id, data=body)
    except ValueError as exc:
        # GAP-025: 検証担当の WS 越境 (task の workspace 外の AI 社員) は 422
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "同じワークスペースの AI 社員のみ割り当てられます。",
        ) from exc
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "このタスクを変更する権限がありません。")
    return {"data": updated}


@router.delete(
    "/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT, summary="タスク削除（論理）"
)
async def delete_task(task_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    if not await svc.delete_task(session, actor_id=user.id, task_id=task_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "このタスクを削除する権限がありません。")


@router.get("/tasks/{task_id}/acceptance-criteria", summary="受入条件取得")
async def get_acceptance_criteria(
    task_id: str, session: SessionDep, _user: UserDep
) -> dict[str, AcceptanceCriteriaResponse]:
    # task 自体が不可視 (RLS) なら 404
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    ac = await svc.get_acceptance_criteria(session, task_id)
    if ac is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の受け入れ条件が見つかりません。")
    return {"data": ac}


@router.get("/tasks/{task_id}/executions", summary="タスク実行履歴")
async def list_executions(
    task_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[TaskExecutionResponse]]:
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    return {"data": await svc.list_executions(session, task_id=task_id)}


@router.get("/tasks/{task_id}/executions/{execution_id}", summary="タスク実行詳細・スコア")
async def get_execution(
    task_id: str, execution_id: str, session: SessionDep, _user: UserDep
) -> dict[str, TaskExecutionResponse]:
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    ex = await svc.get_execution(session, task_id=task_id, execution_id=execution_id)
    if ex is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクの実行記録が見つかりません。")
    return {"data": ex}


# --------------------------------------------------------------------------- #
# T-A-25: タスク一括再生 + 承認/差戻/再試行
# --------------------------------------------------------------------------- #
@router.post(
    "/tasks/bulk/lifecycle",
    summary="タスク lifecycle 一括遷移（再生 / 承認等の bulk 操作）",
)
async def bulk_lifecycle(
    body: TaskBulkLifecycleRequest, session: SessionDep, user: UserDep
) -> dict[str, TaskBulkLifecycleResponse]:
    return {"data": await svc.bulk_lifecycle(session, actor_id=user.id, data=body)}


@router.post("/tasks/{task_id}/approve", summary="タスク承認 (awaiting → done)")
async def approve_task(
    task_id: str,
    body: TaskDecisionRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, TaskResponse]:
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    updated = await svc.approve_task(session, actor_id=user.id, task_id=task_id, data=body)
    if updated is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "このタスクは承認待ちではないため、承認できません。"
        )
    return {"data": updated}


@router.post("/tasks/{task_id}/reject", summary="タスク差戻 (awaiting → blocked)")
async def reject_task(
    task_id: str,
    body: TaskDecisionRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, TaskResponse]:
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    updated = await svc.reject_task(session, actor_id=user.id, task_id=task_id, data=body)
    if updated is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "このタスクは承認待ちではないため、差し戻せません。"
        )
    return {"data": updated}


@router.post(
    "/tasks/{task_id}/retry",
    summary="タスク再試行 (blocked → ready, retry_count += 1)",
)
async def retry_task(
    task_id: str,
    body: TaskDecisionRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, TaskResponse]:
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    updated = await svc.retry_task(session, actor_id=user.id, task_id=task_id, data=body)
    if updated is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "このタスクは停止中ではないため、やり直せません。"
        )
    return {"data": updated}


# --------------------------------------------------------------------------- #
# T-A-24: タスク再生 API (/tasks/{id}/play, dispatcher 連動)
# openapi.yaml では path 変数を {id} で公開 (PlayTask 仕様)。
# --------------------------------------------------------------------------- #
@router.post(
    "/tasks/{id}/play",
    status_code=status.HTTP_202_ACCEPTED,
    summary="タスク再生（dispatcher へ）",
    dependencies=[Depends(rate_limit_user(10))],  # x-rate-limit: 10/min/user
)
async def play_task(
    id: str,
    session: SessionDep,
    user: UserDep,
    body: PlayTaskRequest | None = None,
) -> dict[str, PlayTaskResponse]:
    # 契約 (openapi.yaml) では requestBody は optional。body 無し = force=False。
    # 必須のままだと S-I01 の再生ボタン (body なし POST) が 422 になる。
    result, payload = await svc.play_task(
        session, actor_id=user.id, task_id=id, data=body or PlayTaskRequest()
    )
    if result == svc.PlayResult.NOT_FOUND:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    if result == svc.PlayResult.INVALID_STATE:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "このタスクは、いま実行できる状態ではありません。",
        )
    if result == svc.PlayResult.DEPS_UNMET:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "先に終わらせる必要のあるタスクが残っています。",
        )
    assert payload is not None
    return {"data": payload}


@router.get(
    "/tasks/{task_id}/spec-changes",
    summary="仕様変更の検知 (GAP-025① — S-I02 あなたへの確認カード)",
)
async def get_task_spec_change(
    task_id: str, session: SessionDep, _user: UserDep
) -> dict[str, SpecChangeResponse | None]:
    """紐づくモックに新版が出ていれば返す (無ければ data=null — カード非描画)。"""
    if await svc.get_task(session, task_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    return {"data": await svc.get_spec_change(session, task_id=task_id)}


@router.post(
    "/tasks/{task_id}/spec-changes/resolve",
    summary="仕様変更 3 択の実行 (GAP-025① — adopt/split/discard)",
)
async def resolve_task_spec_change(
    task_id: str, body: SpecChangeResolveRequest, session: SessionDep, user: UserDep
) -> dict[str, SpecChangeResolveResponse]:
    result = await svc.resolve_spec_change(
        session,
        actor_id=user.id,
        task_id=task_id,
        choice=body.choice,
        latest_mock_id=body.latest_mock_id,
    )
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    return {"data": result}


@router.get(
    "/tasks/{task_id}/related",
    summary="関連資料の逆引き (GAP-025③ — S-I02 関連資料タブ)",
)
async def list_task_related(
    task_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[RelatedResourceResponse]]:
    items = await svc.list_related_resources(session, task_id=task_id)
    if items is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のタスクが見つかりません。")
    return {"data": items}
