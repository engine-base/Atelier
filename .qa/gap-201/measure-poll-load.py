"""GAP-201: 待機中のポーリングが DB をどれだけ使うかの実測（SSE 上限の根拠）。"""

import asyncio
import os
import sys
import time

sys.path.insert(0, "/home/user/Atelier/apps/api")
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "x")
os.environ["ATELIER_DB_URL"] = "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
from sqlalchemy import text

from src.db.session import DatabaseSettings, create_engine, create_session_factory, pool_stats

POLL = 0.25


async def poller(factory, stop, counter, lat):
    while not stop.is_set():
        await asyncio.sleep(POLL)
        t0 = time.perf_counter()
        async with factory() as s:
            await s.execute(text("select 1"))
            await s.execute(text("select 1"))
            await s.execute(text("select 1"))
        lat.append((time.perf_counter() - t0) * 1000)
        counter[0] += 1


async def run(n):
    eng = create_engine(
        DatabaseSettings(url=os.environ["ATELIER_DB_URL"], pool_size=20, max_overflow=10)
    )
    factory = create_session_factory(eng)
    stop, counter, lat = asyncio.Event(), [0], []
    tasks = [asyncio.create_task(poller(factory, stop, counter, lat)) for _ in range(n)]
    await asyncio.sleep(5)
    peak = pool_stats(eng).checked_out
    stop.set()
    await asyncio.gather(*tasks, return_exceptions=True)
    lat.sort()
    p95 = lat[int(len(lat) * 0.95)] if lat else 0
    print(
        f"  同時 {n:4d} 本待機 : {counter[0] / 5:6.0f} クエリ束/秒  "
        f"1 回 p95 {p95:6.1f} ms  ピーク接続 {peak}/30"
    )
    await eng.dispose()


async def main():
    for n in (50, 100, 150, 200, 400):
        await run(n)


asyncio.run(main())
