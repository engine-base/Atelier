"""Anthropic Claude client。

公式 anthropic SDK + Claude Agent SDK を直叩き。
- Prompt Caching / Batch API / web_search / Tool Use は T-F-15 / T-F-21 で配線。
- AI 学習デフォルト OFF を BYOK 経由で維持。
- BYOK 秘匿情報は Supabase Vault 経由 (T-F-19)。ここでは環境変数を読むだけ。
"""

from __future__ import annotations

import os
from typing import Any, cast

from .client import LLMMessage, LLMResponse, LLMUsage

DEFAULT_MODEL = "claude-sonnet-4-6"


class AnthropicClient:
    provider = "anthropic"

    def __init__(
        self,
        *,
        api_key: str | None = None,
        default_model: str = DEFAULT_MODEL,
    ) -> None:
        # AsyncAnthropic は依存に含まれない場合があるため遅延 import。
        # (T-F-15 で anthropic[bedrock-extras] 等を追加する想定)
        from anthropic import AsyncAnthropic  # type: ignore[import-not-found]

        self._sdk = AsyncAnthropic(
            api_key=api_key or os.environ.get("ANTHROPIC_API_KEY"),
        )
        self._default_model = default_model

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
        chat_messages = [
            {"role": msg.role, "content": msg.content}
            for msg in messages
            if msg.role in ("user", "assistant")
        ]

        kwargs: dict[str, Any] = {
            "model": model or self._default_model,
            "messages": chat_messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if system is not None:
            kwargs["system"] = system
        if stop_sequences:
            kwargs["stop_sequences"] = stop_sequences

        response = await self._sdk.messages.create(**kwargs)

        text_blocks = [
            cast(Any, block).text
            for block in response.content
            if getattr(block, "type", None) == "text"
        ]
        text = "".join(text_blocks)

        usage_obj = response.usage
        usage = LLMUsage(
            input_tokens=usage_obj.input_tokens,
            output_tokens=usage_obj.output_tokens,
            cache_read_tokens=getattr(usage_obj, "cache_read_input_tokens", 0) or 0,
            cache_creation_tokens=getattr(usage_obj, "cache_creation_input_tokens", 0) or 0,
        )

        return LLMResponse(
            text=text,
            model=response.model,
            stop_reason=response.stop_reason,
            usage=usage,
            raw=response,
        )
