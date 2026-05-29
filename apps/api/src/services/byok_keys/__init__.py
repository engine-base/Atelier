"""BYOK API キー管理サービス層 (T-A-09)。

plaintext は Fernet (`cryptography.fernet.Fernet`) で対称暗号化して
`byok_api_keys.encrypted_key` (text) に urlsafe-base64 文字列で保存する。
鍵は `ATELIER_BYOK_ENCRYPTION_KEY` env (Fernet 鍵 — 32 byte 鍵を urlsafe-base64
した 44 文字) から生成する。鍵未設定時はサーバ起動時 (= 初回呼出時) に明示的に
エラーを返す (HTTP 500)。

RLS は本人 (user_id = auth.uid()) のみ可視/編集可能、状態変更で audit_logs 記録。
"""

from __future__ import annotations

import os
import uuid
from functools import lru_cache
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.byok_keys import ByokKeyCreate, ByokKeyResponse, ByokKeyUpdate

_COLS = "id, user_id, provider, key_label, is_active, created_at, updated_at"


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    """Fernet インスタンスを env から構築 (process 単位で 1 度)。"""
    raw = os.environ.get("ATELIER_BYOK_ENCRYPTION_KEY", "")
    if not raw:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "BYOK encryption key not configured"
        )
    try:
        return Fernet(raw.encode("ascii"))
    except (ValueError, TypeError) as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "BYOK encryption key is invalid"
        ) from exc


def encrypt_key(plaintext: str) -> str:
    """plaintext → urlsafe-base64 文字列 (Fernet token)。"""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_key(ciphertext: str) -> str:
    """Fernet token → plaintext。鍵が違う / 改竄では HTTP 500 を投げる。"""
    try:
        return _fernet().decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:  # pragma: no cover - 鍵入替や改竄の防御
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "BYOK key decryption failed"
        ) from exc


def _row_to_response(row: Any) -> ByokKeyResponse:
    return ByokKeyResponse(
        id=str(row.id),
        user_id=str(row.user_id),
        provider=str(row.provider),
        label=(None if row.key_label is None else str(row.key_label)),
        is_active=bool(row.is_active),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_keys(
    session: AsyncSession,
    *,
    provider: str | None = None,
    include_inactive: bool = False,
) -> list[ByokKeyResponse]:
    """本人の BYOK 一覧。RLS byok_api_keys_select_owner で自然に scope。"""
    where: list[str] = ["1=1"]
    params: dict[str, object] = {}
    if provider is not None:
        where.append("provider = :p")
        params["p"] = provider
    if not include_inactive:
        where.append("is_active = true")
    res = await session.execute(
        text(
            f"select {_COLS} from public.byok_api_keys "
            f"where {' and '.join(where)} order by created_at desc"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_key(session: AsyncSession, key_id: str) -> ByokKeyResponse | None:
    res = await session.execute(
        text(f"select {_COLS} from public.byok_api_keys where id = cast(:id as uuid)"),
        {"id": key_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_key(
    session: AsyncSession, *, actor_id: str, data: ByokKeyCreate
) -> ByokKeyResponse | None:
    encrypted = encrypt_key(data.key)
    new_id = str(uuid.uuid4())
    res = await session.execute(
        text(
            "insert into public.byok_api_keys "
            "(id, user_id, provider, encrypted_key, key_label) "
            "values (cast(:id as uuid), cast(:uid as uuid), :p, :ek, :l) returning id"
        ),
        {"id": new_id, "uid": actor_id, "p": data.provider, "ek": encrypted, "l": data.label},
    )
    if res.scalar_one_or_none() is None:  # pragma: no cover - RLS 違反は通常 raise
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="byok_key.create",
            target_type="byok_api_key",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={"provider": data.provider, "label": data.label},
        )
    )
    return await get_key(session, new_id)


async def update_key(
    session: AsyncSession, *, actor_id: str, key_id: str, data: ByokKeyUpdate
) -> ByokKeyResponse | None:
    """label / is_active のみ更新可。plaintext key の更新は delete → recreate を要求する
    (機密上限を狭くする運用)。"""
    sets: list[str] = []
    params: dict[str, object] = {"id": key_id}
    if data.label is not None:
        sets.append("key_label = :l")
        params["l"] = data.label
    if data.is_active is not None:
        sets.append("is_active = :a")
        params["a"] = data.is_active
    if not sets:
        return await get_key(session, key_id)
    res = await session.execute(
        text(
            f"update public.byok_api_keys set {', '.join(sets)} "
            "where id = cast(:id as uuid) returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="byok_key.update",
            target_type="byok_api_key",
            actor_type="user",
            actor_id=actor_id,
            target_id=key_id,
            after={k: v for k, v in params.items() if k != "id"},
        )
    )
    return await get_key(session, key_id)


async def delete_key(session: AsyncSession, *, actor_id: str, key_id: str) -> bool:
    res = await session.execute(
        text("delete from public.byok_api_keys where id = cast(:id as uuid) returning id"),
        {"id": key_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="byok_key.delete",
            target_type="byok_api_key",
            actor_type="user",
            actor_id=actor_id,
            target_id=key_id,
        )
    )
    return True
