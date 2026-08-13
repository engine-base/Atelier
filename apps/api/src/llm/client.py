"""LLMClient Protocol + 共通型 + Langfuse トレース配線 (T-F-38)。"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Literal, Protocol, runtime_checkable

from src.observability.langfuse import LangfuseClient, LLMTrace, get_langfuse_client

logger = logging.getLogger(__name__)

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


class TracedLLMClient:
    """LLMClient を Langfuse トレース付きで包む decorator (T-F-38)。

    `select_client()` が返す唯一の型。ここが **実 LLM 呼び出し経路からの
    トレース発行点**であり、「client を定義したが誰も呼ばない」状態を作らない。

    トレース送信の成否は業務処理に一切影響しない:
    - Langfuse 未設定 → `LangfuseClient.trace()` が no-op + warning
    - 送信失敗 / タイムアウト → 内部で握り潰し
    - tracer 自体が壊れていても、ここで捕捉して応答をそのまま返す
    """

    def __init__(self, inner: LLMClient, tracer: LangfuseClient | None = None) -> None:
        self._inner = inner
        self._tracer = tracer if tracer is not None else get_langfuse_client()
        # Protocol の `provider: str` を満たすため plain attribute として持つ。
        self.provider: str = inner.provider

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
        started = time.perf_counter()
        response = await self._inner.complete(
            model=model,
            messages=messages,
            system=system,
            max_tokens=max_tokens,
            temperature=temperature,
            stop_sequences=stop_sequences,
        )
        latency_ms = (time.perf_counter() - started) * 1000.0
        await self._emit_trace(response, latency_ms)
        return response

    async def _emit_trace(self, response: LLMResponse, latency_ms: float) -> None:
        """トレースを送る。**いかなる失敗も呼び出し元へ伝播させない。**"""
        try:
            await self._tracer.trace(
                LLMTrace(
                    provider=self.provider,
                    model=response.model,
                    latency_ms=latency_ms,
                    input_tokens=response.usage.input_tokens,
                    output_tokens=response.usage.output_tokens,
                ),
            )
        except Exception:
            logger.warning("langfuse tracing failed; LLM response is unaffected", exc_info=True)


def select_client(provider: str) -> LLMClient:
    """環境変数や config から provider を選択して LLMClient を返す。

    Phase 0 では Anthropic のみ。OpenAI は v2 で有効化。
    返り値は常に `TracedLLMClient` で包まれ、完了ごとに Langfuse へ
    model / latency / token usage のトレースを発行する (T-F-38)。
    """
    match provider.lower():
        case "anthropic" | "claude":
            from .anthropic import AnthropicClient

            return TracedLLMClient(AnthropicClient())
        case "openai" | "gpt":
            from .openai import OpenAIClient

            return TracedLLMClient(OpenAIClient())
        case _:
            raise ValueError(f"unsupported LLM provider: {provider}")
