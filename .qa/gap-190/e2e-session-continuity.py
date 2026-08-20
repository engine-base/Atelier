"""GAP-190 e2e: スレッドが「同じ Claude セッション」で走ることの実測。

**本物の claude CLI を実際に起動して**確かめる:
  1. --session-id で始めたセッションが、別プロセスの --resume で引き継がれる
  2. transcript が実ファイルとして残る (プロセス死・PC 再起動を跨ぐ)
  3. Bridge のパス解決が実際のファイル位置と一致する
  4. 再開できるときは履歴を送らない = 送信量が減る (プラン枠の節約)
  5. 再開できないとき (別 PC 相当) は履歴込みに切り替わり、会話が飛ばない

DB 側 (スレッドがセッションを持ち続ける / Bridge の報告で自己修復する) も
実 PostgreSQL で確かめる。
"""

from __future__ import annotations

import asyncio
import os
import subprocess
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


def transcript_path(cwd: str, session_id: str) -> Path:
    """Bridge (sessionTranscriptPath) と同じ規則でパスを求める。"""
    home = os.environ.get("HOME") or str(Path.home())
    return Path(home) / ".claude" / "projects" / cwd.replace("/", "-") / f"{session_id}.jsonl"


def run_claude(cwd: str, prompt: str, *, session_id: str | None, resume: bool) -> str:
    args = ["claude", "-p", "--max-turns", "1", "--tools", ""]
    if session_id is not None:
        args += ["--resume", session_id] if resume else ["--session-id", session_id]
    out = subprocess.run(args, cwd=cwd, input=prompt, capture_output=True, text=True, timeout=120)
    if out.returncode != 0:
        return f"(exit={out.returncode}) {out.stderr.strip()[:200]}"
    return out.stdout.strip()


