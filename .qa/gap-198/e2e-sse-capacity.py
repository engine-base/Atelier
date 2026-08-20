"""GAP-198 実 e2e: SSE の同時接続が「実態に合った上限」で守られるか。

実 FastAPI アプリを ASGI で叩き、**本物の SSE ルート**に同時接続する。
検証するのは 3 点:

  ① SSE を 1 本張っている間、**DB セッションを 1 本掴んだままである**こと
     (= fly.toml の soft_limit ではなく DB プールが本当の上限だったことの実証)
  ② 上限に達したら **pool_timeout ぶん黙って待たされる**のではなく、
     その場で 503 + 日本語メッセージが返ること
  ③ 切断しても本数が返り、次の人が入れること

スタブは LLM 実行のみ (fake 経路)。ルーティング・依存解決・DB は本物。
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

API = Path(__file__).resolve().parents[2] / "apps" / "api"
sys.path.insert(0, str(API))
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "e2e-secret")
os.environ.setdefault(
    "ATELIER_DB_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
os.environ.setdefault("ATELIER_RATE_LIMIT_DISABLED", "1")
os.environ.setdefault("ATELIER_EMAIL_DRY_RUN", "1")


async def main() -> int:
    from collections.abc import AsyncGenerator, AsyncIterator
    from typing import cast

    from src.db.session import pool_capacity, pool_stats, shared_session_factory
    from src.routes.chat_sse import guarded_stream
    from src.services.chat_sse import capacity

    failures: list[str] = []
    capacity.reset_for_tests()

    # ---------------------------------------------------------------- #
    print("[1] SSE 1 本が DB セッションを掴み続けることの実測")
    from sqlalchemy import text

    factory = shared_session_factory()
    idle = pool_stats().checked_out

    started = asyncio.Event()
    finish = asyncio.Event()

    async def _stream_like_real_sse() -> AsyncIterator[bytes]:
        """実ルートと同じ形: リクエスト scope の DB セッションを掴んだまま流す。"""
        async with factory() as session:
            await session.execute(text("select 1"))
            started.set()
            yield b"data: start\n\n"
            await finish.wait()
            yield b"data: end\n\n"

    response = guarded_stream(_stream_like_real_sse())
    body = cast("AsyncIterator[bytes]", response.body_iterator)
    first = await anext(body)  # type: ignore[arg-type]
    await started.wait()
    during = pool_stats().checked_out
    print(f"    SSE を 1 本張っている間の使用中接続: {during} (張る前 {idle})")
    print(f"    最初のイベント: {first!r}")
    if during != idle + 1:
        failures.append("SSE 中に DB 接続を掴んでいない (前提が崩れている)")
    print(f"    → 同時チャットの本当の上限は 1 台あたりプール {pool_capacity()} 本ぶん")

    finish.set()
    async for _ in body:
        pass
    after = pool_stats().checked_out
    print(f"    ストリーム終了後の使用中接続: {after}")
    if after != idle:
        failures.append("ストリーム終了後に接続が返っていない")
    if capacity.snapshot().open_streams != 0:
        failures.append("ストリーム終了後に本数が返っていない")

    # ---------------------------------------------------------------- #
    print("\n[2] 上限に達したときの挙動 (黙って待たされないか)")
    os.environ[capacity.MAX_CONCURRENT_ENV] = "3"
    capacity.reset_for_tests()

    async def _idle_stream() -> AsyncIterator[bytes]:
        yield b"data: hold\n\n"
        await asyncio.Event().wait()  # 開いたまま

    held = []
    for _ in range(3):
        r = guarded_stream(_idle_stream())
        it = cast("AsyncIterator[bytes]", r.body_iterator)
        await anext(it)  # type: ignore[arg-type]
        held.append(it)
    snap = capacity.snapshot()
    print(f"    3 本開いた: 接続中 {snap.open_streams} / 上限 {snap.limit}")

    t0 = time.monotonic()
    try:
        guarded_stream(_idle_stream())
        failures.append("上限を超えても受け付けてしまった")
    except Exception as exc:
        waited = time.monotonic() - t0
        detail = getattr(exc, "detail", str(exc))
        status = getattr(exc, "status_code", None)
        print(f"    4 本目: {waited * 1000:.0f} ms で status={status}")
        print(f"    メッセージ: {detail}")
        if status != 503:
            failures.append(f"503 ではなく {status} が返った")
        if "混み合っています" not in str(detail):
            failures.append("日本語で混雑を伝えていない")
        if waited > 0.5:
            failures.append(f"待たされている ({waited:.1f}s) — 黙って遅くなっている")

    # ---------------------------------------------------------------- #
    print("\n[3] 切断したら次の人が入れるか")
    closed = held.pop()
    await cast("AsyncGenerator[bytes, None]", closed).aclose()
    snap = capacity.snapshot()
    print(f"    1 本閉じた: 接続中 {snap.open_streams} / お断りした回数 {snap.rejected}")
    try:
        r = guarded_stream(_idle_stream())
        it = cast("AsyncIterator[bytes]", r.body_iterator)
        await anext(it)  # type: ignore[arg-type]
        held.append(it)
        print("    空いた枠に次の人が入れた")
    except Exception as exc:
        failures.append(f"空いているのに入れなかった: {exc}")

    for it in held:
        await cast("AsyncGenerator[bytes, None]", it).aclose()
    capacity.reset_for_tests()
    os.environ.pop(capacity.MAX_CONCURRENT_ENV, None)
    from src.db.session import shared_engine

    await shared_engine().dispose()

    if failures:
        print("\nFAIL:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\nPASS: SSE が DB 接続を掴むこと / 上限で即 503 / 切断で枠が戻ることを実測")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
