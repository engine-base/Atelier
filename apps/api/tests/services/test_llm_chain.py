"""GAP-138: 単発 LLM チェーン (relay → agent_sdk → API → fake) の unit tests。"""

from __future__ import annotations

import os
from typing import Any

import pytest

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from src.services.chat_sse import relay as sse_relay
from src.services.chat_sse.llm_chain import LLMUnavailable, llm_complete


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ATELIER_LLM_PROVIDER", raising=False)
    monkeypatch.delenv("ATELIER_CHAT_SUBSCRIPTION", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ATELIER_ALLOW_FAKE_LLM", raising=False)


@pytest.mark.asyncio
async def test_relay_success_returns_provider_relay(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATELIER_LLM_PROVIDER", "relay")

    async def _fake_relay(**kwargs: Any) -> Any:
        assert kwargs["thread_id"] is None  # システムジョブ (thread 無し) を許容
        yield "<html>"
        yield "ok</html>"

    monkeypatch.setattr(sse_relay, "relay_stream_chunks", _fake_relay)
    out, provider = await llm_complete(
        system_prompt="SYS", user_text="作って", actor_id="u1"
    )
    assert out == "<html>ok</html>"
    assert provider == "relay"


@pytest.mark.asyncio
async def test_relay_offline_is_honest_error_not_api_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Bridge オフラインは黙って API 課金に落とさず bridge_offline を上げる。"""
    monkeypatch.setenv("ATELIER_LLM_PROVIDER", "relay")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-should-not-be-used")

    async def _offline(**_kwargs: Any) -> Any:
        raise sse_relay.RelayUnavailable
        yield  # pragma: no cover

    monkeypatch.setattr(sse_relay, "relay_stream_chunks", _offline)
    with pytest.raises(LLMUnavailable) as exc:
        await llm_complete(system_prompt="SYS", user_text="作って", actor_id="u1")
    assert exc.value.code == "bridge_offline"


@pytest.mark.asyncio
async def test_fake_only_when_opted_in(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ATELIER_ALLOW_FAKE_LLM", "1")
    out, provider = await llm_complete(
        system_prompt="SYS", user_text="x", actor_id="u1", fake=lambda: "FAKE-HTML"
    )
    assert (out, provider) == ("FAKE-HTML", "fake")


@pytest.mark.asyncio
async def test_unconfigured_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(LLMUnavailable) as exc:
        await llm_complete(
            system_prompt="SYS", user_text="x", actor_id="u1", fake=lambda: "FAKE"
        )
    assert exc.value.code == "unconfigured"
