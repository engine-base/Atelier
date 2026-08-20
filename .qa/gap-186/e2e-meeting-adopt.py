"""GAP-186 e2e: 議事録の抽出項目を「確認して採用」→ 要件・タスク・決定へ (実 PostgreSQL)。

要点は「自動では反映しない」。一覧を見ただけでは実データは 1 件も増えず、
人が選んだものだけがタスク・決定になる。作られたレコードには**引用が残る**ので、
後から「本当にそう言っていたか」を照合できる。

Supabase Storage だけこの環境に無いので結果 JSON の置き場をメモリに差し替える。
採用ロジック・タスク/決定の作成・監査ログはすべて本物を通す。
"""

from __future__ import annotations

import asyncio
import os
import uuid
from typing import Any

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

PG = "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"

STORE: dict[str, dict[str, Any]] = {}


def say(msg: str = "") -> None:
    print(msg, flush=True)


ANALYSIS: dict[str, Any] = {
    "summary": "LP 制作の要件・予算・納期を確認し、構成を A 案に確定した。",
    "agenda": ["現状の課題", "構成案の比較", "予算と納期"],
    "requirements": [
        {
            "title": "問い合わせフォームに自動返信",
            "detail": "送信後にサンクスメールを自動送信する",
            "kind": "functional",
            "priority": "must",
            "quote": "自動返信は絶対に欲しいです",
        },
        {
            "title": "スマホ表示を優先",
            "detail": "アクセスの 7 割がスマホ",
            "kind": "non_functional",
            "priority": "should",
            "quote": "うちのお客さん、ほぼスマホなんですよ",
        },
        {
            "title": "公開後に自分たちで文言を直せる",
            "detail": "簡易 CMS",
            "kind": "functional",
            "priority": "could",
            "quote": "文言くらいは自分で直したいですね",
        },
    ],
    "action_items": [
        {
            "title": "見積ドラフト作成",
            "owner": "ワンダ",
            "due": "今週金曜",
            "quote": "金曜までに見積もりをください",
        },
    ],
    "decisions": [
        {
            "title": "構成は A 案で確定",
            "detail": "トップ + 問い合わせの 2 ページ構成",
            "decided_by": "田中",
            "quote": "じゃあ A 案でいきましょう",
        },
    ],
    "open_questions": [
        {
            "question": "写真素材は誰が用意するか",
            "context": "既存素材の権利が不明",
            "quote": "写真ってこちらで用意するんでしたっけ",
        },
    ],
    # 反映先を持たない (読むためのもの)
    "risks": [{"title": "素材の到着遅れ", "impact": "公開日が後ろ倒しになる"}],
    "facts": [{"label": "予算", "value": "80 万円"}, {"label": "公開希望日", "value": "4 月 1 日"}],
}


async def seed(s):
    uid, ws, proj, mid = (str(uuid.uuid4()) for _ in range(4))
    email = f"g186e2e-{uid[:8]}@example.com"
    await s.execute(
        text("insert into auth.users (id,email) values (cast(:u as uuid),:e)"),
        {"u": uid, "e": email},
    )
    await s.execute(
        text(
            "insert into public.users (id,email,display_name) "
            "values (cast(:u as uuid),:e,'G186 E2E')"
        ),
        {"u": uid, "e": email},
    )
    await s.execute(
        text(
            "insert into public.workspaces (id,owner_user_id,name) "
            "values (cast(:w as uuid),cast(:u as uuid),'G186 E2E WS')"
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
            "values (cast(:p as uuid),cast(:w as uuid),'LP 制作','client_work','active')"
        ),
        {"p": proj, "w": ws},
    )
    rpath = f"transcripts/results/{mid}.json"
    STORE[rpath] = {"text": "打合せ本文…", "analysis": ANALYSIS}
    await s.execute(
        text(
            "insert into public.external_uploads "
            "(id,project_id,uploaded_by_user_id,type,storage_path,file_name,"
            " file_size_bytes,mime_type,parsed_at,parse_result_path) "
            "values (cast(:i as uuid),cast(:p as uuid),cast(:u as uuid),'audio',:sp,"
            " '打合せ_20260820.mp3',10485760,'audio/mpeg',now(),:rp)"
        ),
        {"i": mid, "p": proj, "u": uid, "sp": f"meetings/{mid}.mp3", "rp": rpath},
    )
    await s.commit()
    return uid, ws, proj, mid


async def counts(s, proj) -> tuple[int, int]:
    t = (
        await s.execute(
            text("select count(*) from public.tasks where project_id=cast(:p as uuid)"), {"p": proj}
        )
    ).scalar_one()
    d = (
        await s.execute(
            text("select count(*) from public.decisions where project_id=cast(:p as uuid)"),
            {"p": proj},
        )
    ).scalar_one()
    return int(t), int(d)


