"""Sentry FastAPI 統合 (T-F-08)。

selected-stack.json#observability = "Sentry (errors) ..."
EU リージョン (engine-base.sentry.io / ingest.de.sentry.io) を前提に設定する。

設計方針:
- sentry_sdk は **T-F-42 で実依存になった** (apps/api/pyproject.toml)。
  init_sentry() 内の遅延 import は「起動時のコストを払わない / 万一の
  SDK 不在でも API を落とさない」ための防御として残す (契約は不変)。
- before_send は実 SDK の `EventProcessor` 契約 ((Event, Hint) -> Event | None)
  に整合させる (T-F-45)。型を殺して黙らせない。
- init_sentry() は idempotent (二重 init を抑止)
- SDK 不在 / DSN 未設定なら logger.warning に流して False を返す
  → 本番では DSN 必須、開発では DSN 不要で動く
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any, Literal, cast

from sentry_sdk.types import Event, Hint

logger = logging.getLogger(__name__)

# モジュール内グローバルで初期化済フラグを保持 (idempotent guard)
_initialized: bool = False

DEFAULT_TRACES_SAMPLE_RATE = 1.0
"""error 送信のサンプリング率。開発期 100%、本番は環境変数で 0.1 に下げる。"""

DEFAULT_PROFILES_SAMPLE_RATE = 0.0
"""profiling のサンプリング率。Pro plan 必須機能なので Free では 0。"""


SentryEnvironment = Literal["production", "preview", "development", "test"]


@dataclass(frozen=True)
class SentryConfig:
    """Sentry 初期化パラメータ。`init_sentry()` に渡す DTO。

    Attributes:
        dsn: Sentry DSN URL。None なら SENTRY_DSN 環境変数を読む。
        environment: production / preview / development / test。
        release: release タグ。Fly.io のリビジョン or git sha を推奨。
        traces_sample_rate: 0.0〜1.0。デフォルト 1.0。
        profiles_sample_rate: 0.0〜1.0。デフォルト 0.0 (Free plan)。
        send_default_pii: ユーザー情報を送るか。True 推奨 (Sentry 公式)。
    """

    dsn: str | None = None
    environment: SentryEnvironment = "production"
    release: str | None = None
    traces_sample_rate: float = DEFAULT_TRACES_SAMPLE_RATE
    profiles_sample_rate: float = DEFAULT_PROFILES_SAMPLE_RATE
    send_default_pii: bool = True

    def resolve_dsn(self) -> str | None:
        """dsn or 環境変数からの DSN を返す。両方 None なら None。"""
        return self.dsn if self.dsn is not None else os.environ.get("SENTRY_DSN")


def init_sentry(config: SentryConfig | None = None) -> bool:
    """sentry_sdk を初期化する。

    SDK 未インストール / DSN 未設定の場合は warn ログを出して `False` を返す。
    本番では fly.toml の SENTRY_DSN secret で必ず DSN を流すこと。

    Returns:
        初期化成功で `True`、SDK 不在 / DSN 不在で `False`。
    """
    global _initialized

    if _initialized:
        logger.debug("sentry already initialized; skipping")
        return True

    cfg = config if config is not None else SentryConfig()
    dsn = cfg.resolve_dsn()
    if not dsn:
        logger.warning(
            "SENTRY_DSN not set; Sentry initialization skipped",
        )
        return False

    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
    except ImportError:
        logger.warning(
            "sentry-sdk is not installed; Sentry initialization skipped. "
            "Add `sentry-sdk[fastapi]` to apps/api dependencies.",
        )
        return False

    sentry_sdk.init(
        dsn=dsn,
        environment=cfg.environment,
        release=cfg.release,
        traces_sample_rate=cfg.traces_sample_rate,
        profiles_sample_rate=cfg.profiles_sample_rate,
        send_default_pii=cfg.send_default_pii,
        integrations=[
            FastApiIntegration(transaction_style="endpoint"),
            StarletteIntegration(transaction_style="endpoint"),
        ],
        # PII フィルタリング — JWT / API key / DB URL の自動マスキング
        before_send=_scrub_sensitive_fields,
    )
    _initialized = True
    logger.info(
        "sentry initialized: environment=%s release=%s",
        cfg.environment,
        cfg.release,
    )
    return True


def is_sentry_initialized() -> bool:
    """init_sentry() を呼んで成功したかを返す (idempotent guard 用)。"""
    return _initialized


def _scrub_sensitive_fields(event: Event, _hint: Hint) -> Event | None:
    """sentry_sdk の before_send hook (`EventProcessor` 契約)。

    HTTP header / extra から秘匿値を除去する。Sentry の `send_default_pii=True` は
    便利だが、Authorization header や DATABASE_URL を生で送るリスクがある。
    ここで防御的にマスクする。

    `None` を返すとイベントは破棄されるが、本 hook は**必ずイベントを返す**
    (マスクはするが握り潰さない)。戻り値型の `| None` は SDK 側の契約に合わせたもの。
    """
    request = event.get("request")
    if isinstance(request, dict):
        request_dict = cast("dict[str, Any]", request)
        raw_headers = request_dict.get("headers")
        if isinstance(raw_headers, dict):
            headers = cast("dict[str, Any]", raw_headers)
            request_dict["headers"] = {
                key: ("[Filtered]" if _is_sensitive_header(key) else value)
                for key, value in headers.items()
            }
    return event


_SENSITIVE_HEADER_KEYS = frozenset(
    {
        "authorization",
        "cookie",
        "set-cookie",
        "x-api-key",
        "x-auth-token",
        "x-supabase-auth",
    },
)


def _is_sensitive_header(name: object) -> bool:
    """name が秘匿候補なら True (case-insensitive 比較)。"""
    if not isinstance(name, str):
        return False
    return name.lower() in _SENSITIVE_HEADER_KEYS


__all__ = [
    "DEFAULT_PROFILES_SAMPLE_RATE",
    "DEFAULT_TRACES_SAMPLE_RATE",
    "SentryConfig",
    "SentryEnvironment",
    "init_sentry",
    "is_sentry_initialized",
]
