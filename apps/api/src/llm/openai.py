"""OpenAI GPT client (v2 用 placeholder)。

v1 (Phase 0-4) は Anthropic 専用。v2 で GPT/Gemini 追加時にここを実装する。
LLMClient Protocol 互換のシグネチャだけ先に固定しておく。
"""

from __future__ import annotations

from .client import LLMMessage, LLMResponse


class OpenAIClient:
    provider = "openai"

    def __init__(self) -> None:
        # v2 で OpenAI SDK の AsyncOpenAI() を初期化する。
        pass

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
        del model, messages, system, max_tokens, temperature, stop_sequences
        raise NotImplementedError("OpenAIClient is reserved for v2. Phase 0-4 uses Anthropic only.")
