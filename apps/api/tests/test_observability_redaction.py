"""T-F-48: 秘匿値マスク語彙が全経路で統一されていることの検証 (GAP-116)。

語彙が経路ごとに散っていると、片方だけ塞がれた形が必ず生まれる。実際:
- T-F-39 初回実装では `Authorization: Bearer <JWT>` が Better Stack 経路で素通り
- `sentry.py` の旧 `_SENSITIVE_HEADER_KEYS` に `cookie` があるのに Better Stack 側の
  語彙には無い、という不揃いが残っていた

ここでは **1 つの入力表を Sentry 経路と Better Stack 経路の両方へ流し、
どちらも同じく秘匿値を通さない**ことを検証する (経路ごとの差を残さない)。
既存形式 (Bearer / 接続文字列 / sk-…) の退行も同じ表で見る。
"""

# pyright: reportPrivateUsage=false
from __future__ import annotations

import logging
from typing import Any, cast

import pytest
from sentry_sdk.types import Event, Hint

from src.observability.betterstack import BetterStackConfig, BetterStackHandler
from src.observability.redaction import (
    REDACTED,
    is_sensitive_header,
    redact_mapping,
    redact_text,
)
from src.observability.sentry import _scrub_sensitive_fields

# ─────────────────────────────────────────────────────────────────────────────
# 秘匿値の入力表。(説明, 本文, 漏れてはいけない材料)
# 前半 4 件が T-F-48 で新たに塞ぐ形、後半が既存形式 (退行検知用)。
# ─────────────────────────────────────────────────────────────────────────────
SECRET_CASES: tuple[tuple[str, str, str], ...] = (
    # --- T-F-48 で追加した 4 形式 ---
    ("Authorization: Basic", "Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNzd29yZA"),
    ("redis:// のユーザ名省略形", "cache redis://:onlypassword@cache:6379/0", "onlypassword"),
    ('JSON の "token": "…"', '{"token": "abc123secret"}', "abc123secret"),
    ("Set-Cookie", "Set-Cookie: session=sess-abc-123", "sess-abc-123"),
    # --- 既存形式 (退行検知) ---
    ("Authorization: Bearer", "call Authorization: Bearer eyJhbGciOi.JIUzI1", "eyJhbGciOi.JIUzI1"),
    ("Bearer 単体", "Bearer eyJhbGciOi.JIUzI1", "eyJhbGciOi.JIUzI1"),
    ("接続文字列", "db postgres://u:p4ssw0rd@h/db", "p4ssw0rd"),
    ("key=value", "api_key=sk-abcdefghijklmnop", "sk-abcdefghijklmnop"),
    ("password", "password=hunter2", "hunter2"),
    ("Stripe 鍵", "charge sk_live_ABCdef123456789", "sk_live_ABCdef123456789"),
)

SAFE_CASES: tuple[str, ...] = (
    "workspace created",
    "user session count is 42 items",
    "connected to postgres://localhost:5432/atelier_dev",
)


def _record(message: str) -> logging.LogRecord:
    return logging.LogRecord(
        name="test.logger",
        level=logging.ERROR,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=None,
        exc_info=None,
    )


class _CapturingHandler(BetterStackHandler):
    def __init__(self) -> None:
        super().__init__(BetterStackConfig(source_token="tok"))
        self.shipped: list[dict[str, Any]] = []

    def ship(self, payload: dict[str, Any]) -> bool:
        self.shipped.append(payload)
        return True


def _betterstack_output(message: str) -> str:
    """Better Stack 経路に 1 本流して、送出ペイロード全体を文字列で返す。"""
    handler = _CapturingHandler()
    handler.emit(_record(message))
    return str(handler.shipped[0])


def _sentry_output(message: str) -> str:
    """Sentry 経路 (before_send) に 1 件流して、加工後イベントを文字列で返す。"""
    event = cast("Event", {"message": message})
    out = _scrub_sensitive_fields(event, cast("Hint", {}))
    assert out is not None
    return str(out)