async def main() -> None:
    engine = create_async_engine(PG, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    from src.services.meetings import adopt as adopt_svc
    from src.services.meetings import worker as worker_mod

    async def _load(path: str) -> dict[str, Any]:
        return dict(STORE[path])

    worker_mod.load_result = _load  # type: ignore[assignment]

    async with factory() as s:
        uid, ws, proj, mid = await seed(s)

        say("=" * 78)
        say("GAP-186  議事録の抽出項目を「確認して採用」→ 要件・タスク・決定 (実 PostgreSQL)")
        say("=" * 78)
        say(f"project={proj}")
        say()

        # ---------------------------------------------------------------- 1
        say("── 1. 採用できる項目 (反映先を持つ 4 種だけ)")
        items = await adopt_svc.list_adoptable(s, meeting_id=mid)
        for kind in ("requirement", "action", "decision", "open_question"):
            rows = [i for i in items if i.kind == kind]
            say(f"   {kind:<15}: {len(rows)} 件  {[i.title for i in rows]}")
        say(f"   リスク・数値・議題は出さない: {'素材の到着遅れ' not in {i.title for i in items}}")
        say()

        # ---------------------------------------------------------------- 2
        say("── 2. 一覧を見ただけでは実データは 1 件も増えない (自動反映しない)")
        t, d = await counts(s, proj)
        say(f"   タスク {t} 件 / 決定 {d} 件")
        say()

        # ---------------------------------------------------------------- 3
        say("── 3. 人が選んだ 3 件だけを採用する (必須要件・アクション・決定)")
        by_title = {i.title: i for i in items}
        picked = ["問い合わせフォームに自動返信", "見積ドラフト作成", "構成は A 案で確定"]
        result = await adopt_svc.adopt(
            s, meeting_id=mid, actor_id=uid, keys=[by_title[t].key for t in picked]
        )
        await s.commit()
        say(f"   結果: {result.message}")
        t, d = await counts(s, proj)
        say(f"   タスク {t} 件 / 決定 {d} 件  (選んでいない 3 件は作られていない)")
        say()

        say("   作られたタスク:")
        rows = (
            await s.execute(
                text(
                    "select title, type, priority, category, description from public.tasks "
                    "where project_id=cast(:p as uuid) order by created_at"
                ),
                {"p": proj},
            )
        ).all()
        for r in rows:
            say(f"     - {r.title}  [{r.type} / 優先度 {r.priority} / {r.category}]")
            for line in str(r.description).split("\n"):
                say(f"         {line}")
        say()
        say("   作られた決定:")
        rows = (
            await s.execute(
                text(
                    "select status, body, reflected_to, with_user from public.decisions "
                    "where project_id=cast(:p as uuid) order by created_at"
                ),
                {"p": proj},
            )
        ).all()
        for r in rows:
            say(f"     - [{r.status}] 出典={r.reflected_to} / 人が決めた={r.with_user}")
            for line in str(r.body).split("\n"):
                say(f"         {line}")
        say()

        # ---------------------------------------------------------------- 4
        say("── 4. もう一度同じものを押しても増えない")
        again = await adopt_svc.adopt(
            s, meeting_id=mid, actor_id=uid, keys=[by_title["問い合わせフォームに自動返信"].key]
        )
        await s.commit()
        say(f"   結果: {again.message}")
        t2, d2 = await counts(s, proj)
        say(f"   タスク {t2} 件 / 決定 {d2} 件  (増えていない: {(t2, d2) == (t, d)})")
        say()

        # ---------------------------------------------------------------- 5
        say("── 5. 採用済みは一覧で分かり、反映先へ辿れる")
        after = await adopt_svc.list_adoptable(s, meeting_id=mid)
        for i in after:
            mark = f"→ {i.target_type} {str(i.target_id)[:8]}" if i.adopted else "（未反映）"
            say(f"   [{'済' if i.adopted else '  '}] {i.title:<28} {mark}")
        say()

        # ---------------------------------------------------------------- 6
        say("── 6. 追跡: この要件はどの議事録から来たか")
        rows = (
            await s.execute(
                text(
                    "select a.kind, a.target_type, u.file_name "
                    "from public.meeting_adoptions a "
                    "join public.external_uploads u on u.id = a.meeting_id "
                    "where a.project_id = cast(:p as uuid) order by a.adopted_at"
                ),
                {"p": proj},
            )
        ).all()
        for r in rows:
            say(f"   {r.kind:<15} → {r.target_type:<9} 出典: {r.file_name}")
        say()

        # ---------------------------------------------------------------- 7
        say("── 7. 存在しない項目を指定されたら、黙って無視せず正直に返す")
        bogus = await adopt_svc.adopt(
            s, meeting_id=mid, actor_id=uid, keys=["requirement:でたらめな要件"]
        )
        await s.commit()
        say(f"   結果: {bogus.message}")
        say(f"   missing: {bogus.missing}")
        say()

        # cleanup
        await s.execute(text("delete from public.workspaces where id=cast(:w as uuid)"), {"w": ws})
        await s.execute(text("delete from public.users where id=cast(:u as uuid)"), {"u": uid})
        await s.execute(text("delete from auth.users where id=cast(:u as uuid)"), {"u": uid})
        await s.commit()

        say("=" * 78)
        say("結論: 議事録の抽出はそのままでは何も変えない。人が引用を見て選んだものだけが")
        say("      タスク・決定になり、本文には引用が残るので後から照合できる。")
        say("      二重採用では増えず、どの議事録から来たかも辿れる。")
        say("=" * 78)

    await engine.dispose()


asyncio.run(main())
