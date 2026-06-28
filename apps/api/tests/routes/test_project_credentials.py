"""プロジェクト金庫 (T-A-46) のユニットテスト。

暗号化往復・last4 マスク・スキーマの平文非含有を検証する。実 Postgres を
要する RLS 越境試験は tests/rls/t-d-36_vault.py が担当する。
"""

from __future__ import annotations

import os

import pytest
from cryptography.fernet import Fernet

# サービス層が import 時に env を読まないよう、先に鍵を用意する。
os.environ.setdefault("ATELIER_VAULT_ENCRYPTION_KEY", Fernet.generate_key().decode("ascii"))

from src.schemas.project_credentials import (
    CredentialResponse,
    CredentialReveal,
)
from src.services import project_credentials as svc


def test_encrypt_decrypt_roundtrip() -> None:
    """暗号化 → 復号で元の平文に戻り、ciphertext は平文と異なる。"""
    plain = "ghp_SuperSecret_0123456789"
    ct = svc.encrypt_value(plain)
    assert ct != plain
    assert not ct.startswith("ghp_")  # 平文が露出していない
    assert svc.decrypt_value(ct) == plain


def test_last4_helper() -> None:
    last4 = svc._last4  # pyright: ignore[reportPrivateUsage]
    assert last4("abcdefgh") == "efgh"
    assert last4("ab") == "ab"  # 4 文字未満はそのまま


def test_response_schema_has_no_plaintext() -> None:
    """一覧/詳細応答スキーマに plaintext/encrypted フィールドが無い。"""
    fields = set(CredentialResponse.model_fields.keys())
    assert "value" not in fields
    assert "encrypted_value" not in fields
    # マスク用の last4 とメタ情報のみ
    assert {"id", "project_id", "name", "kind", "last4"}.issubset(fields)


def test_reveal_schema_returns_value() -> None:
    """reveal 応答のみ plaintext value を持つ。"""
    assert "value" in CredentialReveal.model_fields


def test_missing_key_raises() -> None:
    """暗号鍵が未設定なら 500 を投げる (鍵キャッシュをクリアして検証)。"""
    svc._fernet.cache_clear()  # pyright: ignore[reportPrivateUsage]
    saved = os.environ.pop("ATELIER_VAULT_ENCRYPTION_KEY", None)
    try:
        with pytest.raises(Exception):  # noqa: B017 - HTTPException(500)
            svc.encrypt_value("x")
    finally:
        if saved is not None:
            os.environ["ATELIER_VAULT_ENCRYPTION_KEY"] = saved
        svc._fernet.cache_clear()  # pyright: ignore[reportPrivateUsage]
