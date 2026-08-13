"""Langfuse LLM トレース統合 (T-F-38)。

selected-stack.json#observability = "... + Langfuse (LLM) + ..."

設計方針:
- **公式 SDK ではなく Langfuse の public ingestion API (HTTP) を直叩き**する。
  理由は 2 つ: ① 依存追加なしで確定技術 (Langfuse) をそのまま使える
  ② SDK の背景スレッド/atexit flush に依存せず、送信の失敗を呼び出し元で
  完全に握り潰せる (LLM 呼び出しを落とさない、が critical AC のため)。
- 未設定 (公開鍵 / 秘密鍵のいずれか欠落) なら warning を 1 回出して no-op。
- **送信内容はメタデータのみ**。prompt / completion 本文は送らない。
  AI 学習デフォルト OFF の方針 (CLAUDE.md 絶対ルール 6) に従い、顧客データを
  外部トレース基盤へ流さない。model / latency / token usage だけを載せる。
- 例外・タイムアウトは全て内部で捕捉し `False` を返す。呼び出し元へは伝播しない。
"""

from __future__ import annotations

import logging
import os
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import TypedDict

logger = logging.getLogger(__name__)

DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com"
"""Langfuse Cloud の既定ホスト。self-host なら LANGFUSE_HOST で上書きする。"""

DEFAULT_TIMEOUT_SECONDS = 2.0
"""トレース送信のタイムアウト。業務処理を待たせないため短く固定する。"""

INGESTION_PATH = "/api/public/ingestion"


@dataclass(frozen=True)
class LangfuseConfig:
    """Langfuse 接続設定。未指定項目は環境変数から解決する。

    Attributes:
        public_key: LANGFUSE_PUBLIC_KEY。Basic 認証のユーザ名に相当。
        secret_key: LANGFUSE_SECRET_KEY。Basic 認証のパスワードに相当。
        host: LANGFUSE_HOST。self-host 時のみ指定。
        timeout_seconds: 送信タイムアウト。
    """

    public_key: str | None = None
    secret_key: str | None = None
    host: str | None = None
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS

    def resolve_public_key(self) -> str | None:
        return (
            self.public_key
            if self.public_key is not None
            else os.environ.get("LANGFUSE_PUBLIC_KEY")
        )

    def resolve_secret_key(self) -> str | None:
        return (
            self.secret_key
            if self.secret_key is not None
            else os.environ.get("LANGFUSE_SECRET_KEY")
        )

    def resolve_host(self) -> str:
        host = self.host if self.host is not None else os.environ.get("LANGFUSE_HOST")
        return (host or DEFAULT_LANGFUSE_HOST).rstrip("/")


class IngestionEvent(TypedDict):
    """Langfuse ingestion batch の 1 イベント。"""

    id: str
    type: str
    timestamp: str
    body: dict[str, object]


class IngestionPayload(TypedDict):
    """`POST /api/public/ingestion` のリクエストボディ。"""

    batch: list[IngestionEvent]


@dataclass(frozen=True)
class LLMTrace:
    """1 回の LLM 呼び出しを表すトレース。

    Attributes:
        provider: "anthropic" / "openai" 等。
        model: 実際に応答したモデル名。
        latency_ms: 呼び出しに要したミリ秒。
        input_tokens: 入力トークン数。
        output_tokens: 出力トークン数。
        name: Langfuse 上の generation 名。
    """

    provider: str
    model: str
    latency_ms: float
    input_tokens: int
    output_tokens: int
    name: str = "llm.complete"


class LangfuseClient:
    """Langfuse へ LLM トレースを送るクライアント。

    `enabled` が False (鍵未設定) のときは `trace()` が何もせず `False` を返す。
    送信で例外が起きても外へは投げない。
    """

    def __init__(self, config: LangfuseConfig | None = None) -> None:
        self._config = config if config is not None else LangfuseConfig()
        self._warned_unconfigured = False

    @property
    def enabled(self) -> bool:
        """公開鍵と秘密鍵の両方が解決できるなら True。"""
        return bool(self._config.resolve_public_key() and self._config.resolve_secret_key())

    async def trace(self, trace: LLMTrace) -> bool:
        """1 件のトレースを Langfuse へ送る。

        Returns:
            送信できたら `True`、未設定 / 送信失敗なら `False`。
            **どの経路でも例外は送出しない。**
        """
        if not self.enabled:
            self._warn_unconfigured()
            return False

        try:
            return await self._post(trace)
        except Exception:
            # トレース送信の失敗を業務エラーへ昇格させない (critical AC)。
            logger.warning(
                "langfuse trace shipping failed; continuing without trace",
                exc_info=True,
            )
            return False

    async def _post(self, trace: LLMTrace) -> bool:
        import httpx

        public_key = self._config.resolve_public_key() or ""
        secret_key = self._config.resolve_secret_key() or ""
        url = f"{self._config.resolve_host()}{INGESTION_PATH}"

        async with httpx.AsyncClient(timeout=self._config.timeout_seconds) as client:
            response = await client.post(
                url,
                json=build_ingestion_payload(trace),
                auth=(public_key, secret_key),
            )
        if response.status_code >= 400:
            logger.warning(
                "langfuse ingestion returned %s; trace dropped",
                response.status_code,
            )
            return False
        return True

    def _warn_unconfigured(self) -> None:
        """未設定の warning はプロセスで 1 回だけ (ログ汚染を避ける)。"""
        if self._warned_unconfigured:
            return
        self._warned_unconfigured = True
        logger.warning(
            "LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set; "
            "LLM tracing is disabled (LLM calls are unaffected)",
        )


def build_ingestion_payload(trace: LLMTrace) -> IngestionPayload:
    """Langfuse ingestion API の batch payload を組み立てる。

    prompt / completion 本文は**含めない** (メタデータのみ)。
    """
    trace_id = str(uuid.uuid4())
    end = datetime.now(UTC)
    now = end.isoformat()
    start_time = (end - timedelta(milliseconds=trace.latency_ms)).isoformat()

    return {
        "batch": [
            {
                "id": str(uuid.uuid4()),
                "type": "trace-create",
                "timestamp": now,
                "body": {
                    "id": trace_id,
                    "name": trace.name,
                    "metadata": {"provider": trace.provider},
                },
            },
            {
                "id": str(uuid.uuid4()),
                "type": "generation-create",
                "timestamp": now,
                "body": {
                    "id": str(uuid.uuid4()),
                    "traceId": trace_id,
                    "name": trace.name,
                    "model": trace.model,
                    "startTime": start_time,
                    "endTime": now,
                    "metadata": {
                        "provider": trace.provider,
                        "latency_ms": round(trace.latency_ms, 3),
                    },
                    "usage": {
                        "input": trace.input_tokens,
                        "output": trace.output_tokens,
                        "total": trace.input_tokens + trace.output_tokens,
                        "unit": "TOKENS",
                    },
                },
            },
        ],
    }


_default_client: LangfuseClient | None = None


def get_langfuse_client() -> LangfuseClient:
    """プロセス共有の LangfuseClient を返す (未設定 warning を 1 回に保つため)。"""
    global _default_client
    if _default_client is None:
        _default_client = LangfuseClient()
    return _default_client


__all__ = [
    "DEFAULT_LANGFUSE_HOST",
    "DEFAULT_TIMEOUT_SECONDS",
    "INGESTION_PATH",
    "IngestionEvent",
    "IngestionPayload",
    "LLMTrace",
    "LangfuseClient",
    "LangfuseConfig",
    "build_ingestion_payload",
    "get_langfuse_client",
]
