"""GAP-202: 押し出しにしたあと、同時に待たせられる人数を実測する。

GAP-201 の上限 150 本/台 は「0.25 秒ごとに聞きに行く負荷」で決めた数字だった。
その負荷が消えたので、**新しい上限を推測ではなく測って決める**。

測るもの (待っている人が N 人いる状態で):
  ① 1 人あたりの実メモリ増
  ② その中の 1 人へ通知が届くまでの時間 (= 画面に文字が出る速さ)
     … 配達は待っている人数ぶんの登録を舐めるので、増えると遅くなるはず
  ③ 待っている間の DB 接続 (0 のままか)
"""

import asyncio
import os
import resource
import sys
import time
import uuid

sys.path.insert(0, "/home/user/Atelier/apps/api")
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "x")
os.environ["ATELIER_DB_URL"] = "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
from sqlalchemy import text

from src.db import notify as db_notify
from src.db.session import DatabaseSettings, create_engine, create_session_factory, pool_stats


def rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


async def waiter(notifier, job_id, stop):
    """1 人の「待っている人」。動きが無いので何もせず寝続ける。"""
    with notifier.subscribe(job_id) as wake:
        wake.clear()
        while not stop.is_set():
            await notifier.wait(wake, timeout=0.2)


async def run(n: int) -> None:
    settings = DatabaseSettings(url=os.environ["ATELIER_DB_URL"])
    eng = create_engine(settings)
    factory = create_session_factory(eng)
    notifier = db_notify.JobNotifier(dsn=db_notify.listen_dsn(settings))
    assert await notifier.start(), "LISTEN 接続が張れなかった"

    base = rss_mb()
    stop = asyncio.Event()
    tasks = [asyncio.create_task(waiter(notifier, str(uuid.uuid4()), stop)) for _ in range(n)]
    await asyncio.sleep(1.0)  # 全員が待ちに入るのを待つ
    mem = rss_mb() - base
    peak_conn = pool_stats(eng).checked_out

    # N 人が待っている中で、特定の 1 人への配達がどれだけ速いか
    target = str(uuid.uuid4())
    samples = []
    with notifier.subscribe(target) as wake:
        wake.clear()
        for _ in range(20):
            t0 = time.perf_counter()
            async with factory() as s:
                await s.execute(
                    text("select pg_notify(:c, :p)"), {"c": db_notify.CHANNEL, "p": target}
                )
                await s.commit()
            ok = await notifier.wait(wake, timeout=10.0)
            assert ok, f"{n} 人待機中に通知が届かなかった"
            samples.append((time.perf_counter() - t0) * 1000)

    stop.set()
    await notifier.close()
    await asyncio.gather(*tasks, return_exceptions=True)
    await eng.dispose()

    samples.sort()
    p95 = samples[int(len(samples) * 0.95)]
    per_user_kb = (mem * 1024 / n) if n else 0
    print(
        f"  同時 {n:5d} 人待機 : メモリ増 {mem:6.1f} MB "
        f"({per_user_kb:5.1f} KB/人)  配達 p95 {p95:6.2f} ms  "
        f"待機中の DB 接続 {peak_conn}/30"
    )


async def steady_state(n: int, seconds: float) -> None:
    """**本番の設定のまま**放置して、待機中に実際に投げるクエリ数を数える。

    押し出しにしたあと待機中に残る DB 負荷は「保険の再確認」だけ。
    それが本当に想定どおりの頻度かを、推測せず数える。
    """
    settings = DatabaseSettings(url=os.environ["ATELIER_DB_URL"])
    eng = create_engine(settings)
    factory = create_session_factory(eng)
    notifier = db_notify.JobNotifier(dsn=db_notify.listen_dsn(settings))
    assert await notifier.start()

    stop = asyncio.Event()
    counter = [0]

    async def real_waiter(job_id: str) -> None:
        """本番と同じ形: 起きたら 3 クエリ読んで、また寝る。"""
        with notifier.subscribe(job_id) as wake:
            wake.clear()
            while not stop.is_set():
                await notifier.wait(wake)  # 本番の間隔をそのまま使う
                if stop.is_set():
                    break
                async with factory() as s:
                    await s.execute(text("select 1"))
                    await s.execute(text("select 1"))
                    await s.execute(text("select 1"))
                counter[0] += 1

    tasks = [asyncio.create_task(real_waiter(str(uuid.uuid4()))) for _ in range(n)]
    await asyncio.sleep(seconds)
    during = counter[0]
    stop.set()
    await notifier.close()
    await asyncio.gather(*tasks, return_exceptions=True)
    await eng.dispose()

    qps = during * 3 / seconds
    print(
        f"  同時 {n:5d} 人が {seconds:.0f} 秒待機 : DB クエリ {during * 3:6d} 回 "
        f"= {qps:6.1f} 回/秒  (保険の再確認 {db_notify.HEALTHY_RECHECK_SECONDS:.0f} 秒ごと)"
    )


async def main() -> None:
    print("押し出しにしたあとの同時待機人数 (1 プロセス)")
    for n in (150, 300, 1000, 2000, 5000, 10000):
        await run(n)

    print()
    print("本番設定のまま放置したときの待機中 DB 負荷")
    for n in (1000, 2000):
        await steady_state(n, 35.0)


asyncio.run(main())
