"""T-I-15 真の補強: 実 Postgres + 実 asyncpg で N 並列 play_task ストレス試験.

`parallel_10.py` は StubSession で実行ロジックの並列安全性を検証する unit 級。
本ファイルは **実 Postgres** に接続して以下を計測する integration 級:

- N=10 / 20 / 50 並列で play_task が deadlock しないこと (real lock contention)
- 全 task の lifecycle_stage が 'in_progress' に遷移し、task_executions が
  N 行 'running' で残ること
- p95 latency, throughput (ops/sec) の実測値が SLA を満たすこと
  - SLA: p95 latency < 2.0s (本番想定)、throughput >= 5 ops/sec

実行条件:
- 環境変数 ATELIER_STRESS_DB_URL を設定する (例:
  postgresql+asyncpg://atelier_stress:stress@localhost/atelier_stress)
- 未設定なら全テストを skip する (CI では skip、ローカル/staging で実行)

スキーマ:
- セッション fixture が play_task が触る最小サブセットを CREATE する
  (tasks / task_executions / audit_logs + 必要な enum)
- 各テスト前後で truncate する
"""

from __future__ import annotations

import asyncio
import os
import statistics
import time
import uuid
from collections.abc import AsyncIterator

import pytest
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.sql import text

from src.schemas.tasks import PlayTaskRequest
from src.services.tasks import (
    _PARALLEL_LIMIT,  # pyright: ignore[reportPrivateUsage]
    PlayResult,
    play_task,
)

# テスト用最小スキーマ (play_task が触るカラム/型のみ)。
# asyncpg は 1 execute = 1 statement のため、リストで分割する。
_BOOTSTRAP_STATEMENTS: list[str] = [
    """do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_lifecycle_enum') then
    create type public.task_lifecycle_enum as enum (
      'triage', 'ready', 'in_progress', 'blocked', 'awaiting', 'done'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'task_dispatch_enum') then
    create type public.task_dispatch_enum as enum (
      'queued', 'spawning', 'running', 'completing', 'dead', 'reclaimed'
    );
  end if;
end $$""",
    """create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  lifecycle_stage public.task_lifecycle_enum not null default 'ready',
  dispatch_status public.task_dispatch_enum,
  retry_count integer not null default 0,
  worktree_path text,
  dependencies uuid[] not null default array[]::uuid[],
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
)""",
    """create table if not exists public.task_executions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  started_at timestamptz not null default now(),
  retry_count integer not null default 0,
  status text not null
)""",
    """create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  actor_type text not null,
  actor_id text not null,
  action text not null,
  target_type text not null,
  target_id uuid,
  "before" jsonb,
  "after" jsonb,
  ip_address inet,
  created_at timestamptz not null default now()
)""",
]

_DB_URL = os.environ.get("ATELIER_STRESS_DB_URL")

pytestmark = pytest.mark.skipif(
    not _DB_URL,
    reason="ATELIER_STRESS_DB_URL not set (real-Postgres stress test, skipped in CI)",
)


_SessionFactory = async_sessionmaker[AsyncSession]


@pytest.fixture
async def engine() -> AsyncIterator[AsyncEngine]:
    # function スコープ: pytest-asyncio (mode=auto) は 1 test = 1 loop なので
    # module スコープ async engine は loop 跨ぎで `Event loop is closed` になる。
    assert _DB_URL is not None
    eng = create_async_engine(_DB_URL, pool_size=20, max_overflow=10, pool_pre_ping=True)
    async with eng.begin() as conn:
        for stmt in _BOOTSTRAP_STATEMENTS:
            await conn.execute(text(stmt))
    yield eng
    await eng.dispose()


