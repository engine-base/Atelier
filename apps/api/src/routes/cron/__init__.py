"""cron スケジュール ルータ (T-A-40)。

/cron-schedules[/{id}]。認証 (401) + RLS (cron_schedules_*_member) + 404/403。
状態変更は audit_logs 記録。target_action は task_replay / knowledge_organize /
industry_extract / report_summary / daily_digest / weekly_burndown のいずれか。
Inngest 連動 (T-F-20) は別 PR で配線、本タスクは CRUD のみ。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.cron import (
    CronScheduleCreate,
    CronScheduleResponse,
    CronScheduleUpdate,
)
from src.services import cron as svc

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


@router.post(
    "/cron-schedules",
    status_code=status.HTTP_201_CREATED,
    summary="cron スケジュール作成",
)
async def create_schedule(
    body: CronScheduleCreate, session: SessionDep, user: UserDep
) -> dict[str, CronScheduleResponse]:
    created = await svc.create_schedule(session, actor_id=user.id, data=body)
    if created is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to create cron_schedule")
    return {"data": created}


@router.get("/cron-schedules/{schedule_id}", summary="cron スケジュール詳細")
async def get_schedule(
    schedule_id: str, session: SessionDep, _user: UserDep
) -> dict[str, CronScheduleResponse]:
    item = await svc.get_schedule(session, schedule_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "cron_schedule not found")
    return {"data": item}


@router.patch("/cron-schedules/{schedule_id}", summary="cron スケジュール更新")
async def update_schedule(
    schedule_id: str,
    body: CronScheduleUpdate,
    session: SessionDep,
    user: UserDep,
) -> dict[str, CronScheduleResponse]:
    if await svc.get_schedule(session, schedule_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "cron_schedule not found")
    updated = await svc.update_schedule(
        session, actor_id=user.id, schedule_id=schedule_id, data=body
    )
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update cron_schedule")
    return {"data": updated}


@router.delete(
    "/cron-schedules/{schedule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="cron スケジュール削除 (owner のみ)",
)
async def delete_schedule(schedule_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_schedule(session, schedule_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "cron_schedule not found")
    if not await svc.delete_schedule(session, actor_id=user.id, schedule_id=schedule_id):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "owner role required to delete cron_schedule"
        )
