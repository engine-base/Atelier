"""自己プロフィール（/me）サービス層 — T-UC-37。

public.users の自分自身の行を読み書きする。email は認証（Supabase Auth）に紐づく
ため本サービスでは変更せず、display_name のみ更新する。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.schemas.users import MeResponse


def _row_to_response(row: Any) -> MeResponse:
    return MeResponse(
        id=str(row.id),
        email=str(row.email),
        display_name=(None if row.display_name is None else str(row.display_name)),
        ai_learning_opt_out=bool(row.ai_learning_opt_out),
    )


async def get_me(session: AsyncSession, user_id: str) -> MeResponse | None:
    res = await session.execute(
        text(
            "select id, email, display_name, ai_learning_opt_out from public.users "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": user_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def update_me(session: AsyncSession, *, user_id: str, display_name: str) -> MeResponse | None:
    res = await session.execute(
        text(
            "update public.users set display_name = :dn "
            "where id = cast(:id as uuid) and deleted_at is null "
            "returning id, email, display_name, ai_learning_opt_out"
        ),
        {"id": user_id, "dn": display_name},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)
