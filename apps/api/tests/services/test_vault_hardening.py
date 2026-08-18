"""GAP-131: Vault 強化 (MultiFernet ローテーション + reveal 再認証) の unit tests。

実 Postgres を要する列レベル revoke の検証は e2e (.qa/gap-131) が担当する。
"""

from __future__ import annotations

from typing import Any, ClassVar

import pytest
from cryptography.fernet import Fernet, MultiFernet

from src.services import project_credentials as svc
from src.services.project_credentials import reauth

KEY_A = Fernet.generate_key().decode("ascii")
KEY_B = Fernet.generate_key().decode("ascii")


@pytest.fixture(autouse=True)
def _reset_fernet_cache() -> Any:
    svc._fernet.cache_clear()  # pyright: ignore[reportPrivateUsage]
    reauth.clear()
    yield
    svc._fernet.cache_clear()  # pyright: ignore[reportPrivateUsage]
    reauth.clear()


# ---------------------------------------------------------------------------
# 鍵素材の読み取り
# ---------------------------------------------------------------------------


def test_key_material_prefers_multi_env() -> None:
    keys = svc.vault_key_material(
        {svc.KEYS_ENV: f" {KEY_A} , {KEY_B} ", svc.LEGACY_KEY_ENV: "ignored"}
    )
    assert keys == [KEY_A, KEY_B]


def test_key_material_falls_back_to_legacy() -> None:
    assert svc.vault_key_material({svc.LEGACY_KEY_ENV: KEY_A}) == [KEY_A]
    assert svc.vault_key_material({}) == []


# ---------------------------------------------------------------------------
# MultiFernet ローテーション (旧鍵の暗号文を新鍵設定で読める)
# ---------------------------------------------------------------------------


def test_old_ciphertext_decrypts_after_rotation_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """旧単鍵で暗号化した値が「新鍵,旧鍵」設定でも復号でき、新規は新鍵になる。"""
    # 旧構成 (単鍵 A) で暗号化
    monkeypatch.delenv(svc.KEYS_ENV, raising=False)
    monkeypatch.setenv(svc.LEGACY_KEY_ENV, KEY_A)
    old_token = svc.encrypt_value("秘密の値")
    # 新構成 (先頭 = 新鍵 B、旧鍵 A を残す)
    svc._fernet.cache_clear()  # pyright: ignore[reportPrivateUsage]
    monkeypatch.setenv(svc.KEYS_ENV, f"{KEY_B},{KEY_A}")
    assert svc.decrypt_value(old_token) == "秘密の値"
    # 新規暗号化は先頭鍵 B のみで復号できる (= B で暗号化されている)
    new_token = svc.encrypt_value("新しい値")
    assert Fernet(KEY_B.encode()).decrypt(new_token.encode()).decode() == "新しい値"
    with pytest.raises(Exception):  # noqa: B017 - A では開けない
        Fernet(KEY_A.encode()).decrypt(new_token.encode())


def test_rotate_reencrypts_to_primary_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """rotate_vault_key.py の中核: MultiFernet.rotate で旧鍵の行が新鍵になる。"""
    old_token = Fernet(KEY_A.encode()).encrypt("回す値".encode())
    mf = MultiFernet([Fernet(KEY_B.encode()), Fernet(KEY_A.encode())])
    new_token = mf.rotate(old_token)
    assert Fernet(KEY_B.encode()).decrypt(new_token).decode() == "回す値"


def test_missing_keys_raise_500(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(svc.KEYS_ENV, raising=False)
    monkeypatch.delenv(svc.LEGACY_KEY_ENV, raising=False)
    with pytest.raises(Exception):  # noqa: B017 - HTTPException(500)
        svc.encrypt_value("x")


# ---------------------------------------------------------------------------
# 再認証 TTL レジストリ
# ---------------------------------------------------------------------------


def test_reauth_ttl_lifecycle() -> None:
    assert reauth.is_valid("u1", now=1000.0) is False
    reauth.grant("u1", now=1000.0)
    ttl = reauth.reauth_ttl_seconds()
    assert reauth.is_valid("u1", now=1000.0 + ttl - 1) is True
    assert reauth.is_valid("u1", now=1000.0 + ttl + 1) is False  # 期限切れ + 掃除
    assert reauth.is_valid("u1", now=1000.0) is False  # 掃除済み


def test_reauth_ttl_env_override() -> None:
    assert reauth.reauth_ttl_seconds({reauth.TTL_ENV: "60"}) == 60.0
    for bad in ("abc", "0", "-1"):
        assert reauth.reauth_ttl_seconds({reauth.TTL_ENV: bad}) == reauth.DEFAULT_TTL_SECONDS


# ---------------------------------------------------------------------------
# _require_reauth フロー (DB 非依存 — audit/auth をフェイク)
# ---------------------------------------------------------------------------


class _FakeAuditWriter:
    events: ClassVar[list[Any]] = []

    def __init__(self, *_: Any) -> None: ...

    async def write(self, event: Any) -> None:
        _FakeAuditWriter.events.append(event)


@pytest.mark.asyncio
async def test_require_reauth_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi import HTTPException

    from src.services import auth as auth_svc

    _FakeAuditWriter.events = []
    monkeypatch.setattr(svc, "AuditWriter", _FakeAuditWriter)

    class _FakeSession:
        async def commit(self) -> None: ...

        async def __aenter__(self) -> Any:
            return self

        async def __aexit__(self, *args: Any) -> bool:
            return False

    # 失敗監査は service セッション経由 — DB 非依存テストではフェイクに差し替え
    monkeypatch.setattr(svc, "_service_session_factory", lambda: _FakeSession)

    async def _verify(*, user_id: str, password: str) -> bool:
        return password == "correct-pw"

    monkeypatch.setattr(auth_svc, "verify_reauth_password", _verify)

    # パスワード未入力 → 403 reauth_required
    with pytest.raises(HTTPException) as exc1:
        await svc._require_reauth(  # pyright: ignore[reportPrivateUsage]
            actor_id="u1", credential_id="c1", password=None
        )
    assert exc1.value.detail == "reauth_required"

    # 誤パスワード → 403 invalid_password + reveal_denied 監査
    with pytest.raises(HTTPException) as exc2:
        await svc._require_reauth(  # pyright: ignore[reportPrivateUsage]
            actor_id="u1", credential_id="c1", password="wrong"
        )
    assert exc2.value.detail == "invalid_password"
    assert any(e.action == "credential.reveal_denied" for e in _FakeAuditWriter.events)

    # 正パスワード → 通過 + TTL 付与 → 2 回目はパスワード不要
    await svc._require_reauth(  # pyright: ignore[reportPrivateUsage]
        actor_id="u1", credential_id="c1", password="correct-pw"
    )
    assert reauth.is_valid("u1") is True
    await svc._require_reauth(  # pyright: ignore[reportPrivateUsage]
        actor_id="u1", credential_id="c1", password=None
    )
