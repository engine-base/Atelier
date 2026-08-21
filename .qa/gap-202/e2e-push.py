"""GAP-202 実 e2e: 実 Postgres で「押し出し」が本当に成立しているかを測る。

やること（すべて実物 — フェイクなし）:
  1. 実 DB に実ジョブを作り、**本物の relay_stream_chunks** を走らせる
  2. Bridge の代わりに実テーブルへ書き込み、**画面に届くまでの時間**を測る
     （旧方式は 0.25 秒ごとに見に行くので平均 125ms 遅れる。押し出しなら数ms）
  3. その間 **DB を一度も叩いていない** ことを、実クエリ数を数えて確かめる
  4. 待ち受けを **強制的に切って** も、保険の再確認で止まらないことを確かめる
  5. 承認カード（PC 操作）も押し出しで届くことを確かめる
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "apps" / "api"))
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "e2e")
os.environ.setdefault(
    "ATELIER_DB_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)

from sqlalchemy import event, text

from src.db import notify as db_notify
from src.db.session import (
    DatabaseSettings,
    create_engine,
    create_session_factory,
)

failures: list[str] = []


def check(ok: bool, label: str) -> None:
    print(f"  {'OK  ' if ok else 'NG  '} {label}")
    if not ok:
        failures.append(label)


SETTINGS = DatabaseSettings(url=os.environ["ATELIER_DB_URL"])


async def seed_job(factory) -> tuple[str, str]:
    """auth.users → users → job を実際に作る。"""
    user_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    async with factory() as s:
        await s.execute(
            text("insert into auth.users (id) values (cast(:u as uuid))"), {"u": user_id}
        )
        await s.execute(
            text("insert into public.users (id, email) values (cast(:u as uuid), :e)"),
            {"u": user_id, "e": f"{user_id}@example.test"},
        )
        await s.execute(
            text(
                "insert into public.chat_relay_jobs "
                "(id, requested_by, system_prompt, prompt, status) "
                "values (cast(:j as uuid), cast(:u as uuid), 'sys', 'p', 'running')"
            ),
            {"j": job_id, "u": user_id},
        )
        await s.commit()
    return user_id, job_id


async def write_chunk(factory, job_id: str, seq: int, content: str, kind: str = "delta") -> None:
    """Bridge の代わりに本文を 1 行書き込む（trigger が通知を出す経路）。"""
    async with factory() as s:
        await s.execute(
            text(
                "insert into public.chat_relay_chunks (job_id, seq, content, kind) "
                "values (cast(:j as uuid), :s, :c, :k)"
            ),
            {"j": job_id, "s": seq, "c": content, "k": kind},
        )
        await s.commit()


async def finish_job(factory, job_id: str) -> None:
    async with factory() as s:
        await s.execute(
            text("update public.chat_relay_jobs set status = 'done' where id = cast(:j as uuid)"),
            {"j": job_id},
        )
        await s.commit()


async def scenario_1_delivery_speed() -> None:
    print("[1] 本物の SSE ストリームで、書き込みが画面へ届くまでの時間")
    from src.services.chat_sse import relay as sse_relay

    engine = create_engine(SETTINGS)
    factory = create_session_factory(engine)

    # 実クエリを数える（待っている間ゼロであることを示す）
    queries: list[str] = []

    def _count(
        _conn: object,
        _cursor: object,
        statement: str,
        *_rest: object,
        **_kw: object,
    ) -> None:
        queries.append(statement.strip().replace("\n", " ")[:70])

    event.listen(engine.sync_engine, "before_cursor_execute", _count)

    _user_id, job_id = await seed_job(factory)
    notifier = db_notify.JobNotifier(dsn=db_notify.listen_dsn(SETTINGS))
    assert await notifier.start(), "LISTEN 接続が張れなかった"

    latencies: list[float] = []
    received: list[str] = []
    sent_at: list[float] = []

    async def reader() -> None:
        """本物の内部ループ（relay の押し出し待ち）をそのまま使う。"""
        with notifier.subscribe(job_id) as wake:
            async for ev in sse_relay._relay_events(
                notifier=notifier,
                wake=wake,
                factory=factory,
                job_id=job_id,
                tools_mode="off",
                timeout=60.0,
                deadline=asyncio.get_event_loop().time() + 60.0,
                last_seq=-1,
                seen_approvals={},
            ):
                if isinstance(ev, str):
                    received.append(ev)
                    latencies.append((time.perf_counter() - sent_at[-1]) * 1000)

    task = asyncio.create_task(reader())
    await asyncio.sleep(0.3)  # 待ちに入らせる

    idle_before = len(queries)
    await asyncio.sleep(2.0)  # **何も起きない 2 秒**
    idle = queries[idle_before:]
    for q in idle:
        print(f"     （待機中に流れたクエリ）{q}")
    check(len(idle) == 0, f"何も起きない 2 秒の間に投げた DB クエリ = {len(idle)} 回（0 が期待値）")

    for seq in range(5):
        sent_at.append(time.perf_counter())
        await write_chunk(factory, job_id, seq, f"文字{seq}")
        await asyncio.sleep(0.15)

    await finish_job(factory, job_id)
    await asyncio.wait_for(task, timeout=10.0)

    check(len(received) == 5, f"本文が 5 個とも届いた（実際 {len(received)} 個）")
    worst = max(latencies) if latencies else 999
    print(f"     届くまで: 最遅 {worst:.1f} ms / 平均 {sum(latencies) / len(latencies):.1f} ms")
    check(worst < 250.0, f"最遅でも 250ms 未満（旧方式の 1 回ぶんより速い） — 実測 {worst:.1f} ms")

    await notifier.close()
    await engine.dispose()


async def scenario_2_survives_listener_loss() -> None:
    print("\n[2] 待ち受けが切れても止まらない（保険の再確認）")
    from src.services.chat_sse import relay as sse_relay

    engine = create_engine(SETTINGS)
    factory = create_session_factory(engine)
    _user_id, job_id = await seed_job(factory)

    # わざと繋がらない待ち受けを使う ＝ 通知が一切来ない状況
    notifier = db_notify.JobNotifier(dsn="postgresql://nobody@127.0.0.1:1/none")
    started = await notifier.start()
    check(started is False, "壊れた設定でも例外にならず False を返す")
    check(notifier.connected is False, "繋がっていないと自覚している")
    check(
        notifier.recheck_interval() == db_notify.DEGRADED_RECHECK_SECONDS,
        f"従来のポーリング間隔（{db_notify.DEGRADED_RECHECK_SECONDS}s）へ戻っている",
    )

    received: list[str] = []

    async def reader() -> None:
        with notifier.subscribe(job_id) as wake:
            async for ev in sse_relay._relay_events(
                notifier=notifier,
                wake=wake,
                factory=factory,
                job_id=job_id,
                tools_mode="off",
                timeout=30.0,
                deadline=asyncio.get_event_loop().time() + 30.0,
                last_seq=-1,
                seen_approvals={},
            ):
                if isinstance(ev, str):
                    received.append(ev)

    task = asyncio.create_task(reader())
    await asyncio.sleep(0.3)
    await write_chunk(factory, job_id, 0, "通知なしでも届く")
    await finish_job(factory, job_id)
    await asyncio.wait_for(task, timeout=10.0)
    check(received == ["通知なしでも届く"], "通知が一切来なくても本文は届いた（止まらない）")

    await notifier.close()
    await engine.dispose()


async def scenario_3_approval_push() -> None:
    print("\n[3] PC 操作の承認カードも押し出しで届く")
    from src.services.chat_sse import relay as sse_relay

    engine = create_engine(SETTINGS)
    factory = create_session_factory(engine)
    _user_id, job_id = await seed_job(factory)
    approval_id = str(uuid.uuid4())

    notifier = db_notify.JobNotifier(dsn=db_notify.listen_dsn(SETTINGS))
    assert await notifier.start()

    events: list[object] = []

    async def reader() -> None:
        with notifier.subscribe(job_id) as wake:
            async for ev in sse_relay._relay_events(
                notifier=notifier,
                wake=wake,
                factory=factory,
                job_id=job_id,
                tools_mode="approve",
                timeout=30.0,
                deadline=asyncio.get_event_loop().time() + 30.0,
                last_seq=-1,
                seen_approvals={},
            ):
                events.append(ev)

    task = asyncio.create_task(reader())
    await asyncio.sleep(0.3)

    t0 = time.perf_counter()
    async with factory() as s:
        await s.execute(
            text(
                "insert into public.chat_relay_approvals "
                "(id, job_id, tool, summary, decision) "
                "values (cast(:a as uuid), cast(:j as uuid), 'Bash', 'ls -la', 'pending')"
            ),
            {"a": approval_id, "j": job_id},
        )
        await s.commit()
    await asyncio.sleep(0.3)
    card_ms = (time.perf_counter() - t0) * 1000

    async with factory() as s:
        await s.execute(
            text(
                "update public.chat_relay_approvals set decision = 'allow' "
                "where id = cast(:a as uuid)"
            ),
            {"a": approval_id},
        )
        await s.commit()
    await asyncio.sleep(0.3)
    await finish_job(factory, job_id)
    await asyncio.wait_for(task, timeout=10.0)

    has_card = any(isinstance(e, dict) and "pc_approval" in e for e in events)
    has_resolved = any(isinstance(e, dict) and "pc_approval_resolved" in e for e in events)
    check(has_card, f"承認カードが届いた（発行から約 {card_ms:.0f} ms）")
    check(has_resolved, "承認の決着も届いた")

    await notifier.close()
    await engine.dispose()


async def scenario_4_rls_still_applies() -> None:
    print("\n[4] GAP-201 の RLS 貼り直しが壊れていないこと（押し出し化の巻き添え確認）")
    from src.dependencies import _install_rls_guard

    engine = create_engine(SETTINGS)
    factory = create_session_factory(engine)
    import json

    claims = json.dumps({"sub": str(uuid.uuid4()), "role": "authenticated"})
    async with factory() as session:
        _install_rls_guard(session, claims)
        await session.execute(text("select 1"))
        await session.commit()
        role = (await session.execute(text("select current_user"))).scalar()
        check(str(role) == "authenticated", "commit のあとも RLS の role が効いている")
        await session.commit()
    await engine.dispose()


async def main() -> None:
    await scenario_1_delivery_speed()
    await scenario_2_survives_listener_loss()
    await scenario_3_approval_push()
    await scenario_4_rls_still_applies()

    print()
    if failures:
        print(f"FAIL: {len(failures)} 件\n  - " + "\n  - ".join(failures))
        sys.exit(1)
    print("PASS: 待機中の DB クエリ 0 / 押し出しで即配達 / 通知が死んでも止まらない を実測")


asyncio.run(main())
