"""GAP-189 e2e: 中断 / 実行中の追い足し / 繋ぎ直しを実 PostgreSQL で確認する。

Bridge (利用者の PC) の役を実プロセスで演じる:
  - サーバーの制御信号 (cancel) を実際にポーリングし、
  - 本物の子プロセス (居座るスクリプト) を kill する。

「クラウドの状態を落としただけで PC では走り続けている」という嘘の中断に
なっていないことを、実プロセスの生死で確かめるのが要点。
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

PG = "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"


def say(msg: str = "") -> None:
    print(msg, flush=True)


async def seed(s):
    uid, ws, proj, thread, emp = (str(uuid.uuid4()) for _ in range(5))
    email = f"g189e2e-{uid[:8]}@example.com"
    await s.execute(
        text("insert into auth.users (id,email) values (cast(:u as uuid),:e)"),
        {"u": uid, "e": email},
    )
    await s.execute(
        text(
            "insert into public.users (id,email,display_name) "
            "values (cast(:u as uuid),:e,'G189 E2E')"
        ),
        {"u": uid, "e": email},
    )
    await s.execute(
        text(
            "insert into public.workspaces (id,owner_user_id,name) "
            "values (cast(:w as uuid),cast(:u as uuid),'G189 E2E WS')"
        ),
        {"w": ws, "u": uid},
    )
    await s.execute(
        text(
            "insert into public.workspace_memberships (workspace_id,user_id,role) "
            "values (cast(:w as uuid),cast(:u as uuid),'owner') on conflict do nothing"
        ),
        {"w": ws, "u": uid},
    )
    await s.execute(
        text(
            "insert into public.projects (id,workspace_id,name,project_type,status) "
            "values (cast(:p as uuid),cast(:w as uuid),'実行制御テスト','client_work','active')"
        ),
        {"p": proj, "w": ws},
    )
    await s.execute(
        text(
            "insert into public.ai_employees "
            "(id,workspace_id,name,display_name,role,department) "
            "values (cast(:e as uuid),cast(:w as uuid),'wanda','ワンダ','member','design')"
        ),
        {"e": emp, "w": ws},
    )
    await s.execute(
        text(
            "insert into public.chat_threads (id,project_id,ai_employee_id,title) "
            "values (cast(:t as uuid),cast(:p as uuid),cast(:e as uuid),'LP の相談')"
        ),
        {"t": thread, "p": proj, "e": emp},
    )
    await s.commit()
    return uid, ws, thread


async def assistant_messages(s, thread):
    rows = (
        await s.execute(
            text(
                "select content from public.chat_messages where thread_id = cast(:t as uuid) "
                "and role = 'assistant' order by created_at"
            ),
            {"t": thread},
        )
    ).all()
    return [str(r.content) for r in rows]


async def main() -> None:
    engine = create_async_engine(PG, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    from src.services import chat_relay, chat_run

    async with factory() as s:
        uid, ws, thread = await seed(s)

        say("=" * 78)
        say("GAP-189  実行の制御 — 中断 / 実行中の追い足し / 繋ぎ直し (実 PostgreSQL)")
        say("=" * 78)
        say(f"thread={thread}")
        say()

        # ------------------------------------------------------------ 1
        say("── 1. 中断: 押したら「本人の PC で走っている claude」が実際に止まるか")
        job = await chat_relay.enqueue_job(
            s, thread_id=thread, requested_by=uid, system_prompt="SYS", prompt="LP を作って"
        )
        await s.execute(
            text("update public.chat_relay_jobs set status='running' where id = cast(:i as uuid)"),
            {"i": job},
        )
        await chat_relay.append_chunks(
            s, job_id=job, seq_start=0, texts=["構成案を書き始めます。まずトップは"]
        )
        await s.commit()

        # 利用者の PC で走っている claude の代役 (中断されない限り終わらない)
        script = Path(tempfile.mkdtemp()) / "long_job.py"
        script.write_text("import time\nwhile True: time.sleep(1)\n")
        child = subprocess.Popen([sys.executable, str(script)])
        say(f"   PC 上の実プロセス起動        : pid={child.pid} (生存={child.poll() is None})")

        # Bridge の見張り役 (実際のポーリングと同じ形)
        async def bridge_watch() -> str:
            for _ in range(200):
                async with factory() as w:
                    stop = await chat_run.cancel_requested(w, job_id=job)
                if stop:
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                    return "killed"
                await asyncio.sleep(0.05)
            return "timeout"

        watcher = asyncio.create_task(bridge_watch())
        await asyncio.sleep(0.2)
        result = await chat_run.request_cancel(s, job_id=job, actor_id=uid)
        await s.commit()
        outcome = await watcher

        say(f"   中断の返答                    : {result.status} / {result.message}")
        say(f"   Bridge の反応                 : {outcome}")
        say(f"   PC 上の実プロセス             : 生存={child.poll() is None} (exit={child.poll()})")
        status = (
            await s.execute(
                text("select status from public.chat_relay_jobs where id = cast(:i as uuid)"),
                {"i": job},
            )
        ).scalar_one()
        say(f"   ジョブの状態                  : {status}")
        msgs = await assistant_messages(s, thread)
        say(f"   ここまでの本文が残っている    : {msgs[-1][:40]!r}")
        say()

        # ------------------------------------------------------------ 2
        say("── 2. 中断済みジョブへの Bridge の完了報告 → 静かに受け取る (done で塗らない)")
        await chat_relay.complete_job(
            s, job_id=job, ok=False, error="[cancelled] ユーザーが中断しました"
        )
        await s.commit()
        status = (
            await s.execute(
                text("select status from public.chat_relay_jobs where id = cast(:i as uuid)"),
                {"i": job},
            )
        ).scalar_one()
        say(f"   ジョブの状態                  : {status}  (done にならない)")
        say(
            f"   assistant の吹き出し数        : {len(await assistant_messages(s, thread))} (二重投稿なし)"
        )
        say()

        # ------------------------------------------------------------ 3
        say("── 3. 繋ぎ直し: 画面を閉じても答えが消えないか")
        job2 = await chat_relay.enqueue_job(
            s, thread_id=thread, requested_by=uid, system_prompt="SYS", prompt="続きをお願い"
        )
        await s.execute(
            text("update public.chat_relay_jobs set status='running' where id = cast(:i as uuid)"),
            {"i": job2},
        )
        await s.commit()
        active = await chat_run.active_run(s, thread_id=thread, actor_id=uid)
        say(f"   走っている実行が見える        : {active is not None and active.job_id == job2}")
        say("   （ここでブラウザを閉じた。SSE は一切繋がっていない）")
        await chat_relay.append_chunks(
            s,
            job_id=job2,
            seq_start=0,
            texts=["Bash", "PC が最後まで書き上げた提案です。"],
            kinds=["tool", "delta"],
        )
        await chat_relay.complete_job(s, job_id=job2, ok=True)
        await s.commit()
        msgs = await assistant_messages(s, thread)
        say(f"   スレッドに答えが残った        : {msgs[-1]!r}")
        say(f"   ツール実況は本文に混ざらない  : {'Bash' not in msgs[-1]}")
        say(
            f"   走っている実行はもう無い      : "
            f"{await chat_run.active_run(s, thread_id=thread, actor_id=uid) is None}"
        )
        say()

        # ------------------------------------------------------------ 4
        say("── 4. 実行中の追い足し指示: 受領時点で保存され、順に 1 回ずつ流れる")
        for body in ("やっぱり色は青で", "フォームは 2 項目に"):
            await chat_run.queue_message(s, thread_id=thread, actor_id=uid, content=body)
        await s.commit()
        pending = await chat_run.list_queued(s, thread_id=thread, actor_id=uid)
        say(f"   保存された待ちの指示          : {[p['content'] for p in pending]}")
        say("   （ここでブラウザが落ちたとしても DB に残っている）")
        got = []
        while True:
            item = await chat_run.consume_next(s, thread_id=thread, actor_id=uid)
            await s.commit()
            if item is None:
                break
            got.append(item["content"])
        say(f"   取り出した順                  : {got}")
        say(
            f"   もう一度取り出すと            : "
            f"{await chat_run.consume_next(s, thread_id=thread, actor_id=uid)} (二重消費なし)"
        )
        say()

        # ------------------------------------------------------------ 5
        say("── 5. 他人の実行は止められない・見えない (R-T08 系の分離)")
        other = str(uuid.uuid4())
        await s.execute(
            text("insert into auth.users (id,email) values (cast(:u as uuid),:e)"),
            {"u": other, "e": f"g189x-{other[:8]}@example.com"},
        )
        await s.execute(
            text(
                "insert into public.users (id,email,display_name) "
                "values (cast(:u as uuid),:e,'別の人')"
            ),
            {"u": other, "e": f"g189x-{other[:8]}@example.com"},
        )
        await s.commit()
        job3 = await chat_relay.enqueue_job(
            s, thread_id=thread, requested_by=uid, system_prompt="SYS", prompt="x"
        )
        await s.execute(
            text("update public.chat_relay_jobs set status='running' where id = cast(:i as uuid)"),
            {"i": job3},
        )
        await s.commit()
        try:
            await chat_run.request_cancel(s, job_id=job3, actor_id=other)
            say("   他人が止められた              : ✗ 分離できていない")
        except chat_run.RunControlError as exc:
            say(f"   他人が止めようとすると        : {exc.code} / {exc.message}")
        say(
            f"   他人から走っている実行が見える: "
            f"{await chat_run.active_run(s, thread_id=thread, actor_id=other) is not None}"
        )
        await chat_run.queue_message(s, thread_id=thread, actor_id=uid, content="本人の指示")
        await s.commit()
        say(
            f"   他人から待ちの指示が見える    : "
            f"{await chat_run.list_queued(s, thread_id=thread, actor_id=other) != []}"
        )
        say()

        # cleanup
        await s.execute(text("delete from public.workspaces where id=cast(:w as uuid)"), {"w": ws})
        for u in (uid, other):
            await s.execute(text("delete from public.users where id=cast(:u as uuid)"), {"u": u})
            await s.execute(text("delete from auth.users where id=cast(:u as uuid)"), {"u": u})
        await s.commit()

        say("=" * 78)
        say("結論: 停止は本人の PC の実プロセスまで届く。実行中に送った指示は受領時点で")
        say("      保存され順に 1 回だけ流れる。返答の保存はブラウザではなくサーバーの")
        say("      ジョブ確定に紐づくので、画面を閉じても答えは消えない。")
        say("=" * 78)

    await engine.dispose()


asyncio.run(main())
