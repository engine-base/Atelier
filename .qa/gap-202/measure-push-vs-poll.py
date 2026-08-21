"""GAP-202: 「聞きに行く」と「知らせてもらう」を同じ条件で比べる実測。

GAP-201 で測ったのは **聞きに行く方式**（0.25 秒ごとに 3 クエリ）で、
待っている人数がそのままサーバー負荷になっていた。ここでは同じ待機人数で

  ① 旧: 0.25 秒ごとに 3 クエリ投げ続ける（GAP-201 と同じもの）
  ② 新: 通知を待って寝る（動きがあったときだけ起きる）

を走らせ、**待っている 5 秒間に DB へ投げたクエリ数**と**接続の使用量**を測る。

さらに「通知が実際に届くまでの時間」も測る（＝画面に文字が出るまでの速さ）。
聞きに行く方式は平均で間隔の半分（約 125ms）遅れるので、押し出しの方が速い
はずで、それも数字で確かめる。
"""

import asyncio
import os
import sys
import time
import uuid

sys.path.insert(0, "/home/user/Atelier/apps/api")
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "x")
os.environ["ATELIER_DB_URL"] = "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
from sqlalchemy import text

from src.db import notify as db_notify
from src.db.session import DatabaseSettings, create_engine, create_session_factory, pool_stats

WINDOW_SECONDS = 5.0
OLD_POLL_SECONDS = 0.25


async def _old_waiter(factory, stop, counter, lat):
    """旧方式: 起きて 3 クエリ投げて、また寝る。"""
    while not stop.is_set():
        await asyncio.sleep(OLD_POLL_SECONDS)
        t0 = time.perf_counter()
        async with factory() as s:
            await s.execute(text("select 1"))
            await s.execute(text("select 1"))
            await s.execute(text("select 1"))
        lat.append((time.perf_counter() - t0) * 1000)
        counter[0] += 1


async def _new_waiter(notifier, factory, job_id, stop, counter, lat):
    """新方式: 通知が来たときだけ 3 クエリ投げる。"""
    with notifier.subscribe(job_id) as wake:
        wake.clear()  # 購読直後の「1 回目は待たない」ぶんを除く
        while not stop.is_set():
            woke = await notifier.wait(wake, timeout=0.2)
            if not woke:
                continue  # 保険の再確認 (この計測窓では動きが無いので何もしない)
            t0 = time.perf_counter()
            async with factory() as s:
                await s.execute(text("select 1"))
                await s.execute(text("select 1"))
                await s.execute(text("select 1"))
            lat.append((time.perf_counter() - t0) * 1000)
            counter[0] += 1


async def measure(mode: str, n: int) -> None:
    eng = create_engine(
        DatabaseSettings(url=os.environ["ATELIER_DB_URL"], pool_size=20, max_overflow=10)
    )
    factory = create_session_factory(eng)
    notifier = None
    stop, counter, lat = asyncio.Event(), [0], []

    if mode == "old":
        tasks = [asyncio.create_task(_old_waiter(factory, stop, counter, lat)) for _ in range(n)]
    else:
        notifier = db_notify.JobNotifier(
            dsn=db_notify.listen_dsn(DatabaseSettings(url=os.environ["ATELIER_DB_URL"]))
        )
        assert await notifier.start(), "LISTEN 接続が張れなかった"
        tasks = [
            asyncio.create_task(
                _new_waiter(notifier, factory, str(uuid.uuid4()), stop, counter, lat)
            )
            for _ in range(n)
        ]

    await asyncio.sleep(WINDOW_SECONDS)
    peak = pool_stats(eng).checked_out
    # **窓の中だけ**を数える。この後の後片付けで全員を起こすので、
    # そこを含めると新方式が実際より多く見える (正直な比較にならない)。
    during_window = counter[0]
    stop.set()
    if notifier is not None:
        # 待っている全員を起こして終わらせる
        await notifier.close()
    await asyncio.gather(*tasks, return_exceptions=True)

    queries = during_window * 3
    label = "旧 聞きに行く" if mode == "old" else "新 知らせてもらう"
    print(
        f"  {label:>8s} / 同時 {n:4d} 本待機 : "
        f"{WINDOW_SECONDS:.0f} 秒間の DB クエリ {queries:7d} 回  "
        f"ピーク接続 {peak:2d}/30"
    )
    await eng.dispose()


async def measure_delivery_latency(rounds: int = 30) -> None:
    """通知が届くまでの時間（＝画面に文字が出るまでの速さ）。"""
    settings = DatabaseSettings(url=os.environ["ATELIER_DB_URL"])
    eng = create_engine(settings)
    factory = create_session_factory(eng)
    notifier = db_notify.JobNotifier(dsn=db_notify.listen_dsn(settings))
    assert await notifier.start()

    samples = []
    job_id = str(uuid.uuid4())
    with notifier.subscribe(job_id) as wake:
        wake.clear()
        for _ in range(rounds):
            t0 = time.perf_counter()
            async with factory() as s:
                await s.execute(
                    text("select pg_notify(:c, :p)"),
                    {"c": db_notify.CHANNEL, "p": job_id},
                )
                await s.commit()
            assert await notifier.wait(wake, timeout=5.0), "通知が届かなかった"
            samples.append((time.perf_counter() - t0) * 1000)

    samples.sort()
    p50 = samples[len(samples) // 2]
    p95 = samples[int(len(samples) * 0.95)]
    print(
        f"  通知が届くまで : p50 {p50:5.1f} ms / p95 {p95:5.1f} ms  ({rounds} 回)\n"
        f"  （旧方式は 0.25 秒ごとに見に行くので、平均で約 125 ms 遅れて気づく）"
    )
    await notifier.close()
    await eng.dispose()


async def main() -> None:
    print("[1] 待っている 5 秒間に DB へ投げたクエリ数")
    for n in (50, 100, 150, 200, 400):
        await measure("old", n)
        await measure("new", n)
        print()

    print("[2] 押し出しの速さ")
    await measure_delivery_latency()


asyncio.run(main())
