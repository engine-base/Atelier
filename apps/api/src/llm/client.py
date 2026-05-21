"""LLMClient Protocol + 共通型。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, runtime_checkable

LLMRole = Literal["system", "user", "assistant", "tool"]


@dataclass(frozen=True)
class LLMMessage:
    role: LLMRole
    content: str


@dataclass(frozen=True)
class LLMUsage:
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0


@dataclass(frozen=True)
class LLMResponse:
    text: str
    model: str
    stop_reason: str | None
    usage: LLMUsage
    raw: object  # provider 固有 response (debugging / Langfuse 用)


@runtime_checkable
class LLMClient(Protocol):
    """provider-agnostic な LLM client 契約。"""

    provider: str

    async def complete(
        self,
        *,
        model: str,
        messages: list[LLMMessage],
        system: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 1.0,
        stop_sequences: list[str] | None = None,
    ) -> LLMResponse: ...


def select_client(provider: str) -> LLMClient:
    """環境変数や config から provider を選択して LLMClient を返す。

    Phase 0 では Anthropic のみ。OpenAI は v2 で有効化。
    """
    match provider.lower():
        case "anthropic" | "claude":
            from .anthropic import AnthropicClient

            return AnthropicClient()
        case "openai" | "gpt":
            from .openai import OpenAIClient

            return OpenAIClient()
        case _:
            raise ValueError(f"unsupported LLM provider: {provider}")