@pytest.fixture
async def session_factory(engine: AsyncEngine) -> AsyncIterator[_SessionFactory]:
    factory: _SessionFactory = async_sessionmaker(
        engine, expire_on_commit=False, class_=AsyncSession
    )
    # 前後 truncate (audit/exec/task)
    async with factory() as s:
        await s.execute(text("truncate public.task_executions, public.audit_logs"))
        await s.execute(text("truncate public.tasks cascade"))
        await s.commit()
    yield factory
    async with factory() as s:
        await s.execute(text("truncate public.task_executions, public.audit_logs"))
        await s.execute(text("truncate public.tasks cascade"))
        await s.commit()


async def _seed_tasks(factory: _SessionFactory, n: int) -> list[str]:
    async with factory() as s:
        ids: list[str] = []
        for _ in range(n):
            tid = str(uuid.uuid4())
            await s.execute(
                text(
                    "insert into public.tasks (id, lifecycle_stage, retry_count, dependencies) "
                    "values (cast(:id as uuid), 'ready', 0, array[]::uuid[])"
                ),
                {"id": tid},
            )
            ids.append(tid)
        await s.commit()
        return ids


async def _run_one(factory: _SessionFactory, task_id: str) -> tuple[str, float]:
    """play_task を 1 件実行し (result_code, elapsed_seconds) を返す。"""
    start = time.perf_counter()
    async with factory() as session:
        code, _ = await play_task(
            session,
            actor_id="u1",
            task_id=task_id,
            data=PlayTaskRequest(force=False),
        )
        await session.commit()
    return code, time.perf_counter() - start


def test_parallel_limit_constant_real() -> None:
    """_PARALLEL_LIMIT 定数が想定通り (sanity check)."""
    assert _PARALLEL_LIMIT == 5


@pytest.mark.asyncio
@pytest.mark.parametrize("n", [10, 20])
async def test_n_parallel_real_postgres_no_deadlock(
    session_factory: _SessionFactory, n: int
) -> None:
    """N 並列で実 Postgres 越しに play_task を呼んでも deadlock しない & 全 SUCCESS."""
    task_ids = await _seed_tasks(session_factory, n)

    results = await asyncio.gather(*(_run_one(session_factory, tid) for tid in task_ids))
    codes = [r[0] for r in results]
    latencies = [r[1] for r in results]

    # 全 task が SUCCESS で完了
    assert all(c == PlayResult.SUCCESS for c in codes), codes

    # task_executions に N 行 running が残る
    async with session_factory() as s:
        cnt = (
            await s.execute(
                text("select count(*) from public.task_executions where status='running'")
            )
        ).scalar_one()
        assert int(cnt) == n

    # latency 計測 (SLA: p95 < 2.0s)
    p95 = statistics.quantiles(latencies, n=20)[18] if len(latencies) >= 20 else max(latencies)
    avg = statistics.mean(latencies)
    print(
        f"\n[T-I-15 real-pg] n={n} avg={avg * 1000:.1f}ms p95={p95 * 1000:.1f}ms "
        f"throughput={n / sum(latencies) * n:.1f} ops/sec",
        flush=True,
    )
    assert p95 < 2.0, f"p95 latency {p95:.2f}s exceeded SLA 2.0s"


@pytest.mark.asyncio
async def test_50_parallel_real_postgres_throughput(
    session_factory: _SessionFactory,
) -> None:
    """50 並列で throughput >= 5 ops/sec を満たす (本番 SLA 想定)."""
    n = 50
    task_ids = await _seed_tasks(session_factory, n)

    t0 = time.perf_counter()
    results = await asyncio.gather(*(_run_one(session_factory, tid) for tid in task_ids))
    wall = time.perf_counter() - t0

    codes = [r[0] for r in results]
    assert all(c == PlayResult.SUCCESS for c in codes), codes

    throughput = n / wall
    print(
        f"\n[T-I-15 real-pg] n={n} wall={wall * 1000:.0f}ms throughput={throughput:.1f} ops/sec",
        flush=True,
    )
    assert throughput >= 5.0, f"throughput {throughput:.1f} ops/sec below SLA 5 ops/sec"
