"""承認待ちインボックス (approval_inbox) サービス層 (T-A-32)。

RLS approval_inbox_*_self が本人 (user_id = auth.uid()) のみに可視性/編集権限を
強制するため、越境は自然に 404 となる (RLS で 0 行)。decide は pending → approved
or rejected の状態遷移で resolved_at を自動セット、状態変更で audit_logs。
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.approvals import ApprovalDecideRequest, ApprovalResponse

_COLS = (
    "id, user_id, type, target_type, target_id, title, payload, status, "
    "resolved_at, resolution_note, created_at, updated_at"
)


def _payload(value: object) -> dict[str, object]:
    if value is None:
        return {}
    if isinstance(value, str):
        loaded: Any = json.loads(value)
        return loaded if isinstance(loaded, dict) else {}
    if isinstance(value, dict):
        return value
    return {}


def _row_to_response(row: Any) -> ApprovalResponse:
    return ApprovalResponse(
        id=str(row.id),
        user_id=str(row.user_id),
        type=str(row.type),
        target_type=str(row.target_type),
        target_id=str(row.target_id),
        title=str(row.title),
        payload=_payload(row.payload),
        status=str(row.status),
        resolved_at=row.resolved_at,
        resolution_note=(None if row.resolution_note is None else str(row.resolution_note)),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_approvals(
    session: AsyncSession,
    *,
    status_filter: str | None = None,
    type_filter: str | None = None,
    limit: int = 50,
) -> list[ApprovalResponse]:
    """本人の承認待ち一覧。RLS approval_inbox_select_self で自然に scope。"""
    limit = max(1, min(limit, 200))
    where: list[str] = ["1=1"]
    params: dict[str, object] = {"lim": limit}
    if status_filter is not None:
        where.append("status = :st")
        params["st"] = status_filter
    if type_filter is not None:
        where.append("type = cast(:t as approval_inbox_type_enum)")
        params["t"] = type_filter
    res = await session.execute(
        text(
            f"select {_COLS} from public.approval_inbox "
            f"where {' and '.join(where)} order by created_at desc limit :lim"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_approval(session: AsyncSession, approval_id: str) -> ApprovalResponse | None:
    res = await session.execute(
        text(f"select {_COLS} from public.approval_inbox where id = cast(:id as uuid)"),
        {"id": approval_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def decide_approval(
    session: AsyncSession,
    *,
    actor_id: str,
    approval_id: str,
    data: ApprovalDecideRequest,
) -> ApprovalResponse | None:
    """pending な inbox 項目を approve/reject。

    Returns:
        None — 不在 / 不可視 / 既に解決済 (status != pending) のいずれか。
               ルータで 404 / 409 を区別しないシンプルな運用 (本人のみ可視で
               status は連続的に変化しないため 409 は不要)。
    """
    new_status = "approved" if data.decision == "approve" else "rejected"
    res = await session.execute(
        text(
            "update public.approval_inbox "
            "set status = :st, resolved_at = now(), resolution_note = :note "
            "where id = cast(:id as uuid) and status = 'pending' "
            "returning id"
        ),
        {"st": new_status, "note": data.note, "id": approval_id},
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="approval.decide",
            target_type="approval_inbox",
            actor_type="user",
            actor_id=actor_id,
            target_id=approval_id,
            after={"decision": data.decision, "note": data.note},
        )
    )
    return await get_approval(session, approval_id)
