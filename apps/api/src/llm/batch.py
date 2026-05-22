# pyright: reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportArgumentType=false
"""Anthropic Message Batches API ラッパ (T-F-15)。

Batch API は 50% 課金減 + 24h 以内に結果返却。非同期 fan-out (日次ダイジェスト /
週次バーンダウン / RAG re-rank 等) で利用する。

参照:
- https://docs.claude.com/en/docs/build-with-claude/batch-processing
- SDK: anthropic.messages.batches.create / retrieve / results

設計方針:
- pure DTO + 薄い SDK wrapper。SDK 呼び出しは遅延 import。
- BatchRequest は frozen dataclass。SDK 用 dict に to_sdk_dict() で変換。
- 結果取得は AsyncIterator で stream。
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from .client import LLMMessage

BatchStatus = Literal[
    "in_progress",
    "canceling",
    "ended",
]
"""Anthropic Batch ライフサイクル状態。"""


@dataclass(frozen=True)
class BatchRequest:
    """1 件分の Batch リクエスト。

    Anthropic SDK の MessageBatchRequest 形式に整形する DTO。
    custom_id で呼び出し側が結果を相関付ける。
    """

    custom_id: str
    """呼び出し側が指定する識別子。結果と相関付けるための一意キー。"""

    model: str
    messages: Sequence[LLMMessage]
    system: str | None = None
    max_tokens: int = 4096
    temperature: float = 1.0
    metadata: dict[str, str] = field(default_factory=lambda: dict[str, str]())

    def __post_init__(self) -> None:
        if not self.custom_id:
            raise ValueError("custom_id must be non-empty")
        if self.max_tokens < 1:
            raise ValueError(f"max_tokens must be >= 1, got {self.max_tokens}")

    def to_sdk_dict(self) -> dict[str, Any]:
        """anthropic SDK の `requests=[{custom_id, params}]` 形式に変換する。"""
        params: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "messages": [
                {"role": m.role, "content": m.content}
                for m in self.messages
                if m.role in ("user", "assistant")
            ],
        }
        if self.system is not None:
            params["system"] = self.system
        if self.metadata:
            params["metadata"] = dict(self.metadata)
        return {"custom_id": self.custom_id, "params": params}


@dataclass(frozen=True)
class BatchHandle:
    """submit_batch の戻り値。Anthropic 側 batch_id とプロバイダ識別子を保持。"""

    batch_id: str
    provider: Literal["anthropic"] = "anthropic"


@dataclass(frozen=True)
class BatchResultItem:
    """Batch 結果 1 件。custom_id で BatchRequest と相関付ける。"""

    custom_id: str
    status: Literal["succeeded", "errored", "canceled", "expired"]
    text: str | None
    raw: dict[str, Any]


class AnthropicBatchClient:
    """Anthropic Messages Batches API の薄いラッパ。"""

    provider: Literal["anthropic"] = "anthropic"

    def __init__(self, *, api_key: str | None = None) -> None:
        # 遅延 import (T-F-15 で anthropic SDK を依存に追加済み前提)。
        from anthropic import AsyncAnthropic  # type: ignore[import-not-found]

        self._sdk = AsyncAnthropic(
            api_key=api_key or os.environ.get("ANTHROPIC_API_KEY"),
        )

    async def submit(self, requests: Sequence[BatchRequest]) -> BatchHandle:
        """batch を作成して handle を返す。

        Args:
            requests: 1〜10000 件の BatchRequest。

        Raises:
            ValueError: requests が空。
        """
        if not requests:
            raise ValueError("requests must be non-empty")
        payload = [r.to_sdk_dict() for r in requests]
        batch = await self._sdk.messages.batches.create(requests=payload)
        return BatchHandle(batch_id=batch.id)

    async def status(self, handle: BatchHandle) -> BatchStatus:
        """batch の現在のステータスを返す。"""
        batch = await self._sdk.messages.batches.retrieve(handle.batch_id)
        # SDK は processing_status を返す。"in_progress" | "canceling" | "ended"
        status_value = batch.processing_status
        if status_value not in ("in_progress", "canceling", "ended"):
            raise RuntimeError(f"unexpected batch status: {status_value!r}")
        return status_value  # type: ignore[no-any-return]

    async def results(
        self,
        handle: BatchHandle,
    ) -> AsyncIterator[BatchResultItem]:
        """ended 状態の batch から結果を 1 件ずつ返す async generator。"""
        async for entry in await self._sdk.messages.batches.results(
            handle.batch_id,
        ):
            yield _parse_result_entry(entry)


def _parse_result_entry(entry: Any) -> BatchResultItem:
    """SDK の result entry を BatchResultItem に変換する。"""
    custom_id: str = entry.custom_id
    result = entry.result
    result_type = getattr(result, "type", None)

    if result_type == "succeeded":
        message = result.message
        text_blocks = [
            getattr(b, "text", "")
            for b in message.content
            if getattr(b, "type", None) == "text"
        ]
        return BatchResultItem(
            custom_id=custom_id,
            status="succeeded",
            text="".join(text_blocks),
            raw={"type": "succeeded"},
        )
    if result_type in ("errored", "canceled", "expired"):
        return BatchResultItem(
            custom_id=custom_id,
            status=result_type,
            text=None,
            raw={"type": result_type},
        )
    raise RuntimeError(f"unknown batch result type: {result_type!r}")


__all__ = [
    "AnthropicBatchClient",
    "BatchHandle",
    "BatchRequest",
    "BatchResultItem",
    "BatchStatus",
]
