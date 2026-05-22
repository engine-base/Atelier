"""Unit tests for apps/api/src/email/sender.py.

ResendSender を httpx mock で検証。AsyncClient の interaction を確認。
Coverage target: >= 80%.
"""

from __future__ import annotations

from typing import Any

import pytest

from src.email import EmailMessage, EmailSendResult, EmailSettings, ResendSender


@pytest.mark.unit
class TestEmailSettings:
    def test_defaults(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("ATELIER_EMAIL_API_KEY", raising=False)
        monkeypatch.delenv("ATELIER_EMAIL_FROM_ADDRESS", raising=False)
        monkeypatch.delenv("ATELIER_EMAIL_DRY_RUN", raising=False)
        cfg = EmailSettings()
        assert cfg.api_key == ""
        assert cfg.from_address == "Atelier <noreply@atelier.local>"
        assert cfg.dry_run is False
        assert cfg.request_timeout_seconds == 10.0

    def test_overrides_via_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ATELIER_EMAIL_API_KEY", "re_xxx")
        monkeypatch.setenv("ATELIER_EMAIL_DRY_RUN", "true")
        cfg = EmailSettings()
        assert cfg.api_key == "re_xxx"
        assert cfg.dry_run is True


@pytest.mark.unit
class TestEmailMessage:
    def test_message_is_frozen_dataclass(self) -> None:
        import dataclasses

        msg = EmailMessage(to=("a@example.com",), subject="hi", html="<p>hi</p>")
        assert msg.to == ("a@example.com",)
        with pytest.raises(dataclasses.FrozenInstanceError):
            msg.subject = "x"  # type: ignore[misc]


@pytest.mark.unit
class TestResendSenderDryRun:
    @pytest.mark.asyncio
    async def test_dry_run_flag_skips_http_call(self) -> None:
        cfg = EmailSettings(api_key="re_xxx", dry_run=True)  # type: ignore[call-arg]
        sender = ResendSender(cfg)
        msg = EmailMessage(to=("a@b.c",), subject="s", html="<p>h</p>")
        result = await sender.send(msg)
        assert isinstance(result, EmailSendResult)
        assert result.dry_run is True
        assert result.id == "dry-run"

    @pytest.mark.asyncio
    async def test_empty_api_key_falls_back_to_dry_run(self) -> None:
        cfg = EmailSettings(api_key="", dry_run=False)  # type: ignore[call-arg]
        sender = ResendSender(cfg)
        msg = EmailMessage(to=("a@b.c",), subject="s", html="<p>h</p>")
        result = await sender.send(msg)
        assert result.dry_run is True


@pytest.mark.unit
class TestResendSenderHttp:
    @pytest.mark.asyncio
    async def test_full_payload_posted(self, monkeypatch: pytest.MonkeyPatch) -> None:
        captured: dict[str, Any] = {}

        class FakeResponse:
            def raise_for_status(self) -> None:
                pass

            def json(self) -> dict[str, str]:
                return {"id": "msg_123"}

        class FakeClient:
            def __init__(self, *args: object, **kwargs: object) -> None:
                self._args = args
                self._kwargs = kwargs

            async def __aenter__(self) -> FakeClient:
                return self

            async def __aexit__(self, *args: object) -> None:
                return None

            async def post(self, url: str, **kwargs: Any) -> FakeResponse:
                captured["url"] = url
                captured["kwargs"] = kwargs
                return FakeResponse()

        import src.email.sender as sender_mod

        monkeypatch.setattr(sender_mod.httpx, "AsyncClient", FakeClient)

        cfg = EmailSettings(api_key="re_real", dry_run=False)  # type: ignore[call-arg]
        sender = ResendSender(cfg)
        msg = EmailMessage(
            to=("a@b.c", "x@y.z"),
            subject="Hello",
            html="<p>hi</p>",
            text="hi",
            reply_to="reply@example.com",
            tags=(("campaign", "welcome"), ("env", "test")),
        )
        result = await sender.send(msg)
        assert result.id == "msg_123"
        assert result.dry_run is False

        assert captured["url"].endswith("/emails")
        payload = captured["kwargs"]["json"]
        assert payload["from"] == cfg.from_address
        assert payload["to"] == ["a@b.c", "x@y.z"]
        assert payload["subject"] == "Hello"
        assert payload["html"] == "<p>hi</p>"
        assert payload["text"] == "hi"
        assert payload["reply_to"] == "reply@example.com"
        assert payload["tags"] == [
            {"name": "campaign", "value": "welcome"},
            {"name": "env", "value": "test"},
        ]
        headers = captured["kwargs"]["headers"]
        assert headers["Authorization"] == "Bearer re_real"

    @pytest.mark.asyncio
    async def test_propagates_http_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        class FailingResponse:
            def raise_for_status(self) -> None:
                raise RuntimeError("HTTP 500")

            def json(self) -> dict[str, str]:
                return {}

        class FakeClient:
            def __init__(self, *args: object, **kwargs: object) -> None:
                pass

            async def __aenter__(self) -> FakeClient:
                return self

            async def __aexit__(self, *args: object) -> None:
                return None

            async def post(self, url: str, **kwargs: Any) -> FailingResponse:
                return FailingResponse()

        import src.email.sender as sender_mod

        monkeypatch.setattr(sender_mod.httpx, "AsyncClient", FakeClient)
        cfg = EmailSettings(api_key="re_real", dry_run=False)  # type: ignore[call-arg]
        sender = ResendSender(cfg)
        with pytest.raises(RuntimeError, match="HTTP 500"):
            await sender.send(EmailMessage(to=("a@b.c",), subject="s", html="<p>h</p>"))
