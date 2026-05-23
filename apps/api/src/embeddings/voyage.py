"""Voyage AI embeddings client (T-F-14)。

selected-stack.json#embedding_provider = "Voyage AI"。
voyage-3-large は 1024-dim 多言語対応 (32k context window) で、Atelier の
RAG / 議事録検索 / task 類似性判定で利用。

参照:
- https://docs.voyageai.com/reference/embeddings-api
- 公式 SDK は提供されているが軽量化のため httpx 直叩き
- API 値: input は最大 1000 件 / リクエスト、batch_size を超えたら自動分割

設計方針:
- pure async + httpx (apps/api 既存依存)
- input_type: "document" (文書側) / "query" (検索クエリ側) で異なる埋め込み
- transient エラー (429/5xx) は exponential backoff で 3 回 retry
- 環境変数 VOYAGE_API_KEY が無ければ init 時に明示的に raise
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from typing import Any, Literal, cast

import httpx

VOYAGE_API_URL = "https://api.voyageai.com/v1/embeddings"

# 推奨モデル (2026-05 時点)。
# voyage-3-large: 1024-dim, 32k context, 多言語強, 課金 $0.12/M tokens
# voyage-3:       1024-dim, 32k context, 標準, 課金 $0.06/M tokens
# voyage-3-lite:   512-dim, 32k context, 軽量, 課金 $0.02/M tokens
DEFAULT_MODEL: Literal["voyage-3-large"] = "voyage-3-large"

DEFAULT_DIMENSIONS = 1024
"""voyage-3-large / voyage-3 は 1024-dim。pgvector の embedding 列もこれに揃える。"""

MAX_BATCH_SIZE = 1000
"""Voyage API の input 配列の最大件数。これを超える input は自動分割。"""

InputType = Literal["document", "query"]


class VoyageError(RuntimeError):
    """Voyage API 由来のエラー (非 retryable / retry 上限到達)。"""


@dataclass(frozen=True)
class EmbedUsage:
    """1 リクエスト分の token usage。"""

    total_tokens: int


@dataclass(frozen=True)
class EmbedResult:
    """embed() の戻り値。1 input につき 1 embedding ベクトル。"""

    embeddings: list[list[float]]
    model: str
    usage: EmbedUsage
    dimensions: int = field(default=DEFAULT_DIMENSIONS)


class VoyageClient:
    """Voyage AI Embeddings API の薄い async ラッパ。

    Args:
        api_key: VOYAGE_API_KEY。None なら環境変数を読む。
        timeout: 1 リクエストあたりのタイムアウト秒。
        max_retries: transient (429 / 5xx) エラーの最大リトライ回数。
        base_url: API endpoint (テスト時に差し替え)。
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        timeout: float = 30.0,
        max_retries: int = 3,
        base_url: str = VOYAGE_API_URL,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        key = api_key if api_key is not None else os.environ.get("VOYAGE_API_KEY")
        if not key:
            raise VoyageError(
                "VOYAGE_API_KEY is not set. Configure it in .env or pass api_key=...",
            )
        if max_retries < 0:
            raise ValueError(f"max_retries must be >= 0, got {max_retries}")
        self._api_key = key
        self._timeout = timeout
        self._max_retries = max_retries
        self._base_url = base_url
        # transport は test 時に httpx.MockTransport を inject するための seam。
        # production では None → httpx のデフォルト (HTTPTransport) が使われる。
        self._transport = transport

    async def embed(
        self,
        inputs: list[str],
        *,
        model: str = DEFAULT_MODEL,
        input_type: InputType = "document",
    ) -> EmbedResult:
        """input list を embedding に変換する。

        MAX_BATCH_SIZE を超える inputs は自動分割して結果を結合する。
        個々のリクエストは指数バックオフでリトライ。

        Raises:
            ValueError: inputs が空。
            VoyageError: API がリトライ上限まで失敗。
        """
        if not inputs:
            raise ValueError("inputs must be non-empty")

        all_vectors: list[list[float]] = []
        total_tokens = 0
        model_returned = model

        # MAX_BATCH_SIZE 単位で分割
        for start in range(0, len(inputs), MAX_BATCH_SIZE):
            chunk = inputs[start : start + MAX_BATCH_SIZE]
            payload = {
                "input": chunk,
                "model": model,
                "input_type": input_type,
            }
            data = await self._post_with_retry(payload)
            items = cast("list[dict[str, Any]]", data["data"])
            for item in items:
                all_vectors.append(cast("list[float]", item["embedding"]))
            usage = cast("dict[str, Any]", data.get("usage", {}))
            total_tokens += int(usage.get("total_tokens", 0))
            model_returned = cast(str, data.get("model", model))

        dim = len(all_vectors[0]) if all_vectors else DEFAULT_DIMENSIONS
        return EmbedResult(
            embeddings=all_vectors,
            model=model_returned,
            usage=EmbedUsage(total_tokens=total_tokens),
            dimensions=dim,
        )

    async def embed_query(
        self,
        text: str,
        *,
        model: str = DEFAULT_MODEL,
    ) -> list[float]:
        """1 件の検索クエリを embedding に変換する shortcut。

        input_type='query' を設定するため、document 側の同期 embedding
        とは異なるベクトル空間に最適化される (Voyage 公式の推奨)。
        """
        result = await self.embed([text], model=model, input_type="query")
        return result.embeddings[0]

    async def _post_with_retry(self, payload: dict[str, Any]) -> dict[str, Any]:
        """POST + transient エラー retry。final attempt は VoyageError を raise。"""
        delay = 1.0
        last_exc: Exception | None = None

        async with httpx.AsyncClient(
            timeout=self._timeout,
            transport=self._transport,
        ) as client:
            for attempt in range(self._max_retries + 1):
                try:
                    response = await client.post(
                        self._base_url,
                        json=payload,
                        headers={
                            "Authorization": f"Bearer {self._api_key}",
                            "Content-Type": "application/json",
                        },
                    )
                except httpx.HTTPError as exc:
                    last_exc = exc
                    if attempt >= self._max_retries:
                        break
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue

                if response.status_code == 200:
                    body: dict[str, Any] = response.json()
                    return body

                # transient (429 / 5xx) は retry、それ以外は即 raise
                if response.status_code == 429 or response.status_code >= 500:
                    last_exc = VoyageError(
                        f"transient {response.status_code}: {response.text[:200]}",
                    )
                    if attempt >= self._max_retries:
                        break
                    await asyncio.sleep(delay)
                    delay *= 2
                    continue

                # 4xx (auth / invalid) は即 fail
                raise VoyageError(
                    f"non-retryable {response.status_code}: {response.text[:200]}",
                )

        raise VoyageError(f"max retries exceeded: {last_exc}")


__all__ = [
    "DEFAULT_DIMENSIONS",
    "DEFAULT_MODEL",
    "MAX_BATCH_SIZE",
    "VOYAGE_API_URL",
    "EmbedResult",
    "EmbedUsage",
    "InputType",
    "VoyageClient",
    "VoyageError",
]
