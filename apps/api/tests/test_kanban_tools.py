"""Unit tests for apps/api/src/services/dispatcher/kanban_tools.py (T-F-28)."""

from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from src.services.dispatcher import (
    ALLOWED_TRANSITIONS,
    KanbanMove,
    KanbanTools,
    Task,
    TaskColumn,
    TransitionError,
)
from src.services.dispatcher.kanban_tools import can_transition


class FakeRepo:
    """In-memory TaskRepository for unit tests."""

    def __init__(self, tasks: list[Task] | None = None) -> None:
        self._tasks: dict[str, Task] = {t.id: t for t in tasks or []}
        self.moves: list[KanbanMove] = []

    async def get(self, task_id: str) -> Task | None:
        return self._tasks.get(task_id)

    async def save(self, task: Task) -> Task:
        self._tasks[task.id] = task
        return task

    async def record_move(self, move: KanbanMove) -> None:
        self.moves.append(move)


def _task(
    column: TaskColumn = TaskColumn.TODO,
    *,
    task_id: str = "T-1",
    assignee: str | None = None,
    blocker: str | None = None,
) -> Task:
    return Task(
        id=task_id,
        title="example",
        column=column,
        assignee_id=assignee,
        blocker_reason=blocker,
    )


# ─────────────────────────────────────────────────────────
# Enums / Dataclasses
# ─────────────────────────────────────────────────────────
@pytest.mark.unit
class TestTaskColumn:
    def test_string_values(self) -> None:
        assert TaskColumn.TODO.value == "todo"
        assert TaskColumn.IN_PROGRESS.value == "in_progress"
        assert TaskColumn.REVIEW.value == "review"
        assert TaskColumn.BLOCKED.value == "blocked"
        assert TaskColumn.DONE.value == "done"

    def test_is_str_subclass(self) -> None:
        # DB 列との互換性のため str を継承
        assert isinstance(TaskColumn.TODO, str)


@pytest.mark.unit
class TestTask:
    def test_frozen(self) -> None:
        t = _task()
        with pytest.raises(FrozenInstanceError):
            t.title = "x"  # type: ignore[misc]

    def test_default_timestamps(self) -> None:
        t = _task()
        assert t.updated_at.tzinfo is not None


@pytest.mark.unit
class TestKanbanMove:
    def test_frozen(self) -> None:
        m = KanbanMove(
            task_id="T-1",
            from_column=TaskColumn.TODO,
            to_column=TaskColumn.IN_PROGRESS,
            actor_id="tony",
        )
        with pytest.raises(FrozenInstanceError):
            m.actor_id = "x"  # type: ignore[misc]


# ─────────────────────────────────────────────────────────
# State machine
# ─────────────────────────────────────────────────────────
@pytest.mark.unit
class TestAllowedTransitions:
    def test_all_columns_covered(self) -> None:
        assert set(ALLOWED_TRANSITIONS.keys()) == set(TaskColumn)

    def test_blocked_reachable_from_all_active(self) -> None:
        # BLOCKED は escalation 用なので全 active 状態から遷移可能
        for src in (TaskColumn.TODO, TaskColumn.IN_PROGRESS, TaskColumn.REVIEW):
            assert TaskColumn.BLOCKED in ALLOWED_TRANSITIONS[src]

    def test_done_is_terminal_except_reopen(self) -> None:
        # DONE は REVIEW (re-open) のみ
        assert ALLOWED_TRANSITIONS[TaskColumn.DONE] == frozenset({TaskColumn.REVIEW})


@pytest.mark.unit
class TestCanTransition:
    @pytest.mark.parametrize(
        ("src", "dst", "expected"),
        [
            (TaskColumn.TODO, TaskColumn.IN_PROGRESS, True),
            (TaskColumn.IN_PROGRESS, TaskColumn.REVIEW, True),
            (TaskColumn.REVIEW, TaskColumn.DONE, True),
            (TaskColumn.DONE, TaskColumn.REVIEW, True),
            (TaskColumn.TODO, TaskColumn.DONE, False),  # skip
            (TaskColumn.TODO, TaskColumn.REVIEW, False),
            (TaskColumn.DONE, TaskColumn.TODO, False),
            (TaskColumn.TODO, TaskColumn.TODO, False),  # same column
        ],
    )
    def test_matrix(self, src: TaskColumn, dst: TaskColumn, expected: bool) -> None:
        assert can_transition(src, dst) is expected


