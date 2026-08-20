"""プロジェクト・シークレットサービス層 (T-A-46 / GAP-131 強化)。

plaintext は Fernet で対称暗号化して `project_credentials.encrypted_value` に
urlsafe-base64 文字列で保存する。

鍵 (GAP-131: MultiFernet でローテーション可能):
- `ATELIER_VAULT_ENCRYPTION_KEYS` (カンマ区切り・複数可) を最優先。
  **先頭の鍵で暗号化**し、復号は全鍵で試す — 旧鍵で暗号化された既存行を
  読みながら新鍵へ移行できる。全行の再暗号化は
  `apps/api/scripts/rotate_vault_key.py` で行う。
- 未設定時は従来の `ATELIER_VAULT_ENCRYPTION_KEY` (単鍵) に後方互換で退避。
- どちらも無ければ HTTP 500 (黙って平文保存に落ちない)。

GAP-131 の防御層:
- encrypted_value は authenticated から列レベル revoke 済
  (gap-131_project_credentials_hardening.sql)。reveal だけが service
  セッション (role を下げない接続) で ciphertext を読む。
- reveal はパスワード再認証 (成功後 TTL の間は省略可) + レート制限 + 監査。

RLS は project の workspace member のみ可視/編集可能 (T-D-36)。状態変更 +
reveal はすべて audit_logs に記録する (誰がいつ復号したか)。
"""

from __future__ import annotations

import os
import uuid
from functools import lru_cache
from typing import Any

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from fastapi import HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.audit import AuditEvent, AuditWriter
from src.schemas.project_credentials import (
    CredentialCreate,
    CredentialResponse,
    CredentialReveal,
    CredentialUpdate,
)

KEYS_ENV = "ATELIER_VAULT_ENCRYPTION_KEYS"
LEGACY_KEY_ENV = "ATELIER_VAULT_ENCRYPTION_KEY"

_COLS = (
    "c.id, c.project_id, c.name, c.kind, c.last4, c.created_at, c.updated_at, "
    "u.display_name AS created_by_name"
)


def vault_key_material(env: dict[str, str] | None = None) -> list[str]:
    """鍵素材を env から読む (先頭 = 暗号化用)。テスト可能な純粋部分。"""
    e = env if env is not None else dict(os.environ)
    multi = (e.get(KEYS_ENV) or "").strip()
    if multi:
        return [k.strip() for k in multi.split(",") if k.strip()]
    legacy = (e.get(LEGACY_KEY_ENV) or "").strip()
    return [legacy] if legacy else []


@lru_cache(maxsize=1)
def _fernet() -> MultiFernet:
    """MultiFernet インスタンスを env から構築 (process 単位で 1 度)。

    encrypt は先頭鍵、decrypt は全鍵で試す (鍵ローテーションの移行期対応)。
    """
    keys = vault_key_material()
    if not keys:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "vault encryption key not configured"
        )
    try:
        return MultiFernet([Fernet(k.encode("ascii")) for k in keys])
    except (ValueError, TypeError) as exc:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "vault encryption key is invalid"
        ) from exc


def encrypt_value(plaintext: str) -> str:
    """plaintext → urlsafe-base64 文字列 (Fernet token、先頭鍵で暗号化)。"""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_value(ciphertext: str) -> str:
    """Fernet token → plaintext (全鍵で試行)。どの鍵でも開かない / 改竄は HTTP 500。"""
    try:
        return _fernet().decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except InvalidToken as exc:  # pragma: no cover - 鍵入替や改竄の防御
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "vault decryption failed"
        ) from exc


def _service_session_factory() -> async_sessionmaker[AsyncSession]:
    """GAP-197: engine はプロセスに 1 つ (loop ごとに作らない)。"""
    from src.db.session import shared_session_factory

    return shared_session_factory()


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


async def _require_reauth(*, actor_id: str, credential_id: str, password: str | None) -> None:
    """GAP-131: reveal のパスワード再認証。

    - 有効な再認証 (TTL 内) が残っていればパスワード不要。
    - 無ければ password 必須 — 現パスワードを照合し、成功で TTL 付与。
    - 失敗・未入力は 403 (detail はフロントが分岐する機械可読コード)。
      失敗は audit に credential.reveal_denied として記録する
      (セッション奪取での吸い出し試行を後から追える)。
    """
    from . import reauth

    if reauth.is_valid(actor_id):
        return
    if password is None or not password:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "reauth_required")
    from src.services import auth as auth_svc

    ok = await auth_svc.verify_reauth_password(user_id=actor_id, password=password)
    if not ok:
        # 403 で RLS セッションの txn は rollback されるため、失敗監査は
        # 独立した service セッションで確実に commit する (消えると
        # 総当たりの痕跡が残らない)。
        async with _service_session_factory()() as audit_session:
            await AuditWriter(audit_session).write(
                AuditEvent(
                    action="credential.reveal_denied",
                    target_type="project_credential",
                    actor_type="user",
                    actor_id=actor_id,
                    target_id=credential_id,
                    after={"reason": "invalid_password"},
                )
            )
            await audit_session.commit()
        raise HTTPException(status.HTTP_403_FORBIDDEN, "invalid_password")
    reauth.grant(actor_id)


async def reveal_credential(
    session: AsyncSession,
    *,
    actor_id: str,
    project_id: str,
    credential_id: str,
    password: str | None = None,
) -> CredentialReveal | None:
    """plaintext を 1 度返す。必ず audit に記録する。

    GAP-131 の 2 段構成:
      1. RLS セッションで可視性チェック (encrypted_value は列 revoke 済のため
         ここでは読まない/読めない)
      2. パスワード再認証 (TTL 内は省略可)
      3. service セッションで ciphertext を 1 行だけ取得して復号
    """
    res = await session.execute(
        text(
            "select id, name from public.project_credentials "
            "where id = cast(:id as uuid) and project_id = cast(:pid as uuid) "
            "and deleted_at is null"
        ),
        {"id": credential_id, "pid": project_id},
    )
    row = res.first()
    if row is None:
        return None
    await _require_reauth(actor_id=actor_id, credential_id=credential_id, password=password)
    async with _service_session_factory()() as svc_session:
        enc_res = await svc_session.execute(
            text(
                "select encrypted_value from public.project_credentials "
                "where id = cast(:id as uuid) and deleted_at is null"
            ),
            {"id": credential_id},
        )
        enc_row = enc_res.first()
    if enc_row is None:  # pragma: no cover - 可視チェック直後の競合削除のみ
        return None
    plaintext = decrypt_value(str(enc_row.encrypted_value))
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
