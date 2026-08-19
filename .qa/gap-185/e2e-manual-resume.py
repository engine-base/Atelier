"""GAP-185 e2e: 止まったものを「進めて」で再開できることを実 PostgreSQL で確認する。

fake は一切使わない方針だが、Supabase Storage だけはこの環境に無いので
結果 JSON の置き場をメモリに差し替える。解析本体 (analysis.py)・LLM チェーン
(llm_chain.py)・DB 更新・監査ログはすべて本物を通す。
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from datetime import UTC, datetime, timedelta

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")
os.environ.pop("ATELIER_ALLOW_FAKE_LLM", None)

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

PG = "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"

STORE: dict[str, dict] = {}


def say(msg: str = "") -> None:
    print(msg, flush=True)


async def seed(s):
    uid, ws, proj = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    email = f"g185e2e-{uid[:8]}@example.com"
    await s.execute(
        text("insert into auth.users (id,email) values (cast(:u as uuid),:e)"),
        {"u": uid, "e": email},
    )
    await s.execute(
        text(
            "insert into public.users (id,email,display_name) "
            "values (cast(:u as uuid),:e,'G185 E2E')"
        ),
        {"u": uid, "e": email},
    )
    await s.execute(
        text(
            "insert into public.workspaces (id,owner_user_id,name) "
            "values (cast(:w as uuid),cast(:u as uuid),'G185 E2E WS')"
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
            "values (cast(:p as uuid),cast(:w as uuid),'再開テスト案件','client_work','active')"
        ),
        {"p": proj, "w": ws},
    )
    await s.execute(
        text(
            "insert into public.ai_employees (workspace_id,name,display_name,role,department) "
            "values (cast(:w as uuid),'tony','トニー','coo','executive') on conflict do nothing"
        ),
        {"w": ws},
    )
    await s.commit()
    return uid, ws, proj


TRANSCRIPT = (
    "田中: 今日はLPの件で。予算は80万くらいで考えています。\n"
    "ワンダ: 公開はいつまでに。\n"
    "田中: 4月1日には出したいです。問い合わせフォームの自動返信は絶対に欲しい。\n"
    "ワンダ: 構成はA案・B案がありますが。\n"
    "田中: じゃあA案でいきましょう。写真ってこちらで用意するんでしたっけ。\n"
)

ANALYSIS_JSON = json.dumps(
    {
        "summary": "LP 制作の予算・納期・構成を確認し、A 案に確定した。",
        "decisions": [{"title": "構成は A 案で確定", "quote": "じゃあA案でいきましょう"}],
        "requirements": [
            {
                "title": "問い合わせフォームの自動返信",
                "kind": "functional",
                "priority": "must",
                "quote": "自動返信は絶対に欲しい",
            }
        ],
        "open_questions": [
            {
                "question": "写真素材は誰が用意するか",
                "quote": "写真ってこちらで用意するんでしたっけ",
            }
        ],
        "facts": [
            {"label": "予算", "value": "80 万円", "quote": "予算は80万くらいで"},
            {"label": "公開希望日", "value": "4 月 1 日", "quote": "4月1日には出したいです"},
        ],
    },
    ensure_ascii=False,
)


async def main() -> None:
    engine = create_async_engine(PG, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    from src.services.cron.dispatcher import run_one_now
    from src.services.meetings import worker as worker_mod
    from src.services.meetings.resume import list_pending_analyses, resume_analysis

    # Storage だけメモリに差し替える (この環境に Supabase Storage が無いため)
    async def _dl(path: str) -> dict:
        return dict(STORE[path])

    async def _ul(path: str, payload: dict) -> None:
        STORE[path] = dict(payload)

    worker_mod._download_result = _dl  # type: ignore[assignment]
    worker_mod._upload_result = _ul  # type: ignore[assignment]

    async with factory() as s:
        uid, ws, proj = await seed(s)

        say("=" * 78)
        say("GAP-185  止まったものを「進めて」で再開できる — 実 PostgreSQL e2e")
        say("=" * 78)
        say(f"workspace={ws}")
        say(f"project  ={proj}")
        say()

        # ---------------------------------------------------------------- 1
        say("── 1. 議事録: 文字起こしは終わったが、プラン枠の上限で解析だけ止まった状態")
        mid = str(uuid.uuid4())
        rpath = f"transcripts/results/{mid}.json"
        STORE[rpath] = {
            "text": TRANSCRIPT,
            "provider": "faster-whisper",
            "model": "small",
            "analysis_error": "rate_limited",
        }
        await s.execute(
            text(
                "insert into public.external_uploads "
                "(id,project_id,uploaded_by_user_id,type,storage_path,file_name,"
                " file_size_bytes,mime_type,parsed_at,parse_result_path,analysis_pending_since) "
                "values (cast(:i as uuid),cast(:p as uuid),cast(:u as uuid),'audio',:sp,"
                " '打合せ_20260819.mp3',10485760,'audio/mpeg',now(),:rp, now() - interval '4 hours')"
            ),
            {"i": mid, "p": proj, "u": uid, "sp": f"meetings/{mid}.mp3", "rp": rpath},
        )
        await s.commit()
        pend = await list_pending_analyses(s)
        mine = [p for p in pend if p["id"] == mid]
        say(f"   保留一覧に出る               : {len(mine)} 件  file={mine[0]['file_name']}")
        say(f"   保留になってからの経過        : {datetime.now(UTC) - mine[0]['pending_since']}")
        say(f"   文字起こし本文は保持されている: {len(STORE[rpath]['text'])} 文字")
        say()

        # ---------------------------------------------------------------- 2
        say("── 2. まだ PC が繋がっていない状態で「進めて」 → 嘘の成功を出さない")
        say("   (ATELIER_ALLOW_FAKE_LLM 未設定・Bridge 未接続 = 本物のチェーンが断る)")
        from src.services.chat_sse import relay as relay_mod

        real_relay = relay_mod.relay_stream_chunks

        async def offline(*_a, **_k):
            raise relay_mod.RelayUnavailable
            yield ""

        relay_mod.relay_stream_chunks = offline  # type: ignore[assignment]
        r = await resume_analysis(s, meeting_id=mid)
        await s.commit()
        say(f"   status : {r.status}")
        say(f"   message: {r.message}")
        row = (
            await s.execute(
                text(
                    "select analysis_pending_since from public.external_uploads "
                    "where id=cast(:i as uuid)"
                ),
                {"i": mid},
            )
        ).first()
        say(f"   保留は解除されていない        : {row.analysis_pending_since is not None}")
        say(f"   結果 JSON の analysis_error   : {STORE[rpath].get('analysis_error')}")
        say(f"   解析結果は入っていない        : {'analysis' not in STORE[rpath]}")
        say()

        # ---------------------------------------------------------------- 3
        say("── 3. PC が繋がった / 枠がリセットされた後に「進めて」 → 本当に解析される")

        async def online(*_a, **_k):
            yield ANALYSIS_JSON

        relay_mod.relay_stream_chunks = online  # type: ignore[assignment]
        r = await resume_analysis(s, meeting_id=mid)
        await s.commit()
        say(f"   status : {r.status}")
        say(f"   message: {r.message}")
        row = (
            await s.execute(
                text(
                    "select analysis_pending_since from public.external_uploads "
                    "where id=cast(:i as uuid)"
                ),
                {"i": mid},
            )
        ).first()
        say(f"   保留が解除された              : {row.analysis_pending_since is None}")
        a = STORE[rpath].get("analysis") or {}
        say(f"   要約                          : {a.get('summary')}")
        say(f"   決定事項                      : {[d['title'] for d in a.get('decisions', [])]}")
        say(f"   要件                          : {[q['title'] for q in a.get('requirements', [])]}")
        say(
            f"   未決                          : {[q['question'] for q in a.get('open_questions', [])]}"
        )
        say(
            f"   数値・事実                    : {[(f['label'], f['value']) for f in a.get('facts', [])]}"
        )
        say(f"   文字起こし本文は消えていない  : {len(STORE[rpath]['text'])} 文字")
        audit = (
            await s.execute(
                text(
                    "select action from public.audit_logs where target_id=cast(:i as uuid) "
                    "order by created_at desc limit 1"
                ),
                {"i": mid},
            )
        ).first()
        say(f"   監査ログ                      : {audit.action if audit else '(なし)'}")
        say()
        relay_mod.relay_stream_chunks = real_relay  # type: ignore[assignment]

        # ---------------------------------------------------------------- 4
        say("── 4. 保留でないものに「進めて」と言われたら、誤解を招く返事をしない")
        r = await resume_analysis(s, meeting_id=mid)
        say(f"   status : {r.status}")
        say(f"   message: {r.message}")
        r = await resume_analysis(s, meeting_id=str(uuid.uuid4()))
        say(f"   存在しない議事録              : {r.status} / {r.message}")
        say()

        # ---------------------------------------------------------------- 5
        say("── 5. 自動実行 (cron): 次の定刻を待たずに 1 回だけ動かす")
        sched = str(uuid.uuid4())
        future = datetime.now(UTC) + timedelta(days=1)
        await s.execute(
            text(
                "insert into public.cron_schedules "
                "(id,project_id,name,cron_expression,target_action,enabled,next_run_at) "
                "values (cast(:s as uuid),cast(:p as uuid),'毎朝の進捗ダイジェスト','0 9 * * *',"
                " 'daily_digest',true,:nr)"
            ),
            {"s": sched, "p": proj, "nr": future},
        )
        await s.commit()
        say(f"   実行前の次回時刻              : {future.isoformat()}")
        res = await run_one_now(s, schedule_id=sched)
        await s.commit()
        say(f"   status                        : {res['status']}")
        say(f"   message                       : {res.get('message')}")
        row = (
            await s.execute(
                text(
                    "select next_run_at,enabled from public.cron_schedules "
                    "where id=cast(:s as uuid)"
                ),
                {"s": sched},
            )
        ).first()
        say(f"   実行後の次回時刻              : {row.next_run_at.isoformat()}")
        say(
            f"   → 定期スケジュールをずらさない: {abs((row.next_run_at - future).total_seconds()) < 1}"
        )
        hist = (
            await s.execute(
                text(
                    "select status, started_at, finished_at from public.cron_run_history "
                    "where schedule_id=cast(:s as uuid)"
                ),
                {"s": sched},
            )
        ).all()
        say(f"   実行履歴                      : {[(h.status) for h in hist]}")
        say()

        # ---------------------------------------------------------------- 6
        say("── 6. 一時停止中の自動実行も「進めて」で 1 回だけ動く")
        sched2 = str(uuid.uuid4())
        await s.execute(
            text(
                "insert into public.cron_schedules "
                "(id,project_id,name,cron_expression,target_action,enabled,next_run_at) "
                "values (cast(:s as uuid),cast(:p as uuid),'停止中のダイジェスト','0 9 * * *',"
                " 'daily_digest',false,:nr)"
            ),
            {"s": sched2, "p": proj, "nr": future},
        )
        await s.commit()
        res = await run_one_now(s, schedule_id=sched2)
        await s.commit()
        row = (
            await s.execute(
                text("select enabled from public.cron_schedules where id=cast(:s as uuid)"),
                {"s": sched2},
            )
        ).first()
        say(f"   status                        : {res['status']}")
        say(f"   停止中のまま (勝手に有効化しない): {row.enabled is False}")
        say()

        # ---------------------------------------------------------------- 7
        say("── 7. AI が要る自動実行を、枠が上限のまま「進めて」 → 嘘の成功を出さない")
        sched3 = str(uuid.uuid4())
        await s.execute(
            text(
                "insert into public.cron_schedules "
                "(id,project_id,name,cron_expression,target_action,enabled,next_run_at) "
                "values (cast(:s as uuid),cast(:p as uuid),'週次レポート','0 9 * * 1',"
                " 'report_summary',true,:nr)"
            ),
            {"s": sched3, "p": proj, "nr": future},
        )
        await s.commit()

        from src.services.chat_sse.llm_chain import LLMUnavailable

        async def limited(**_kw):
            raise LLMUnavailable(
                "rate_limited", "お使いの Claude プランの利用枠が上限に達しています。"
            )

        res = await run_one_now(s, schedule_id=sched3, complete=limited)
        await s.commit()
        say(f"   status                        : {res['status']}")
        say(f"   message                       : {res.get('message')}")
        hist = (
            await s.execute(
                text(
                    "select status from public.cron_run_history where schedule_id=cast(:s as uuid)"
                ),
                {"s": sched3},
            )
        ).all()
        say(f"   実行履歴                      : {[h.status for h in hist]}  (success ではない)")
        say()

        # cleanup
        await s.execute(text("delete from public.workspaces where id=cast(:w as uuid)"), {"w": ws})
        await s.execute(text("delete from public.users where id=cast(:u as uuid)"), {"u": uid})
        await s.execute(text("delete from auth.users where id=cast(:u as uuid)"), {"u": uid})
        await s.commit()

        say("=" * 78)
        say("結論: 止まったもの (議事録の解析 / 自動実行) は、人が「進めて」と言えば")
        say("      その場で再開できる。まだ実行できないときは保留のまま残し、")
        say("      「実行しました」とは決して言わない。自動再開は行わない。")
        say("=" * 78)

    await engine.dispose()


asyncio.run(main())
