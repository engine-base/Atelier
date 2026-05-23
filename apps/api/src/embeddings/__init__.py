"""Atelier 埋め込みレイヤ (T-F-14)。

selected-stack.json#embedding_provider = "Voyage AI" (voyage-3-large, 1024-dim)。
pgvector への INSERT は Repository 層が SQLAlchemy 経由で行う (T-A-XX)。
"""

from .voyage import (
    DEFAULT_DIMENSIONS,
    DEFAULT_MODEL,
    MAX_BATCH_SIZE,
    EmbedResult,
    EmbedUsage,
    InputType,
    VoyageClient,
    VoyageError,
)

__all__ = [
    "DEFAULT_DIMENSIONS",
    "DEFAULT_MODEL",
    "MAX_BATCH_SIZE",
    "EmbedResult",
    "EmbedUsage",
    "InputType",
    "VoyageClient",
    "VoyageError",
]
