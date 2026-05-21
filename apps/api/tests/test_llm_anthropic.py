"""Unit tests for apps/api/src/llm/anthropic.py.

AnthropicClient.complete を AsyncAnthropic を mock した状態で検証。
SDK が install 済みでも未 install でも動くよう sys.modules を差し替える。

Coverage target: >= 80%.
"""

from __future__ import annotations

import sys
import types
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.llm import LLMMessage


def _install_fake_anthropic(monkeypatch: pytest.MonkeyPatch, response: Any) -> MagicMock:
    fake_module = types.ModuleType("anthropic")
    sdk_instance = MagicMock()
    sdk_instance.messages = MagicMock()
    sdk_instance.messages.create = AsyncMock(return_value=response)

    class _FakeAsyncAnthropic:
        def __init__(self, *args: object, **kwargs: object) -> None:
            self._args = args
            self._kwargs = kwargs

        def __new__(cls, *args: object, **kwargs: object) -> Any:
            return sdk_instance

    fake_module.AsyncAnthropic = _FakeAsyncAnthropic  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "anthropic", fake_module)
    return sdk_instance


def _build_fake_response() -> MagicMock:
    text_block = MagicMock()
    text_block.type = "text"
    text_block.text = "Hello!"
    other_block = MagicMock()
    other_block.type = "tool_use"
    other_block.text = "should be ignored"

    usage = MagicMock()
    usage.input_tokens = 11
    usage.output_tokens = 7
    usage.cache_read_input_tokens = 4
    usage.cache_creation_input_tokens = 0

    response = MagicMock()
    response.content = [text_block, other_block]
    response.model = "claude-sonnet-4-6"
    response.stop_reason = "end_turn"
    response.usage = usage
    return response


@pytest.mark.unit
class TestAnthropicClient:
    @pytest.mark.asyncio
    async def test_complete_returns_normalized_response(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        fake_response = _build_fake_response()
        sdk = _install_fake_anthropic(monkeypatch, fake_response)

        from src.llm.anthropic import AnthropicClient

        client = AnthropicClient(api_key="test-key")
        result = await client.complete(
            model="claude-sonnet-4-6",
            messages=[
                LLMMessage(role="user", content="hi"),
                LLMMessage(role="assistant", content="hello"),
                LLMMessage(role="system", content="ignored at message level"),
            ],
            system="You are helpful.",
            max_tokens=128,
            temperature=0.2,
            stop_sequences=["STOP"],
        )

        assert result.text == "Hello!"
        assert result.model == "claude-sonnet-4-6"
        assert result.stop_reason == "end_turn"
        assert result.usage.input_tokens == 11
        assert result.usage.output_tokens == 7
        assert result.usage.cache_read_tokens == 4
        assert result.usage.cache_creation_tokens == 0

        sdk.messages.create.assert_awaited_once()
        kwargs = sdk.messages.create.await_args.kwargs
        assert kwargs["model"] == "claude-sonnet-4-6"
        # system role message は messages に含まれない
        assert all(m["role"] in ("user", "assistant") for m in kwargs["messages"])
        assert kwargs["system"] == "You are helpful."
        assert kwargs["max_tokens"] == 128
        assert kwargs["temperature"] == 0.2
        assert kwargs["stop_sequences"] == ["STOP"]

    @pytest.mark.asyncio
    async def test_complete_omits_optional_kwargs(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fake_response = _build_fake_response()
        sdk = _install_fake_anthropic(monkeypatch, fake_response)

        from src.llm.anthropic import AnthropicClient

        client = AnthropicClient(api_key="x")
        await client.complete(
            model="claude-sonnet-4-6",
            messages=[LLMMessage(role="user", content="hi")],
        )
        kwargs = sdk.messages.create.await_args.kwargs
        assert "system" not in kwargs
        assert "stop_sequences" not in kwargs

    def test_provider_name(self, monkeypatch: pytest.MonkeyPatch) -> None:
        _install_fake_anthropic(monkeypatch, _build_fake_response())
        from src.llm.anthropic import AnthropicClient

        client = AnthropicClient(api_key="x")
        assert client.provider == "anthropic"

    def test_uses_env_var_when_no_api_key(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "from-env")
        _install_fake_anthropic(monkeypatch, _build_fake_response())
        from src.llm.anthropic import AnthropicClient

        # 例外なく構築できれば OK
        client = AnthropicClient()
        assert client.provider == "anthropic"
