"""運営 admin サービス層 (T-A-43)。

audit_logs (E-020) の閲覧。可視範囲は RLS (T-D-19 audit_logs_select) で
scope される (admin が所属する workspace のログ)。状態変更は無い (read-only)。
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser
from src.schemas.admin import AuditLogResponse

_COLS = (
    "id, workspace_id, actor_type, actor_id, action, target_type, target_id, "
    "before, after, cast(ip_address as text) as ip_address, created_at"
)


def is_admin(user: CurrentUser) -> bool:
    """JWT の app_metadata.role / user_metadata.role が 'admin' か。"""
    claims = user.claims
    for key in ("app_metadata", "user_metadata"):
        meta = claims.get(key)
        if isinstance(meta, dict) and meta.get("role") == "admin":
            return True
    return claims.get("user_role") == "admin"


def _json(value: object) -> dict[str, object] | None:
    if value is None:
        return None
    if isinstance(value, str):
        loaded: Any = json.loads(value)
        return loaded if isinstance(loaded, dict) else None
    if isinstance(value, dict):
        return value
    return None


def _row_to_response(row: Any) -> AuditLogResponse:
    return AuditLogResponse(
        id=str(row.id),
        workspace_id=(None if row.workspace_id is None else str(row.workspace_id)),
        actor_type=str(row.actor_type),
        actor_id=str(row.actor_id),
        action=str(row.action),
        target_type=str(row.target_type),
        target_id=(None if row.target_id is None else str(row.target_id)),
        before=_json(row.before),
        after=_json(row.after),
        ip_address=(None if row.ip_address is None else str(row.ip_address)),
        created_at=row.created_at,
    )


async def list_audit_logs(
    session: AsyncSession,
    *,
    workspace_id: str | None = None,
    action: str | None = None,
    actor_type: str | None = None,
    limit: int = 100,
) -> list[AuditLogResponse]:
    limit = max(1, min(limit, 500))
    where = ["1=1"]
    params: dict[str, object] = {"lim": limit}
    if workspace_id is not None:
        where.append("workspace_id = cast(:wid as uuid)")
        params["wid"] = workspace_id
    if action is not None:
        where.append("action = :act")
        params["act"] = action
    if actor_type is not None:
        where.append("actor_type = :at")
        params["at"] = actor_type
    res = await session.execute(
        text(
            f"select {_COLS} from public.audit_logs "
            f"where {' and '.join(where)} order by created_at desc limit :lim"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]