@pytest.mark.unit
class TestVocabularyIsShared:
    """Tier 1: 語彙が単一モジュールに集約され、両経路がそれを参照する。"""

    def test_betterstack_uses_the_shared_implementation(self) -> None:
        from src.observability import betterstack

        assert betterstack.redact_text is redact_text
        assert betterstack.redact_mapping is redact_mapping

    def test_sentry_uses_the_shared_header_vocabulary(self) -> None:
        from src.observability import sentry as sentry_mod

        assert sentry_mod._is_sensitive_header("Cookie") is is_sensitive_header("Cookie")
        assert sentry_mod._is_sensitive_header("Set-Cookie") is True

    def test_package_reexports_the_shared_api(self) -> None:
        from src.observability import redact_text as reexported

        assert reexported is redact_text


@pytest.mark.unit
class TestBothPathsRedactIdentically:
    """Tier 2 EVENT-DRIVEN / UNWANTED: 経路ごとに塞がれた形が違う状態を残さない。"""

    @pytest.mark.parametrize(("label", "message", "material"), SECRET_CASES)
    def test_betterstack_path(self, label: str, message: str, material: str) -> None:
        assert material not in _betterstack_output(message), label

    @pytest.mark.parametrize(("label", "message", "material"), SECRET_CASES)
    def test_sentry_path(self, label: str, message: str, material: str) -> None:
        assert material not in _sentry_output(message), label

    @pytest.mark.parametrize(("label", "message", "material"), SECRET_CASES)
    def test_neither_path_lets_a_form_through(
        self,
        label: str,
        message: str,
        material: str,
    ) -> None:
        """片方だけ通る形が 1 つでもあれば不合格。"""
        leaks = {
            "betterstack": material in _betterstack_output(message),
            "sentry": material in _sentry_output(message),
        }
        assert leaks == {"betterstack": False, "sentry": False}, f"{label}: {leaks}"


@pytest.mark.unit
class TestNoOverReaction:
    """UNWANTED: 誤検知で通常のログを壊さない。"""

    @pytest.mark.parametrize("message", SAFE_CASES)
    def test_safe_messages_are_untouched(self, message: str) -> None:
        assert redact_text(message) == message


@pytest.mark.unit
class TestSentryExceptionValuesAreRedacted:
    """ヘッダだけでなく例外メッセージ側も同じ語彙で伏せる。"""

    def test_exception_value_is_masked(self) -> None:
        event = cast(
            "Event",
            {
                "exception": {
                    "values": [
                        {"type": "ValueError", "value": "failed with api_key=sk-secretmaterial1"},
                    ],
                },
            },
        )

        out = _scrub_sensitive_fields(event, cast("Hint", {}))

        assert out is not None
        assert "sk-secretmaterial1" not in str(out)
        assert REDACTED in str(out)

    def test_headers_are_still_filtered(self) -> None:
        """既存のヘッダマスクを落としていない (退行検知)。"""
        event = cast(
            "Event",
            {"request": {"headers": {"Cookie": "session=abc", "Accept": "*/*"}}},
        )

        out = _scrub_sensitive_fields(event, cast("Hint", {}))

        assert out is not None
        request = cast("dict[str, Any]", out.get("request"))
        assert request["headers"]["Cookie"] == "[Filtered]"
        assert request["headers"]["Accept"] == "*/*"


@pytest.mark.unit
class TestMappingRedaction:
    def test_sensitive_keys_are_masked(self) -> None:
        out = redact_mapping(
            {
                "ANTHROPIC_API_KEY": "sk-realkeymaterial",
                "sessionId": "sess-abc",
                "user_id": "u1",
                "nested": {"authorization": "Bearer xyz", "ok": 1},
            },
        )

        assert out["ANTHROPIC_API_KEY"] == REDACTED
        assert out["sessionId"] == REDACTED
        assert out["user_id"] == "u1"
        assert out["nested"]["authorization"] == REDACTED
        assert out["nested"]["ok"] == 1