# ─────────────────────────────────────────────────────────
# KanbanTools.move
# ─────────────────────────────────────────────────────────
@pytest.mark.unit
class TestMove:
    @pytest.mark.asyncio
    async def test_happy_path(self) -> None:
        repo = FakeRepo([_task()])
        tools = KanbanTools(repo)
        saved = await tools.move("T-1", to_column=TaskColumn.IN_PROGRESS, actor_id="tony")
        assert saved.column == TaskColumn.IN_PROGRESS
        assert len(repo.moves) == 1
        assert repo.moves[0].from_column == TaskColumn.TODO
        assert repo.moves[0].actor_id == "tony"

    @pytest.mark.asyncio
    async def test_missing_task_raises_lookup(self) -> None:
        tools = KanbanTools(FakeRepo([]))
        with pytest.raises(LookupError, match="not found"):
            await tools.move("missing", to_column=TaskColumn.IN_PROGRESS, actor_id="tony")

    @pytest.mark.asyncio
    async def test_disallowed_transition_raises(self) -> None:
        tools = KanbanTools(FakeRepo([_task(TaskColumn.TODO)]))
        with pytest.raises(TransitionError, match="not allowed"):
            await tools.move("T-1", to_column=TaskColumn.DONE, actor_id="tony")

    @pytest.mark.asyncio
    async def test_same_column_rejected(self) -> None:
        tools = KanbanTools(FakeRepo([_task(TaskColumn.TODO)]))
        with pytest.raises(TransitionError):
            await tools.move("T-1", to_column=TaskColumn.TODO, actor_id="tony")

    @pytest.mark.asyncio
    async def test_empty_actor_rejected(self) -> None:
        tools = KanbanTools(FakeRepo([_task()]))
        with pytest.raises(ValueError, match="actor_id"):
            await tools.move("T-1", to_column=TaskColumn.IN_PROGRESS, actor_id="")

    @pytest.mark.asyncio
    async def test_move_to_non_blocked_clears_blocker_reason(self) -> None:
        # 過去に BLOCKED だった task が再開された後の move では blocker_reason はクリアされている想定
        repo = FakeRepo([_task(TaskColumn.TODO, blocker="x")])
        tools = KanbanTools(repo)
        saved = await tools.move("T-1", to_column=TaskColumn.IN_PROGRESS, actor_id="tony")
        assert saved.blocker_reason is None

    @pytest.mark.asyncio
    async def test_input_task_not_mutated(self) -> None:
        original = _task(TaskColumn.TODO)
        repo = FakeRepo([original])
        tools = KanbanTools(repo)
        await tools.move("T-1", to_column=TaskColumn.IN_PROGRESS, actor_id="tony")
        # 元の dataclass は frozen で変更不可
        assert original.column == TaskColumn.TODO


# ─────────────────────────────────────────────────────────
# KanbanTools.assign
# ─────────────────────────────────────────────────────────
@pytest.mark.unit
class TestAssign:
    @pytest.mark.asyncio
    async def test_assign_user(self) -> None:
        tools = KanbanTools(FakeRepo([_task()]))
        saved = await tools.assign("T-1", assignee_id="thor")
        assert saved.assignee_id == "thor"

    @pytest.mark.asyncio
    async def test_unassign(self) -> None:
        tools = KanbanTools(FakeRepo([_task(assignee="thor")]))
        saved = await tools.assign("T-1", assignee_id=None)
        assert saved.assignee_id is None

    @pytest.mark.asyncio
    async def test_missing_task(self) -> None:
        tools = KanbanTools(FakeRepo([]))
        with pytest.raises(LookupError):
            await tools.assign("missing", assignee_id="x")


# ─────────────────────────────────────────────────────────
# KanbanTools.block / unblock
# ─────────────────────────────────────────────────────────
@pytest.mark.unit
class TestBlock:
    @pytest.mark.asyncio
    async def test_block_from_in_progress(self) -> None:
        repo = FakeRepo([_task(TaskColumn.IN_PROGRESS)])
        tools = KanbanTools(repo)
        saved = await tools.block("T-1", reason="waiting for spec", actor_id="tony")
        assert saved.column == TaskColumn.BLOCKED
        assert saved.blocker_reason == "waiting for spec"
        assert len(repo.moves) == 1

    @pytest.mark.asyncio
    async def test_empty_reason_rejected(self) -> None:
        tools = KanbanTools(FakeRepo([_task()]))
        with pytest.raises(ValueError, match="reason"):
            await tools.block("T-1", reason="", actor_id="tony")

    @pytest.mark.asyncio
    async def test_missing_task(self) -> None:
        tools = KanbanTools(FakeRepo([]))
        with pytest.raises(LookupError):
            await tools.block("missing", reason="x", actor_id="tony")

    @pytest.mark.asyncio
    async def test_cannot_block_from_done(self) -> None:
        # DONE は BLOCKED に遷移できない (state machine)
        tools = KanbanTools(FakeRepo([_task(TaskColumn.DONE)]))
        with pytest.raises(TransitionError, match="cannot block"):
            await tools.block("T-1", reason="x", actor_id="tony")


@pytest.mark.unit
class TestUnblock:
    @pytest.mark.asyncio
    async def test_unblock_to_in_progress(self) -> None:
        repo = FakeRepo([_task(TaskColumn.BLOCKED, blocker="x")])
        tools = KanbanTools(repo)
        saved = await tools.unblock(
            "T-1",
            to_column=TaskColumn.IN_PROGRESS,
            actor_id="tony",
        )
        assert saved.column == TaskColumn.IN_PROGRESS
        assert saved.blocker_reason is None
        assert len(repo.moves) == 1

    @pytest.mark.asyncio
    async def test_not_blocked_rejected(self) -> None:
        tools = KanbanTools(FakeRepo([_task(TaskColumn.IN_PROGRESS)]))
        with pytest.raises(TransitionError, match="BLOCKED state"):
            await tools.unblock(
                "T-1",
                to_column=TaskColumn.REVIEW,
                actor_id="tony",
            )

    @pytest.mark.asyncio
    async def test_unblock_to_invalid_target(self) -> None:
        # BLOCKED から DONE への直接遷移は不許可
        tools = KanbanTools(FakeRepo([_task(TaskColumn.BLOCKED, blocker="x")]))
        with pytest.raises(TransitionError, match="not allowed"):
            await tools.unblock(
                "T-1",
                to_column=TaskColumn.DONE,
                actor_id="tony",
            )

    @pytest.mark.asyncio
    async def test_missing_task(self) -> None:
        tools = KanbanTools(FakeRepo([]))
        with pytest.raises(LookupError):
            await tools.unblock(
                "missing",
                to_column=TaskColumn.TODO,
                actor_id="tony",
            )
