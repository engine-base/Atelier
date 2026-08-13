"""Unit tests for apps/api/src/observability/sentry.py (T-F-08)."""

# pyright: reportPrivateUsage=false, reportUnusedFunction=false
from __future__ import annotations

import builtins
from dataclasses import FrozenInstanceError
from typing import Any, cast

import pytest
from sentry_sdk.types import Event, Hint

import src.observability.sentry as sentry_mod
from src.observability import SentryConfig, init_sentry, is_sentry_initialized
from src.observability.sentry import (
    _is_sensitive_header,
    _scrub_sensitive_fields,
)


@pytest.fixture(autouse=True)
def _reset_initialized() -> None:
    """各テスト前に _initialized フラグをリセット。"""
    sentry_mod._initialized = False


@pytest.mark.unit
class TestSentryConfig:
    def test_defaults(self) -> None:
        c = SentryConfig()
        assert c.dsn is None
        assert c.environment == "production"
        assert c.traces_sample_rate == 1.0
        assert c.profiles_sample_rate == 0.0
        assert c.send_default_pii is True

    def test_frozen(self) -> None:
        c = SentryConfig()
        with pytest.raises(FrozenInstanceError):
            c.environment = "preview"  # type: ignore[misc]

    def test_resolve_dsn_from_config(self) -> None:
        c = SentryConfig(dsn="https://x@y.ingest.de.sentry.io/1")
        assert c.resolve_dsn() == "https://x@y.ingest.de.sentry.io/1"

    def test_resolve_dsn_from_env(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("SENTRY_DSN", "https://env@y.ingest.de.sentry.io/2")
        c = SentryConfig()
        assert c.resolve_dsn() == "https://env@y.ingest.de.sentry.io/2"

    def test_resolve_dsn_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("SENTRY_DSN", raising=False)
        c = SentryConfig()
        assert c.resolve_dsn() is None


@pytest.mark.unit
class TestInitSentry:
    def test_returns_false_when_dsn_missing(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.delenv("SENTRY_DSN", raising=False)
        assert init_sentry() is False
        assert is_sentry_initialized() is False

    def test_returns_false_when_sdk_missing(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        real_import = builtins.__import__

        def fake_import(
            name: str,
            globals_: Any = None,
            locals_: Any = None,
            fromlist: Any = (),
            level: int = 0,
        ) -> Any:
            if name == "sentry_sdk" or name.startswith("sentry_sdk."):
                raise ImportError("not installed")
            return real_import(name, globals_, locals_, fromlist, level)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        c = SentryConfig(dsn="https://x@y.ingest.de.sentry.io/1")
        assert init_sentry(c) is False
        assert is_sentry_initialized() is False

    def test_idempotent_when_already_initialized(self) -> None:
        sentry_mod._initialized = True
        # SDK 無しでも True が返る (early return)
        assert init_sentry() is True
        assert is_sentry_initialized() is True


@pytest.mark.unit
class TestSensitiveHeader:
    @pytest.mark.parametrize(
        "name",
        [
            "Authorization",
            "authorization",
            "AUTHORIZATION",
            "Cookie",
            "Set-Cookie",
            "X-API-Key",
            "x-api-key",
            "X-Auth-Token",
            "X-Supabase-Auth",
        ],
    )
    def test_known_sensitive_headers(self, name: str) -> None:
        assert _is_sensitive_header(name) is True

    @pytest.mark.parametrize(
        "name",
        ["Content-Type", "User-Agent", "Accept", "x-trace-id"],
    )
    def test_safe_headers(self, name: str) -> None:
        assert _is_sensitive_header(name) is False

    def test_non_string(self) -> None:
        assert _is_sensitive_header(123) is False
        assert _is_sensitive_header(None) is False


def _event(payload: dict[str, Any]) -> Event:
    """テスト用イベントを SDK の実型 (Event) として組み立てる (T-F-45)。"""
    return cast("Event", payload)


def _hint() -> Hint:
    """before_send の第 2 引数。実型は Dict[str, Any] なので空 dict を渡す。"""
    return cast("Hint", {})


def _request(event: Event | None) -> Any:
    """Event の "request" は必須キーではないので .get() 経由で取り出す。"""
    assert event is not None
    return event.get("request")


@pytest.mark.unit
class TestScrubSensitiveFields:
    def test_scrubs_authorization_header(self) -> None:
        event: dict[str, Any] = {
            "request": {
                "headers": {
                    "Authorization": "Bearer secret",
                    "Content-Type": "application/json",
                },
            },
        }
        out = _scrub_sensitive_fields(_event(event), _hint())
        assert _request(out)["headers"]["Authorization"] == "[Filtered]"
        assert _request(out)["headers"]["Content-Type"] == "application/json"

    def test_scrubs_multiple_sensitive_headers(self) -> None:
        event: dict[str, Any] = {
            "request": {
                "headers": {
                    "Cookie": "session=abc",
                    "X-API-Key": "key123",
                    "Accept": "*/*",
                },
            },
        }
        out = _scrub_sensitive_fields(_event(event), _hint())
        assert _request(out)["headers"]["Cookie"] == "[Filtered]"
        assert _request(out)["headers"]["X-API-Key"] == "[Filtered]"
        assert _request(out)["headers"]["Accept"] == "*/*"

    def test_no_request_key(self) -> None:
        event: dict[str, Any] = {"level": "error"}
        out = _scrub_sensitive_fields(_event(event), _hint())
        assert out == {"level": "error"}

    def test_request_without_headers(self) -> None:
        event: dict[str, Any] = {"request": {"url": "https://example.com"}}
        out = _scrub_sensitive_fields(_event(event), _hint())
        assert _request(out) == {"url": "https://example.com"}

    def test_headers_not_dict(self) -> None:
        event: dict[str, Any] = {"request": {"headers": "not a dict"}}
        out = _scrub_sensitive_fields(_event(event), _hint())
        # 非 dict は touch しない
        assert _request(out)["headers"] == "not a dict"

    def test_request_not_dict(self) -> None:
        event: dict[str, Any] = {"request": "not a dict"}
        out = _scrub_sensitive_fields(_event(event), _hint())
        assert _request(out) == "not a dict"
