"""影響範囲解析 (impact) ルータ (T-A-23 / F-IMP01)。

GET /impact/tasks/{task_id} — 起点 task の下流影響範囲 (descendants) を返す。
認証 (401) + RLS (T-D-16 tasks_*_member) で可視性 scope。read-only ゆえ audit_logs
書込は無し。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.impact import ImpactAnalysisResponse
from src.services import impact as svc

router = APIRouter(tags=["impact"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/impact/tasks/{task_id}", summary="タスク影響範囲解析（下流 task 群）")
async def analyze_task_impact(
    task_id: str, session: SessionDep, _user: UserDep
) -> dict[str, ImpactAnalysisResponse]:
    result = await svc.analyze_downstream(session, task_id=task_id)
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task not found")
    return {"data": result}
