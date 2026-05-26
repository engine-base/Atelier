"""運営 admin ルータ (T-A-43)。

GET /admin/audit-logs。認証 (401) に加え、admin (app_metadata.role=admin) でなければ
403。閲覧範囲は RLS (T-D-19) で scope される。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.admin import AuditLogResponse
from src.services import admin as svc

router = APIRouter(tags=["admin"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/admin/audit-logs", summary="監査ログ閲覧（運営 admin）")
async def list_audit_logs(
    session: SessionDep,
    user: UserDep,
    workspace_id: Annotated[str | None, Query()] = None,
    action: Annotated[str | None, Query()] = None,
    actor_type: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> dict[str, list[AuditLogResponse]]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    items = await svc.list_audit_logs(
        session,
        workspace_id=workspace_id,
        action=action,
        actor_type=actor_type,
        limit=limit,
    )
    return {"data": items}
