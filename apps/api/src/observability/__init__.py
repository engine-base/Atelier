"""Atelier 観測基盤 (T-F-08)。

selected-stack.json#observability = "Sentry (errors) + Langfuse (LLM) + Better Stack (logs)"

本パッケージは観測関連の foundation。本 PR では Sentry のみ実装し、Langfuse /
Better Stack は別 task で追加する (files_changed_predicted で scope 限定)。
"""

from .sentry import SentryConfig, init_sentry, is_sentry_initialized

__all__ = [
    "SentryConfig",
    "init_sentry",
    "is_sentry_initialized",
]