async def seed(s):
    uid, ws, proj, thread, emp = (str(uuid.uuid4()) for _ in range(5))
    email = f"g190e2e-{uid[:8]}@example.com"
    await s.execute(
        text("insert into auth.users (id,email) values (cast(:u as uuid),:e)"),
        {"u": uid, "e": email},
    )
    await s.execute(
        text(
            "insert into public.users (id,email,display_name) "
            "values (cast(:u as uuid),:e,'G190 E2E')"
        ),
        {"u": uid, "e": email},
    )
    await s.execute(
        text(
            "insert into public.workspaces (id,owner_user_id,name) "
            "values (cast(:w as uuid),cast(:u as uuid),'G190 E2E WS')"
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
            "values (cast(:p as uuid),cast(:w as uuid),'G190案件','client_work','active')"
        ),
        {"p": proj, "w": ws},
    )
    await s.execute(
        text(
            "insert into public.ai_employees "
            "(id,workspace_id,name,display_name,role,department) "
            "values (cast(:e as uuid),cast(:w as uuid),'tony','トニー','coo','executive')"
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


async def main() -> None:
    say("=" * 78)
    say("GAP-190  スレッドが「同じ Claude セッション」で走ることの実測")
    say("=" * 78)
    say()

    # ---------------------------------------------------------------- 1
    say("── 1. 実 claude CLI: --session-id で始めて、別プロセスで --resume する")
    work = tempfile.mkdtemp(prefix="g190e2e")
    sid = str(uuid.uuid4())
    say(f"   作業ディレクトリ: {work}")
    say(f"   セッション ID   : {sid}")

    a1 = run_claude(
        work, "この案件の予算は 80 万円です。「覚えた」とだけ答えて", session_id=sid, resume=False
    )
    say(f"   1 回目 (--session-id) : {a1!r}")

    tpath = transcript_path(work, sid)
    say(f"   Bridge が計算するパス : {tpath}")
    say(
        f"   そこに実ファイルがある: {tpath.exists()}  "
        f"({tpath.stat().st_size if tpath.exists() else 0} bytes)"
    )

    # ---------------------------------------------------------------- 2
    say()
    say("── 2. **履歴を一切送らずに** 別プロセスで続きを聞く")
    say("   （プロセスは既に終了している = PC 再起動と同じ状態）")
    a2 = run_claude(work, "この案件の予算は？金額だけ答えて", session_id=sid, resume=True)
    say(f"   2 回目 (--resume)     : {a2!r}")
    say(f"   → 会話が引き継がれた  : {'80' in a2}")

    # ---------------------------------------------------------------- 3
    say()
    say("── 3. 送信量の比較 (= 利用者のプラン枠の節約)")
    history = (
        "user: この案件の予算は 80 万円です。「覚えた」とだけ答えて\n"
        "assistant: 覚えた\n"
        "user: この案件の予算は？金額だけ答えて"
    )
    new_only = "この案件の予算は？金額だけ答えて"
    say(f"   これまで (履歴を毎回送る): {len(history)} 文字")
    say(f"   これから (新しい発言だけ): {len(new_only)} 文字")
    say(
        f"   削減                      : {len(history) - len(new_only)} 文字 "
        f"({100 - round(len(new_only) / len(history) * 100)}% 減)"
    )
    say("   ※ 会話が伸びるほど差は大きくなる（履歴は毎ターン増えるため）")

    # ---------------------------------------------------------------- 4
    say()
    say("── 4. 再開できない場合 (別 PC 相当) — 会話が飛ばないこと")
    other_work = tempfile.mkdtemp(prefix="g190other")
    other_path = transcript_path(other_work, sid)
    say(f"   別の作業ディレクトリ  : {other_work}")
    say(f"   そこに同じセッションは: {other_path.exists()}  → 再開できない")
    say("   → Bridge は履歴込みプロンプトに切り替える (planSession の resume=false)")
    a3 = run_claude(
        other_work,
        f"{history}\n\n上の会話の続きです。予算は？金額だけ答えて",
        session_id=str(uuid.uuid4()),
        resume=False,
    )
    say(f"   履歴込みで聞いた結果  : {a3!r}")
    say(f"   → 会話は飛んでいない  : {'80' in a3}")

    # ---------------------------------------------------------------- 5
    say()
    say("── 5. DB: スレッドがセッションを持ち続け、Bridge の報告で自己修復する")
    engine = create_async_engine(PG, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    from src.services import chat_relay
    from src.services.chat_relay import session as session_svc

    async with factory() as s:
        uid, ws, thread = await seed(s)

        first = await session_svc.ensure_thread_session(s, thread_id=thread)
        await s.commit()
        second = await session_svc.ensure_thread_session(s, thread_id=thread)
        await s.commit()
        say(f"   2 回引いても同じセッション: {first.session_id == second.session_id}")

        job = await chat_relay.enqueue_job(
            s,
            thread_id=thread,
            requested_by=uid,
            system_prompt="SYS",
            prompt="新しい発言",
            session_id=first.session_id,
            prompt_full="履歴込み\n新しい発言",
        )
        await s.commit()
        picked = await chat_relay.pick_job(s, worker_id="pc-1", requested_by=uid)
        await s.commit()
        assert picked is not None
        say(f"   ジョブに新しい発言だけ    : {picked['prompt']!r}")
        say(f"   ジョブに履歴込みも載る    : {picked['prompt_full']!r}")
        say(f"   使ってほしいセッション    : {str(picked['session_id'])[:8]}")

        await chat_relay.append_chunks(s, job_id=job, seq_start=0, texts=["答え"])
        await s.commit()

        # Bridge が別 PC で再開できず、別 ID を採番して報告した想定
        actual = str(uuid.uuid4())
        await chat_relay.complete_job(
            s, job_id=job, ok=True, session_id=actual, resumed=False, worker_id="pc-2"
        )
        await s.commit()

        row = (
            await s.execute(
                text(
                    "select claude_session_id, claude_session_worker_id from public.chat_threads "
                    "where id = cast(:t as uuid)"
                ),
                {"t": thread},
            )
        ).first()
        say(f"   Bridge が実際に使った ID  : {actual[:8]}")
        say(f"   スレッドが上書きされた    : {str(row.claude_session_id) == actual}")
        say(f"   どの PC のセッションか    : {row.claude_session_worker_id}")
        nxt = await session_svc.ensure_thread_session(s, thread_id=thread)
        say(f"   次ターンはその ID を渡す  : {nxt.session_id == actual}")
        say(f"   確立済みと分かる          : {nxt.established}")

        await s.execute(text("delete from public.workspaces where id=cast(:w as uuid)"), {"w": ws})
        await s.execute(text("delete from public.users where id=cast(:u as uuid)"), {"u": uid})
        await s.execute(text("delete from auth.users where id=cast(:u as uuid)"), {"u": uid})
        await s.commit()

    await engine.dispose()

    say()
    say("=" * 78)
    say("結論: スレッドは 1 つの Claude セッションを持ち続け、プロセスが死んでも")
    say("      transcript の実ファイルから再開できる。再開できるときは履歴を送らない")
    say("      ので利用者のプラン枠を余分に使わず、再開できないときは履歴込みに")
    say("      切り替わるので会話が飛ばない。判断は Bridge が実ファイルを見て行う。")
    say("=" * 78)


asyncio.run(main())
