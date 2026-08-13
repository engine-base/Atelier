"""Atelier 観測基盤 (T-F-08 / T-F-38 / T-F-39 / T-F-42)。

selected-stack.json#observability = "Sentry (errors) + Langfuse (LLM) + Better Stack (logs)"

確定 3 点セットは以下の実行経路から**実際に呼ばれている** (定義だけの状態にしない):

| 対象 | 実装 | 呼び出し元 |
|---|---|---|
| Sentry | `sentry.py` `init_sentry()` | `apps/api/main.py` の lifespan (T-F-42) |
| Langfuse | `langfuse.py` `LangfuseClient` | `src/llm/client.py` の `TracedLLMClient` (T-F-38) |
| Better Stack | `betterstack.py` `BetterStackHandler` | `apps/api/main.py` の lifespan が `attach_betterstack_handler()` (T-F-39) |

いずれも未設定なら warning を出して no-op になり、業務処理は落とさない。
"""

from .betterstack import (
    BetterStackConfig,
    BetterStackHandler,
    attach_betterstack_handler,
    detach_betterstack_handler,
    is_betterstack_attached,
)
from .langfuse import LangfuseClient, LangfuseConfig, LLMTrace, get_langfuse_client
from .sentry import SentryConfig, init_sentry, is_sentry_initialized

__all__ = [
    "BetterStackConfig",
    "BetterStackHandler",
    "LLMTrace",
    "LangfuseClient",
    "LangfuseConfig",
    "SentryConfig",
    "attach_betterstack_handler",
    "detach_betterstack_handler",
    "get_langfuse_client",
    "init_sentry",
    "is_betterstack_attached",
    "is_sentry_initialized",
]
