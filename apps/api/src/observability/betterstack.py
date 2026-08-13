"""Better Stack ログ集約統合 (T-F-39)。

selected-stack.json#observability = "... + Better Stack (logs)"

設計方針:
- **公式 SDK ではなく Better Stack の HTTP ingest API を httpx で直叩き**する
  (依存追加なしで確定技術をそのまま使う)。
- `BetterStackHandler` は `logging.Handler`。`attach_betterstack_handler()` が
  **API の起動時に root logger へ実 attach** する。定義だけで attach されない
  状態にしない (T-F-42 で潰した「実装済みだが誰も呼ばない」の再発防止)。
- 送信は `QueueHandler` + `QueueListener` の**バックグラウンドスレッド**経由。
  リクエスト処理スレッドが HTTP 送信を待たない (ログ集約の遅延を業務遅延にしない)。
- トークン未設定なら attach しない = 既存のローカルログ出力のまま。
- 送信失敗・タイムアウトは握り潰す。**ローカル出力は常に独立して残る**
  (本 handler は既存 handler を置き換えず、追加で並ぶ)。
- **秘匿値は送出前に必ずマスクする** (`redact_text` / `redact_mapping`)。
  ログ集約の導入自体が新しい漏洩経路にならないようにする。
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import queue
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, cast

logger = logging.getLogger(__name__)

DEFAULT_INGEST_HOST = "https://in.logs.betterstack.com"
"""Better Stack の既定 ingest エンドポイント。region 別ホストは env で上書き。"""

DEFAULT_TIMEOUT_SECONDS = 3.0
"""送信タイムアウト。背景スレッドで実行するがハングを避けるため上限を持つ。"""

REDACTED = "[REDACTED]"

_SENSITIVE_KEY_RE = re.compile(
    r"(api[_-]?key|token|password|passwd|secret|authorization|credential|dsn)",
    re.IGNORECASE,
)
"""この語を含むキーの値は中身を見ずに伏せる。"""

_SECRET_VALUE_PATTERNS: tuple[re.Pattern[str], ...] = (
    # `api_key=xxx` / `token: xxx` のような key=value 形式
    re.compile(
        r"(?i)\b(api[_-]?key|token|password|passwd|secret|authorization)\b\s*[=:]\s*\S+",
    ),
    # `Bearer <token>`
    re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-]+"),
    # プロバイダ発行キーの代表形 (Anthropic / OpenAI / Stripe)
    re.compile(r"\bsk-[A-Za-z0-9_\-]{12,}"),
    re.compile(r"\bsk_(?:live|test)_[A-Za-z0-9]{12,}"),
)
"""メッセージ本文に紛れ込んだ秘匿値の代表形。"""

_RESERVED_RECORD_ATTRS = frozenset(logging.LogRecord("", 0, "", 0, "", None, None).__dict__)
"""標準の LogRecord 属性。これ以外を `extra` 由来とみなす。"""


@dataclass(frozen=True)
class BetterStackConfig:
    """Better Stack 接続設定。未指定項目は環境変数から解決する。

    Attributes:
        source_token: BETTERSTACK_SOURCE_TOKEN。source ごとの write-only トークン。
        host: BETTERSTACK_INGEST_HOST。region 別ホストを使うときのみ指定。
        timeout_seconds: 送信タイムアウト。
    """

    source_token: str | None = None
    host: str | None = None
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS

    def resolve_source_token(self) -> str | None:
        if self.source_token is not None:
            return self.source_token
        return os.environ.get("BETTERSTACK_SOURCE_TOKEN")

    def resolve_host(self) -> str:
        host = self.host if self.host is not None else os.environ.get("BETTERSTACK_INGEST_HOST")
        return (host or DEFAULT_INGEST_HOST).rstrip("/")


def redact_text(text: str) -> str:
    """メッセージ本文から秘匿値らしき部分を伏せる。"""
    redacted = text
    for pattern in _SECRET_VALUE_PATTERNS:
        redacted = pattern.sub(_replace_secret, redacted)
    return redacted


def _replace_secret(match: re.Match[str]) -> str:
    """key=value 形式なら key を残して値だけ伏せる。それ以外は全体を伏せる。"""
    matched = match.group(0)
    for separator in ("=", ":"):
        head, found, _tail = matched.partition(separator)
        if found:
            return f"{head}{separator}{REDACTED}"
    if matched.lower().startswith("bearer"):
        return f"Bearer {REDACTED}"
    return REDACTED


def redact_mapping(values: dict[str, Any]) -> dict[str, Any]:
    """キー名が秘匿候補なら値を伏せ、文字列値は本文マスクも適用する。"""
    result: dict[str, Any] = {}
    for key, value in values.items():
        if _SENSITIVE_KEY_RE.search(key):
            result[key] = REDACTED
        elif isinstance(value, str):
            result[key] = redact_text(value)
        elif isinstance(value, dict):
            # ログの extra は任意キーを取りうるのでキーを str に正規化してから再帰。
            nested = cast("dict[object, Any]", value)
            result[key] = redact_mapping({str(k): v for k, v in nested.items()})
        else:
            result[key] = value
    return result


def build_log_payload(record: logging.LogRecord) -> dict[str, Any]:
    """LogRecord を Better Stack へ送る構造化 JSON に変換する (マスク適用済)。"""
    extra = {
        key: value for key, value in record.__dict__.items() if key not in _RESERVED_RECORD_ATTRS
    }
    payload: dict[str, Any] = {
        "dt": datetime.fromtimestamp(record.created, tz=UTC).isoformat(),
        "level": record.levelname,
        "message": redact_text(record.getMessage()),
        "logger": record.name,
        "service": "atelier-api",
    }
    if record.exc_info is not None:
        payload["exception"] = redact_text(logging.Formatter().formatException(record.exc_info))
    if extra:
        payload["extra"] = redact_mapping(extra)
    return payload


class BetterStackHandler(logging.Handler):
    """LogRecord を構造化 JSON で Better Stack へ送る handler。

    `emit()` は**決して例外を送出しない**。送信失敗はローカル出力に影響しない
    (本 handler は既存 handler と並列に attach される)。
    """

    def __init__(
        self,
        config: BetterStackConfig | None = None,
        level: int = logging.NOTSET,
    ) -> None:
        super().__init__(level)
        self._config = config if config is not None else BetterStackConfig()

    @property
    def enabled(self) -> bool:
        """source token が解決できるなら True。"""
        return bool(self._config.resolve_source_token())

    def emit(self, record: logging.LogRecord) -> None:
        if not self.enabled:
            return
        try:
            self.ship(build_log_payload(record))
        except Exception:
            # ログ送出の失敗で業務処理を落とさない。handler 内から logger を
            # 呼ぶと再帰するため、標準の handleError に委ねる。
            self.handleError(record)

    def ship(self, payload: dict[str, Any]) -> bool:
        """構造化 payload を 1 件送る。失敗は False (例外は送出しない)。"""
        import httpx

        token = self._config.resolve_source_token()
        if not token:
            return False
        try:
            response = httpx.post(
                self._config.resolve_host(),
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
                timeout=self._config.timeout_seconds,
            )
        except Exception:
            return False
        return response.status_code < 400


_queue_handler: logging.handlers.QueueHandler | None = None
_listener: logging.handlers.QueueListener | None = None


def attach_betterstack_handler(
    target: logging.Logger | None = None,
    config: BetterStackConfig | None = None,
) -> bool:
    """root logger (既定) に Better Stack handler を実 attach する。

    トークン未設定なら **attach せず** warning を出して `False` を返す
    (= 既存のローカルログ出力のまま)。二重 attach は行わない (idempotent)。

    Returns:
        attach したら `True`、未設定 / attach 済みなら `False`。
    """
    global _queue_handler, _listener

    if _queue_handler is not None:
        return False

    handler = BetterStackHandler(config)
    if not handler.enabled:
        logger.warning(
            "BETTERSTACK_SOURCE_TOKEN not set; log shipping disabled (local logging is unaffected)",
        )
        return False

    log_queue: queue.SimpleQueue[logging.LogRecord] = queue.SimpleQueue()
    _queue_handler = logging.handlers.QueueHandler(log_queue)
    _listener = logging.handlers.QueueListener(log_queue, handler, respect_handler_level=True)
    _listener.start()
    (target if target is not None else logging.getLogger()).addHandler(_queue_handler)
    logger.info("better stack log shipping attached")
    return True


def detach_betterstack_handler(target: logging.Logger | None = None) -> None:
    """attach した handler を外す (テスト / graceful shutdown 用)。"""
    global _queue_handler, _listener

    if _queue_handler is not None:
        (target if target is not None else logging.getLogger()).removeHandler(_queue_handler)
        _queue_handler = None
    if _listener is not None:
        _listener.stop()
        _listener = None


def is_betterstack_attached() -> bool:
    """attach 済みなら True。"""
    return _queue_handler is not None


__all__ = [
    "DEFAULT_INGEST_HOST",
    "DEFAULT_TIMEOUT_SECONDS",
    "REDACTED",
    "BetterStackConfig",
    "BetterStackHandler",
    "attach_betterstack_handler",
    "build_log_payload",
    "detach_betterstack_handler",
    "is_betterstack_attached",
    "redact_mapping",
    "redact_text",
]
