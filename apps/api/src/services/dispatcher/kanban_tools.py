"""Hermes 互換 kanban_tools 移植基盤 (T-F-28)。

Atelier の Dispatcher (F-DISP01) が AI 社員へ tool として exposing する
kanban 操作群。state machine + Repository Protocol の組み合わせで
ドメインロジックを永続化から分離する。

設計方針:
- TaskColumn: 5 状態の Enum (todo / in_progress / review / blocked / done)
- ALLOWED_TRANSITIONS: 状態遷移行列 (frozenset で immutable)
- TaskRepository: 永続化の Protocol (実装は T-A-XX で SQLAlchemy 経由 inject)
- KanbanTools: tool 群の facade。AI が dispatch する単一エントリポイント
- 全 mutation は新規 dataclass を返す (immutable, 副作用は repo 経由のみ)
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from enum import Enum
from typing import Protocol


class TaskColumn(str, Enum):
    """kanban column。値は DB 列の string 表現と一致させる。"""

    TODO = "todo"
    IN_PROGRESS = "in_progress"
    REVIEW = "review"
    BLOCKED = "blocked"
    DONE = "done"


# 状態遷移行列。Hermes 互換: BLOCKED は任意状態から/へ遷移可能 (escalation 用)。
ALLOWED_TRANSITIONS: Mapping[TaskColumn, frozenset[TaskColumn]] = {
    TaskColumn.TODO: frozenset({TaskColumn.IN_PROGRESS, TaskColumn.BLOCKED}),
    TaskColumn.IN_PROGRESS: frozenset(
        {TaskColumn.REVIEW, TaskColumn.BLOCKED, TaskColumn.TODO},
    ),
    TaskColumn.REVIEW: frozenset(
        {TaskColumn.DONE, TaskColumn.IN_PROGRESS, TaskColumn.BLOCKED},
    ),
    TaskColumn.BLOCKED: frozenset(
        {TaskColumn.TODO, TaskColumn.IN_PROGRESS, TaskColumn.REVIEW},
    ),
    TaskColumn.DONE: frozenset({TaskColumn.REVIEW}),  # re-open のみ許可
}


class TransitionError(ValueError):
    """state machine が禁止する遷移を要求したときに raise される。"""


@dataclass(frozen=True)
class Task:
    """kanban 上の Task 表現 (E-012 Task の最小サブセット)。

    フル schema は db/models で定義される (T-A-XX)。本モジュールは tool 層
    で必要な最小フィールドのみ保持する domain object。
    """

    id: str
    title: str
    column: TaskColumn
    assignee_id: str | None = None
    blocker_reason: str | None = None
    updated_at: datetime = field(default_factory=lambda: datetime.now(tz=UTC))


@dataclass(frozen=True)
class KanbanMove:
    """1 件分の column 遷移ログ (E-013 TaskExecution の最小サブセット)。"""

    task_id: str
    from_column: TaskColumn
    to_column: TaskColumn
    actor_id: str
    moved_at: datetime = field(default_factory=lambda: datetime.now(tz=UTC))


class TaskRepository(Protocol):
    """Task 永続化の抽象。実装は T-A-XX で SQLAlchemy 経由で inject される。"""

    async def get(self, task_id: str) -> Task | None: ...
    async def save(self, task: Task) -> Task: ...
    async def record_move(self, move: KanbanMove) -> None: ...


def can_transition(src: TaskColumn, dst: TaskColumn) -> bool:
    """src → dst が ALLOWED_TRANSITIONS に含まれるか判定する。

    同一 column への遷移は no-op として禁止 (重複イベントを防ぐ)。
    """
    if src == dst:
        return False
    return dst in ALLOWED_TRANSITIONS.get(src, frozenset())


class KanbanTools:
    """AI 社員が dispatch する kanban tool 群の facade。

    Repository を受け取り tool 呼び出し時に新 Task を返す。全 mutation は
    新規 dataclass + repo.save() の 2 段階で行い、in-place 変更を避ける。
    """

    def __init__(self, repo: TaskRepository) -> None:
        self._repo = repo

    async def move(
        self,
        task_id: str,
        *,
        to_column: TaskColumn,
        actor_id: str,
    ) -> Task:
        """task の column を遷移する。state machine を検証し、move ログを残す。

        Raises:
            LookupError: task が存在しない。
            TransitionError: 遷移が ALLOWED_TRANSITIONS に違反。
        """
        if not actor_id:
            raise ValueError("actor_id must be non-empty")
        task = await self._repo.get(task_id)
        if task is None:
            raise LookupError(f"task not found: {task_id}")
        if not can_transition(task.column, to_column):
            raise TransitionError(
                f"transition not allowed: {task.column.value} -> {to_column.value}",
            )
        updated = replace(
            task,
            column=to_column,
            blocker_reason=None if to_column != TaskColumn.BLOCKED else task.blocker_reason,
            updated_at=datetime.now(tz=UTC),
        )
        saved = await self._repo.save(updated)
        await self._repo.record_move(
            KanbanMove(
                task_id=task_id,
                from_column=task.column,
                to_column=to_column,
                actor_id=actor_id,
            ),
        )
        return saved

    async def assign(
        self,
        task_id: str,
        *,
        assignee_id: str | None,
    ) -> Task:
        """task の assignee を変更する。None で unassign。"""
        task = await self._repo.get(task_id)
        if task is None:
            raise LookupError(f"task not found: {task_id}")
        updated = replace(
            task,
            assignee_id=assignee_id,
            updated_at=datetime.now(tz=UTC),
        )
        return await self._repo.save(updated)

    async def block(
        self,
        task_id: str,
        *,
        reason: str,
        actor_id: str,
    ) -> Task:
        """task を BLOCKED に遷移させ理由を記録する。

        Hermes 互換: blocker_reason は必須 (空文字列禁止)。
        """
        if not reason:
            raise ValueError("blocker reason must be non-empty")
        task = await self._repo.get(task_id)
        if task is None:
            raise LookupError(f"task not found: {task_id}")
        if not can_transition(task.column, TaskColumn.BLOCKED):
            raise TransitionError(
                f"cannot block from {task.column.value}",
            )
        updated = replace(
            task,
            column=TaskColumn.BLOCKED,
            blocker_reason=reason,
            updated_at=datetime.now(tz=UTC),
        )
        saved = await self._repo.save(updated)
        await self._repo.record_move(
            KanbanMove(
                task_id=task_id,
                from_column=task.column,
                to_column=TaskColumn.BLOCKED,
                actor_id=actor_id,
            ),
        )
        return saved

    async def unblock(
        self,
        task_id: str,
        *,
        to_column: TaskColumn,
        actor_id: str,
    ) -> Task:
        """BLOCKED の task を to_column に解除する。blocker_reason をクリア。"""
        task = await self._repo.get(task_id)
        if task is None:
            raise LookupError(f"task not found: {task_id}")
        if task.column != TaskColumn.BLOCKED:
            raise TransitionError(
                f"unblock requires BLOCKED state, got {task.column.value}",
            )
        if not can_transition(TaskColumn.BLOCKED, to_column):
            raise TransitionError(
                f"transition not allowed: BLOCKED -> {to_column.value}",
            )
        updated = replace(
            task,
            column=to_column,
            blocker_reason=None,
            updated_at=datetime.now(tz=UTC),
        )
        saved = await self._repo.save(updated)
        await self._repo.record_move(
            KanbanMove(
                task_id=task_id,
                from_column=TaskColumn.BLOCKED,
                to_column=to_column,
                actor_id=actor_id,
            ),
        )
        return saved


__all__ = [
    "ALLOWED_TRANSITIONS",
    "KanbanMove",
    "KanbanTools",
    "Task",
    "TaskColumn",
    "TaskRepository",
    "TransitionError",
    "can_transition",
]
