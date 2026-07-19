"""プロジェクト・シークレットサービス層 (T-A-46)。

plaintext は Fernet で対称暗号化して `project_credentials.encrypted_value` に
urlsafe-base64 文字列で保存する。鍵は `ATELIER_VAULT_ENCRYPTION_KEY` env から
生成する (未設定時は HTTP 500)。

RLS は project の workspace member のみ可視/編集可能 (T-D-36)。状態変更 +
reveal はすべて audit_logs に記録する (誰がいつ復号したか)。
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
from src.schemas.project_credentials import (
    CredentialCreate,
    CredentialResponse,
    CredentialReveal,
    CredentialUpdate,
)

_COLS = (
    "c.id, c.project_id, c.name, c.kind, c.last4, c.created_at, c.updated_at, "
    "u.display_name AS created_by_name"
)


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    """Fernet インスタンスを env から構築 (process 単位で 1 度)。"""
    raw = os.environ.get("ATELIER_VAULT_ENCRYPTION_KEY", "")
    if not raw:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "vault encryption key not configured"
        )
    try:
        return Fernet(raw.encode("ascii"))
    except (ValueError, TypeError) as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "vault encryption key is invalid"
        ) from exc


def encrypt_value(plaintext: str) -> str:
    """plaintext → urlsafe-base64 文字列 (Fernet token)。"""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_value(ciphertext: str) -> str:
    """Fernet token → plaintext。鍵が違う / 改竄では HTTP 500。"""
    try:
        return _fernet().decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:  # pragma: no cover - 鍵入替や改竄の防御
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "vault decryption failed"
        ) from exc


def _last4(plaintext: str) -> str:
    return plaintext[-4:] if len(plaintext) >= 4 else plaintext


def _row_to_response(row: Any) -> CredentialResponse:
    return CredentialResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        name=str(row.name),
        kind=str(row.kind),
        last4=(None if row.last4 is None else str(row.last4)),
        created_by_name=(None if row.created_by_name is None else str(row.created_by_name)),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


async def list_credentials(session: AsyncSession, *, project_id: str) -> list[CredentialResponse]:
    """project のシークレット一覧 (RLS で workspace member に scope)。値は含まない。"""
    res = await session.execute(
        text(
            f"select {_COLS} from public.project_credentials c "
            "left join public.users u on u.id = c.created_by "
            "where c.project_id = cast(:pid as uuid) and c.deleted_at is null "
            "order by c.created_at desc"
        ),
        {"pid": project_id},
    )
    return [_row_to_response(r) for r in res.all()]


async def get_credential(
    session: AsyncSession, *, project_id: str, credential_id: str
) -> CredentialResponse | None:
    res = await session.execute(
        text(
            f"select {_COLS} from public.project_credentials c "
            "left join public.users u on u.id = c.created_by "
            "where c.id = cast(:id as uuid) and c.project_id = cast(:pid as uuid) "
            "and c.deleted_at is null"
        ),
        {"id": credential_id, "pid": project_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_credential(
    session: AsyncSession, *, actor_id: str, project_id: str, data: CredentialCreate
) -> CredentialResponse | None:
    """シークレットに登録。value を暗号化して保存 (平文は保存しない)。"""
    encrypted = encrypt_value(data.value)
    new_id = str(uuid.uuid4())
    res = await session.execute(
        text(
            "insert into public.project_credentials "
            "(id, project_id, name, kind, encrypted_value, last4, created_by) "
            "values (cast(:id as uuid), cast(:pid as uuid), :n, "
            "cast(:k as credential_kind_enum), :ev, :l4, cast(:uid as uuid)) returning id"
        ),
        {
            "id": new_id,
            "pid": project_id,
            "n": data.name,
            "k": data.kind,
            "ev": encrypted,
            "l4": _last4(data.value),
            "uid": actor_id,
        },
    )
    if res.scalar_one_or_none() is None:  # pragma: no cover - RLS 違反は通常 raise
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="credential.create",
            target_type="project_credential",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={"project_id": project_id, "name": data.name, "kind": data.kind},
        )
    )
    return await get_credential(session, project_id=project_id, credential_id=new_id)


async def update_credential(
    session: AsyncSession,
    *,
    actor_id: str,
    project_id: str,
    credential_id: str,
    data: CredentialUpdate,
) -> CredentialResponse | None:
    """name / kind を更新 (value は変更しない)。"""
    sets: list[str] = []
    params: dict[str, object] = {"id": credential_id, "pid": project_id}
    if data.name is not None:
        sets.append("name = :n")
        params["n"] = data.name
    if data.kind is not None:
        sets.append("kind = cast(:k as credential_kind_enum)")
        params["k"] = data.kind
    if not sets:
        return await get_credential(session, project_id=project_id, credential_id=credential_id)
    sets.append("updated_at = now()")
    res = await session.execute(
        text(
            f"update public.project_credentials set {', '.join(sets)} "
            "where id = cast(:id as uuid) and project_id = cast(:pid as uuid) "
            "and deleted_at is null returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="credential.update",
            target_type="project_credential",
            actor_type="user",
            actor_id=actor_id,
            target_id=credential_id,
            after={"name": data.name, "kind": data.kind},
        )
    )
    return await get_credential(session, project_id=project_id, credential_id=credential_id)


async def delete_credential(
    session: AsyncSession, *, actor_id: str, project_id: str, credential_id: str
) -> bool:
    """soft delete。成功で True。"""
    res = await session.execute(
        text(
            "update public.project_credentials set deleted_at = now() "
            "where id = cast(:id as uuid) and project_id = cast(:pid as uuid) "
            "and deleted_at is null returning id"
        ),
        {"id": credential_id, "pid": project_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="credential.delete",
            target_type="project_credential",
            actor_type="user",
            actor_id=actor_id,
            target_id=credential_id,
        )
    )
    return True


async def reveal_credential(
    session: AsyncSession, *, actor_id: str, project_id: str, credential_id: str
) -> CredentialReveal | None:
    """plaintext を 1 度返す。RLS 通過 = 権限あり。必ず audit に記録する。"""
    res = await session.execute(
        text(
            "select id, name, encrypted_value from public.project_credentials "
            "where id = cast(:id as uuid) and project_id = cast(:pid as uuid) "
            "and deleted_at is null"
        ),
        {"id": credential_id, "pid": project_id},
    )
    row = res.first()
    if row is None:
        return None
    plaintext = decrypt_value(str(row.encrypted_value))
    # 誰がいつ復号したかを必ず記録 (平文は記録しない)
    await AuditWriter(session).write(
        AuditEvent(
            action="credential.reveal",
            target_type="project_credential",
            actor_type="user",
            actor_id=actor_id,
            target_id=credential_id,
            after={"project_id": project_id},
        )
    )
    return CredentialReveal(id=str(row.id), name=str(row.name), value=plaintext)
