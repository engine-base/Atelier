"""GAP-182: 自前エラーログの unit tests (秘匿値マスク + 同種のまとめ)。

外部 SaaS に送らない代わりに、**保存する内容が安全であること**を固定する。
"""

from __future__ import annotations

import os

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from src.observability.errors import fingerprint, redact


class TestRedact:
    def test_bearer_token_is_masked(self) -> None:
        out = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature")
        assert "eyJhbGciOiJIUzI1NiJ9" not in (out or "")
        assert "[FILTERED" in (out or "")

    def test_api_keys_are_masked(self) -> None:
        out = redact("key=sk-abcdefghijklmnop failed") or ""
        assert "sk-abcdefghijklmnop" not in out

    def test_database_url_is_masked(self) -> None:
        out = redact("postgresql+asyncpg://user:secretpw@db.example.com:5432/atelier") or ""
        assert "secretpw" not in out
        assert out.startswith("postgresql+asyncpg://")

    def test_password_assignment_is_masked(self) -> None:
        out = redact('{"password": "hunter2", "user": "a@b.com"}') or ""
        assert "hunter2" not in out
        assert "a@b.com" in out  # 秘匿値以外は残す (調査できないと意味がない)

    def test_plain_message_is_untouched(self) -> None:
        assert redact("division by zero") == "division by zero"

    def test_none_passthrough(self) -> None:
        assert redact(None) is None


class TestFingerprint:
    def test_same_error_same_fingerprint(self) -> None:
        a = fingerprint(source="api", kind="ValueError", path="/x", stack='File "a.py", line 1')
        b = fingerprint(source="api", kind="ValueError", path="/x", stack='File "a.py", line 1')
        assert a == b

    def test_different_path_differs(self) -> None:
        a = fingerprint(source="api", kind="ValueError", path="/x", stack=None)
        b = fingerprint(source="api", kind="ValueError", path="/y", stack=None)
        assert a != b

    def test_stable_length(self) -> None:
        fp = fingerprint(source="web", kind="TypeError", path=None, stack=None)
        assert len(fp) == 16
