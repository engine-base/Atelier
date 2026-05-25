"""BYOK (Bring Your Own Key) — Supabase Vault による API キー暗号化保管層。

信頼源: 04_functional_breakdown/entities.json#E-022 (byok_api_keys、T-D-12 で live DB に配置):
  (id, user_id, provider, encrypted_key, key_label, is_active)

設計:
  - 鍵平文 (plaintext_key) は Supabase Vault (vault.create_secret /
    vault.decrypted_secrets) に暗号化保管する。
  - byok_api_keys.encrypted_key には Vault secret の id (uuid) のみを text で保持し、
    平文・暗号文そのものはアプリ DB の通常テーブルに置かない。

セキュリティ (R-T08 関連 / UNWANTED AC):
  - get_key は WHERE で user_id 一致を強制する。非所有者は 0 行 = 取得不可 (deny)。
  - byok_api_keys の RLS (T-D-20、user-scoped) と二重防御になる。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

BYOK_TABLE = "byok_api_keys"

Provider = Literal["claude", "openai", "gemini"]
_VALID_PROVIDERS: frozenset[str] = frozenset({"claude", "openai", "gemini"})


class ByokVaultError(RuntimeError):
    """BYOK / Vault 操作の基底例外。"""


class ByokPermissionError(ByokVaultError):
    """非所有者が他ユーザーの鍵へアクセスしようとした (deny)。"""


@dataclass(frozen=True)
class ByokKey:
    """byok_api_keys の 1 行 (平文鍵は含まない)。"""

    id: str
    user_id: str
    provider: str
    key_label: str | None
    is_active: bool


def _validate_provider(provider: str) -> Provider:
    if provider not in _VALID_PROVIDERS:
        raise ValueError(
            f"invalid provider {provider!r}: expected one of {sorted(_VALID_PROVIDERS)}"
        )
    return provider  # type: ignore[return-value]


class ByokVault:
    """byok_api_keys + Supabase Vault への暗号化保管 / 取得層。"""

    def __init__(self, session: AsyncSession, *, table: str = BYOK_TABLE) -> None:
        self._session = session
        self._table = table

    async def store_key(
        self,
        *,
        user_id: str,
        provider: str,
        plaintext_key: str,
        key_label: str | None = None,
    ) -> str:
        """平文鍵を Vault に暗号化保管し byok_api_keys に 1 行 INSERT する。

        Returns:
            生成された byok_api_keys.id (uuid string)。
        Raises:
            ValueError: provider が claude/openai/gemini 以外。
            ByokVaultError: Vault 保管または INSERT に失敗。
        """
        _validate_provider(provider)
        if not plaintext_key:
            raise ValueError("plaintext_key must not be empty")

        try:
            secret_res = await self._session.execute(
                text("SELECT vault.create_secret(:secret, :name, :description) AS id"),
                {
                    "secret": plaintext_key,
                    "name": None,
                    "description": f"byok:{provider}:{key_label or 'default'}",
                },
            )
            secret_id = secret_res.scalar_one()

            insert_res = await self._session.execute(
                text(
                    f"INSERT INTO {self._table} "
                    "(user_id, provider, encrypted_key, key_label, is_active) "
                    "VALUES (:user_id, :provider, :encrypted_key, :key_label, TRUE) "
                    "RETURNING id"
                ),
                {
                    "user_id": user_id,
                    "provider": provider,
                    "encrypted_key": str(secret_id),
                    "key_label": key_label,
                },
            )
            new_id = insert_res.scalar_one()
        except Exception as exc:
            raise ByokVaultError(f"failed to store BYOK key: {exc}") from exc
        return str(new_id)

    async def get_key(self, *, user_id: str, key_id: str) -> str | None:
        """所有者本人のみ復号鍵を取得する。

        非所有者・無効化済み・存在しない場合は None (deny)。
        WHERE 句で user_id 一致を強制するため、非所有者には 0 行しか返らない。
        """
        res = await self._session.execute(
            text(
                "SELECT ds.decrypted_secret AS secret "
                f"FROM {self._table} AS k "
                "JOIN vault.decrypted_secrets AS ds ON ds.id = k.encrypted_key::uuid "
                "WHERE k.id = :key_id AND k.user_id = :user_id AND k.is_active"
            ),
            {"key_id": key_id, "user_id": user_id},
        )
        secret = res.scalar_one_or_none()
        if secret is None:
            return None
        return str(secret)

    async def deactivate_key(self, *, user_id: str, key_id: str) -> bool:
        """所有者本人の鍵を is_active=false にする。成功 (1 行更新) で True。

        RETURNING id + scalar_one_or_none で更新有無を判定する
        (非所有者・無効化済みは 0 行 = None = False)。
        """
        res = await self._session.execute(
            text(
                f"UPDATE {self._table} SET is_active = FALSE "
                "WHERE id = :key_id AND user_id = :user_id AND is_active "
                "RETURNING id"
            ),
            {"key_id": key_id, "user_id": user_id},
        )
        return res.scalar_one_or_none() is not None

    async def list_keys(self, *, user_id: str) -> list[ByokKey]:
        """所有者本人の鍵一覧 (平文を含まない) を返す。"""
        res = await self._session.execute(
            text(
                "SELECT id, user_id, provider, key_label, is_active "
                f"FROM {self._table} WHERE user_id = :user_id "
                "ORDER BY provider"
            ),
            {"user_id": user_id},
        )
        return [
            ByokKey(
                id=str(row.id),
                user_id=str(row.user_id),
                provider=str(row.provider),
                key_label=(None if row.key_label is None else str(row.key_label)),
                is_active=bool(row.is_active),
            )
            for row in res.all()
        ]
