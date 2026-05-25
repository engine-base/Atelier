"""Unit tests for apps/api/src/vault/byok.py (T-F-19, E-022 byok_api_keys)。

Supabase Vault (vault.create_secret / vault.decrypted_secrets) は AsyncSession の
execute をモックして検証する (live Vault 不要)。
"""

from __future__ import annotations

import dataclasses
from collections.abc import Sequence
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from src.vault import ByokKey, ByokPermissionError, ByokVault, ByokVaultError


def _exec_result(
    *,
    scalar_one: object = None,
    scalar_one_or_none: object = None,
    rows: Sequence[object] | None = None,
) -> MagicMock:
    r = MagicMock()
    r.scalar_one.return_value = scalar_one
    r.scalar_one_or_none.return_value = scalar_one_or_none
    r.all.return_value = list(rows or [])
    return r


@pytest.mark.unit
class TestByokKey:
    def test_dataclass_frozen(self) -> None:
        k = ByokKey(id="k1", user_id="u1", provider="claude", key_label="prod", is_active=True)
        assert k.provider == "claude"
        with pytest.raises(dataclasses.FrozenInstanceError):
            k.provider = "openai"  # type: ignore[misc]

    def test_permission_error_is_vault_error(self) -> None:
        assert issubclass(ByokPermissionError, ByokVaultError)


@pytest.mark.unit
class TestStoreKey:
    @pytest.mark.asyncio
    async def test_store_success_returns_new_id(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock(
            side_effect=[
                _exec_result(scalar_one="11111111-1111-1111-1111-111111111111"),
                _exec_result(scalar_one="22222222-2222-2222-2222-222222222222"),
            ]
        )
        vault = ByokVault(session)
        new_id = await vault.store_key(
            user_id="u1", provider="openai", plaintext_key="sk-secret", key_label="prod"
        )
        assert new_id == "22222222-2222-2222-2222-222222222222"
        assert session.execute.await_count == 2

    @pytest.mark.asyncio
    async def test_invalid_provider_raises_valueerror(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock()
        vault = ByokVault(session)
        with pytest.raises(ValueError, match="invalid provider"):
            await vault.store_key(user_id="u1", provider="grok", plaintext_key="x")
        session.execute.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_empty_key_raises_valueerror(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock()
        vault = ByokVault(session)
        with pytest.raises(ValueError, match="must not be empty"):
            await vault.store_key(user_id="u1", provider="claude", plaintext_key="")

    @pytest.mark.asyncio
    async def test_vault_failure_wrapped_in_byok_error(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock(side_effect=RuntimeError("vault down"))
        vault = ByokVault(session)
        with pytest.raises(ByokVaultError, match="failed to store BYOK key"):
            await vault.store_key(user_id="u1", provider="gemini", plaintext_key="k")


@pytest.mark.unit
class TestGetKey:
    @pytest.mark.asyncio
    async def test_owner_gets_decrypted_secret(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock(return_value=_exec_result(scalar_one_or_none="sk-plain"))
        vault = ByokVault(session)
        assert await vault.get_key(user_id="u1", key_id="k1") == "sk-plain"

    @pytest.mark.asyncio
    async def test_non_owner_or_missing_returns_none(self) -> None:
        # WHERE user_id 一致を強制するため非所有者には 0 行 = None (deny)
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock(return_value=_exec_result(scalar_one_or_none=None))
        vault = ByokVault(session)
        assert await vault.get_key(user_id="attacker", key_id="k1") is None


@pytest.mark.unit
class TestDeactivateKey:
    @pytest.mark.asyncio
    async def test_deactivate_owner_returns_true(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock(return_value=_exec_result(scalar_one_or_none="k1"))
        vault = ByokVault(session)
        assert await vault.deactivate_key(user_id="u1", key_id="k1") is True

    @pytest.mark.asyncio
    async def test_deactivate_non_owner_returns_false(self) -> None:
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock(return_value=_exec_result(scalar_one_or_none=None))
        vault = ByokVault(session)
        assert await vault.deactivate_key(user_id="attacker", key_id="k1") is False


@pytest.mark.unit
class TestListKeys:
    @pytest.mark.asyncio
    async def test_list_maps_rows_to_byokkey(self) -> None:
        rows = [
            SimpleNamespace(
                id="k1", user_id="u1", provider="claude", key_label="prod", is_active=True
            ),
            SimpleNamespace(
                id="k2", user_id="u1", provider="openai", key_label=None, is_active=False
            ),
        ]
        session = MagicMock(spec=AsyncSession)
        session.execute = AsyncMock(return_value=_exec_result(rows=rows))
        vault = ByokVault(session)
        keys = await vault.list_keys(user_id="u1")
        assert [k.provider for k in keys] == ["claude", "openai"]
        assert keys[1].key_label is None
        assert keys[1].is_active is False
