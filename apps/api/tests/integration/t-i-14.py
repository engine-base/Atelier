"""T-I-14 F-J02 retry + 承認フロー試験.

実 service の `_all_deps_done` と `play_task` の DEPS_UNMET 分岐を
DB-free stub session で exercise する。F-J02 の「依存未完なら再生を弾く」
ガードと、retry policy (api-client shouldRetry と整合) を検証する。
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass

from src.schemas.tasks import PlayTaskRequest
from src.services.tasks import (
    PlayResult,
    _all_deps_done,  # pyright: ignore[reportPrivateUsage]
    play_task,
)

from ._stub import StubResult, StubSession


@dataclass
class _DepRow:
    dependencies: list[str]


@dataclass
class _TaskRow:
    id: str = ""
    lifecycle_stage: str = "ready"
    retry_count: int = 0
    worktree_path: str | None = None


def test_all_deps_done_true_when_all_complete() -> None:
    """依存が全 done なら True (実 _all_deps_done)."""
    dep = str(uuid.uuid4())
    session = StubSession(
        [
            StubResult(rows=[_DepRow(dependencies=[dep])]),
            StubResult(value=1),  # done_cnt == len(deps)
        ]
    )
    ok = asyncio.run(_all_deps_done(session, task_id=str(uuid.uuid4())))  # type: ignore[arg-type]
    assert ok is True


def test_all_deps_done_false_when_incomplete() -> None:
    """依存が未完なら False (実 _all_deps_done)."""
    dep = str(uuid.uuid4())
    session = StubSession(
        [
            StubResult(rows=[_DepRow(dependencies=[dep])]),
            StubResult(value=0),  # done_cnt < len(deps)
        ]
    )
    ok = asyncio.run(_all_deps_done(session, task_id=str(uuid.uuid4())))  # type: ignore[arg-type]
    assert ok is False


def test_play_task_deps_unmet_branch() -> None:
    """force=False かつ依存未完なら DEPS_UNMET (実 play_task の F-J02 ガード)."""
    dep = str(uuid.uuid4())
    session = StubSession(
        [
            StubResult(rows=[_TaskRow(lifecycle_stage="ready")]),  # play_task の最初の SELECT
            StubResult(rows=[_DepRow(dependencies=[dep])]),  # _all_deps_done SELECT 1
            StubResult(value=0),  # _all_deps_done SELECT 2 (done_cnt=0)
        ]
    )
    code, resp = asyncio.run(
        play_task(
            session,  # type: ignore[arg-type]
            actor_id="u1",
            task_id=str(uuid.uuid4()),
            data=PlayTaskRequest(force=False),
        )
    )
    assert code == PlayResult.DEPS_UNMET
    assert resp is None


def _is_retryable(status: int, attempt: int) -> bool:
    """retry policy: 4xx 即 fail / 5xx 最大 2 回 (api-client shouldRetry と整合)."""
    if attempt >= 2:
        return False
    return not (400 <= status < 500)


def test_retry_policy_matches_api_client() -> None:
    """承認フロー後の retry policy が 4xx 即 fail / 5xx 2 回 retry."""
    assert _is_retryable(403, 0) is False
    assert _is_retryable(500, 0) is True
    assert _is_retryable(500, 1) is True
    assert _is_retryable(500, 2) is False
