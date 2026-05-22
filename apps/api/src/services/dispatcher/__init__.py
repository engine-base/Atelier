"""Atelier Dispatcher service (T-F-28)。

Hermes 互換の kanban_tools 移植基盤。AI 社員 (tony / strange / thor 等) が
タスクの column 遷移・assignee 変更・blocker 設定などを実行する tool 群を
提供する。本パッケージは外部 SDK 依存ゼロの pure ドメインロジック層。

F-DISP01 Dispatcher Feature の Foundation。実 SQL 永続化は Wave 1 以降の
T-A-XX で `TaskRepository` Protocol の実装として注入される。
"""

from .kanban_tools import (
    ALLOWED_TRANSITIONS,
    KanbanMove,
    KanbanTools,
    Task,
    TaskColumn,
    TaskRepository,
    TransitionError,
)

__all__ = [
    "ALLOWED_TRANSITIONS",
    "KanbanMove",
    "KanbanTools",
    "Task",
    "TaskColumn",
    "TaskRepository",
    "TransitionError",
]
