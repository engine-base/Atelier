"""GAP-187 e2e: 議事録を根拠に次フェーズを提案する (実 PostgreSQL)。

要点:
  - 提案の根拠に**議事録の決定・要件・未決事項**が実際に渡っている
  - **提案するだけで確定しない** (フェーズは 1 件も増えない)
  - どの打合せ由来かが残る
  - PC 未接続なら嘘の提案を作らず、行を 1 件も残さない
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from dataclasses import dataclass
from typing import Any

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")
os.environ.pop("ATELIER_ALLOW_FAKE_LLM", None)

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

PG = "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
STORE: dict[str, dict[str, Any]] = {}


def say(msg: str = "") -> None:
    print(msg, flush=True)


ANALYSIS: dict[str, Any] = {
    "summary": "LP 制作の要件・予算・納期を確認し、構成を A 案に確定した。",
    "decisions": [{"title": "構成は A 案で確定", "detail": "トップ + 問い合わせの 2 ページ構成"}],
    "requirements": [
        {"title": "問い合わせフォームに自動返信", "detail": "サンクスメール", "priority": "must"},
        {"title": "スマホ表示を優先", "detail": "アクセスの 7 割がスマホ", "priority": "should"},
    ],
    "open_questions": [{"question": "写真素材は誰が用意するか", "context": "権利が不明"}],
    "risks": [{"title": "素材の到着遅れ", "impact": "公開日が後ろ倒し"}],
    "facts": [{"label": "予算", "value": "80 万円"}, {"label": "公開希望日", "value": "4 月 1 日"}],
    "next_meeting": {"date": "来週水曜 14:00", "agenda": "見積のレビュー"},
}


@dataclass
class _Res:
    text: str


class _Client:
    """本人の PC の Claude の代役。渡されたプロンプトを記録する。"""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def complete(self, **kw: Any) -> _Res:
        self.calls.append(kw)
        return _Res(
            text=json.dumps(
                {
                    "name": "デザイン確定フェーズ",
                    "description": "A 案の 2 ページ構成を実制作に落とす",
                    "reason": "議事録で「構成は A 案で確定」と決まり、問い合わせフォームの自動返信が"
                    "必須要件として挙がったため。写真素材の担当が未決なので、その確定も含める。",
                },
                ensure_ascii=False,
            )
        )


async def seed(s):
    uid, ws, proj, mid = (str(uuid.uuid4()) for _ in range(4))
    email = f"g187e2e-{uid[:8]}@example.com"
    await s.execute(
        text("insert into auth.users (id,email) values (cast(:u as uuid),:e)"),
        {"u": uid, "e": email},
    )
    await s.execute(
        text(
            "insert into public.users (id,email,display_name) "
            "values (cast(:u as uuid),:e,'G187 E2E')"
        ),
        {"u": uid, "e": email},
    )
    await s.execute(
        text(
            "insert into public.workspaces (id,owner_user_id,name) "
            "values (cast(:w as uuid),cast(:u as uuid),'G187 E2E WS')"
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


async def main() -> None:
    engine = create_async_engine(PG, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    from src.services.meetings import worker as worker_mod
    from src.services.workflow import proposals as svc

    async def _load(path: str) -> dict[str, Any]:
        return dict(STORE[path])

    worker_mod.load_result = _load  # type: ignore[assignment]

    async with factory() as s:
        uid, ws, proj, mid = await seed(s)

        say("=" * 78)
        say("GAP-187  議事録を根拠に次フェーズを提案する (実 PostgreSQL)")
        say("=" * 78)
        say(f"project={proj}")
        say()

        say("── 1. 提案に渡す「議事録の要点」— 要約だけに頼らない")
        digest = svc.meeting_digest(ANALYSIS)
        for line in digest.split("\n"):
            say(f"   {line}")
        say()

        say("── 2. 提案を作る (実行は本人の PC の Claude)")
        client = _Client()
        created = await svc.propose_from_meeting(s, actor_id=uid, meeting_id=mid, client=client)
        await s.commit()
        assert created is not None
        say(f"   提案名   : {created.name}")
        say(f"   概要     : {created.description}")
        say(f"   理由     : {created.reason}")
        say(f"   状態     : {created.status}  (承認前)")
        say(f"   出典議事録: {str(created.source_meeting_id)[:8]}  (= 根拠を隠さない)")
        say()

        say("── 3. LLM に議事録の中身が実際に渡っている")
        sent = str(client.calls[0]["messages"][0].content)
        for needle in (
            "構成は A 案で確定",
            "問い合わせフォームに自動返信",
            "写真素材は誰が用意するか",
            "素材の到着遅れ",
            "80 万円",
            "来週水曜 14:00",
        ):
            say(f"   {needle:<28}: {needle in sent}")
        say(
            f"   「推測で足すな」の指示がある      : "
            f"{'推測で足さない' in str(client.calls[0]['system'])}"
        )
        say()

        say("── 4. 提案するだけ — フェーズは確定していない")
        n = (
            await s.execute(
                text("select count(*) from public.phases where project_id=cast(:p as uuid)"),
                {"p": proj},
            )
        ).scalar_one()
        say(f"   phases の件数: {n}  (承認して初めて工程になる)")
        say()

        say("── 5. 未処理の提案がある間は積み上げない")
        try:
            await svc.propose_from_meeting(s, actor_id=uid, meeting_id=mid, client=_Client())
            say("   2 件目が作れてしまった: ✗")
        except ValueError as e:
            say(f"   2 件目は拒否: {e}")
        say()

        say("── 6. PC 未接続なら嘘の提案を作らない")
        await s.execute(
            text(
                "update public.phase_proposals set status='rejected', "
                "resolved_at=now() where project_id=cast(:p as uuid)"
            ),
            {"p": proj},
        )
        await s.commit()
        from src.services.chat_sse import relay as relay_mod

        real = relay_mod.relay_stream_chunks

        async def offline(*_a, **_k):
            raise relay_mod.RelayUnavailable
            yield ""

        relay_mod.relay_stream_chunks = offline  # type: ignore[assignment]
        before = (
            await s.execute(
                text(
                    "select count(*) from public.phase_proposals where project_id=cast(:p as uuid)"
                ),
                {"p": proj},
            )
        ).scalar_one()
        try:
            await svc.propose_from_meeting(s, actor_id=uid, meeting_id=mid)
            say("   提案が作られてしまった: ✗")
        except svc.PhaseProposalError as e:
            say(f"   code={e.code}")
            say(f"   message={e.message}")
        relay_mod.relay_stream_chunks = real  # type: ignore[assignment]
        after = (
            await s.execute(
                text(
                    "select count(*) from public.phase_proposals where project_id=cast(:p as uuid)"
                ),
                {"p": proj},
            )
        ).scalar_one()
        say(f"   提案行は増えていない: {before == after}  ({before} → {after})")
        say()

        await s.execute(text("delete from public.workspaces where id=cast(:w as uuid)"), {"w": ws})
        await s.execute(text("delete from public.users where id=cast(:u as uuid)"), {"u": uid})
        await s.execute(text("delete from auth.users where id=cast(:u as uuid)"), {"u": uid})
        await s.commit()

        say("=" * 78)
        say("結論: 提案は議事録の決定・要件・未決を根拠に作られ、どの打合せ由来かが残る。")
        say("      提案するだけで確定はせず、PC が未接続なら嘘の提案を残さない。")
        say("=" * 78)

    await engine.dispose()


asyncio.run(main())
