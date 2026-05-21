"""Unit tests for apps/api/src/llm/client.py + llm/__init__.py.

LLMMessage / LLMUsage / LLMResponse / LLMClient Protocol / select_client。
Coverage target: >= 80% lines.
"""

from __future__ import annotations

import dataclasses

import pytest

from src.llm import (
    LLMClient,
    LLMMessage,
    LLMResponse,
    LLMUsage,
    select_client,
)


@pytest.mark.unit
class TestLLMMessage:
    def test_construction_and_fields(self) -> None:
        msg = LLMMessage(role="user", content="hi")
        assert msg.role == "user"
        assert msg.content == "hi"

    def test_frozen(self) -> None:
        msg = LLMMessage(role="assistant", content="ok")
        with pytest.raises(dataclasses.FrozenInstanceError):
            msg.content = "mutated"  # type: ignore[misc]


@pytest.mark.unit
class TestLLMUsage:
    def test_defaults_cache_fields_to_zero(self) -> None:
        u = LLMUsage(input_tokens=10, output_tokens=5)
        assert u.cache_read_tokens == 0
        assert u.cache_creation_tokens == 0

    def test_explicit_cache_fields(self) -> None:
        u = LLMUsage(
            input_tokens=10,
            output_tokens=5,
            cache_read_tokens=3,
            cache_creation_tokens=2,
        )
        assert u.cache_read_tokens == 3
        assert u.cache_creation_tokens == 2


@pytest.mark.unit
class TestLLMResponse:
    def test_construction(self) -> None:
        usage = LLMUsage(input_tokens=1, output_tokens=2)
        resp = LLMResponse(
            text="hi", model="claude-x", stop_reason="end_turn", usage=usage, raw=None
        )
        assert resp.text == "hi"
        assert resp.model == "claude-x"
        assert resp.stop_reason == "end_turn"
        assert resp.usage is usage


@pytest.mark.unit
class TestSelectClient:
    def test_anthropic_alias(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # AsyncAnthropic を mock して SDK 未 install でも構成できるようにする
        import sys
        import types

        fake_module = types.ModuleType("anthropic")

        class _FakeAsyncAnthropic:
            def __init__(self, *args: object, **kwargs: object) -> None:
                pass

        fake_module.AsyncAnthropic = _FakeAsyncAnthropic  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "anthropic", fake_module)

        client_a = select_client("anthropic")
        client_b = select_client("Claude")
        assert client_a.provider == "anthropic"
        assert client_b.provider == "anthropic"

    def test_openai_alias_returns_placeholder(self) -> None:
        client = select_client("openai")
        assert client.provider == "openai"
        client_gpt = select_client("GPT")
        assert client_gpt.provider == "openai"

    def test_unknown_provider_raises(self) -> None:
        with pytest.raises(ValueError, match="unsupported"):
            select_client("mistral")


@pytest.mark.unit
class TestLLMClientProtocol:
    def test_runtime_checkable_against_compliant_object(self) -> None:
        class GoodClient:
            provider = "fake"

            async def complete(
                self,
                *,
                model: str,
                messages: list[LLMMessage],
                system: str | None = None,
                max_tokens: int = 4096,
                temperature: float = 1.0,
                stop_sequences: list[str] | None = None,
            ) -> LLMResponse:
                del messages, system, max_tokens, temperature, stop_sequences
                return LLMResponse(
                    text="ok",
                    model=model,
                    stop_reason=None,
                    usage=LLMUsage(input_tokens=0, output_tokens=0),
                    raw=None,
                )

        assert isinstance(GoodClient(), LLMClient)
