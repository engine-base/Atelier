"""GAP-187: 議事録からフェーズを提案する unit tests (実 PG)。

経営者指示「1,2 だね」の ②（さらにフェーズ提案まで）。

固定する挙動:
  - 提案の根拠に**議事録の決定・要件・未決事項**が入る（要約だけに頼らない）
  - **提案するだけで確定しない**（承認は既存フローで人が行う）
  - どの打合せ由来かを残す（根拠を隠さない）
  - 解析が無い / PC 未接続 / 枠上限は、嘘の提案を作らず正直に断る
"""

# pyright: reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false
# pyright: reportUnusedFunction=false, reportMissingParameterType=false
from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from typing import Any

import pytest
import sqlalchemy
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from src.services.workflow import proposals as proposal_svc

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")


def _db_available() -> bool:
    try:
        eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
        try:
            with eng.connect() as c:
                c.execute(text("select 1"))
        finally:
            eng.dispose()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="local Postgres not available")

ANALYSIS: dict[str, Any] = {
    "summary": "LP 制作の要件・予算・納期を確認し、構成を A 案に確定した。",
    "decisions": [{"title": "構成は A 案で確定", "detail": "トップ + 問い合わせの 2 ページ構成"}],
    "requirements": [
        {"title": "問い合わせフォームに自動返信", "detail": "サンクスメール", "priority": "must"}
    ],
    "open_questions": [{"question": "写真素材は誰が用意するか", "context": "権利が不明"}],
    "risks": [{"title": "素材の到着遅れ", "impact": "公開日が後ろ倒し"}],
    "facts": [{"label": "予算", "value": "80 万円"}, {"label": "公開希望日", "value": "4 月 1 日"}],
    "next_meeting": {"date": "来週水曜 14:00", "agenda": "見積のレビュー"},
}


@dataclass
class _FakeResponse:
    text: str


class _FakeClient:
    """注入クライアント。渡されたプロンプトを記録して固定の JSON を返す。"""

    def __init__(self, reply: str | None = None) -> None:
        self.reply = reply or json.dumps(
            {
                "name": "デザイン確定フェーズ",
                "description": "A 案の 2 ページ構成を実制作に落とす",
                "reason": "議事録で「構成は A 案で確定」と決まり、"
                "問い合わせフォームの自動返信が必須要件として挙がったため。",
            },
            ensure_ascii=False,
        )
        self.calls: list[dict[str, Any]] = []

    async def complete(self, **kwargs: Any) -> _FakeResponse:
        self.calls.append(kwargs)
        return _FakeResponse(text=self.reply)


@pytest.fixture
async def session():
    engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        yield s
    await engine.dispose()


@pytest.fixture(autouse=True)
def _stub_storage(monkeypatch: pytest.MonkeyPatch):
    store: dict[str, dict[str, Any]] = {}

    async def _load(path: str) -> dict[str, Any]:
        return dict(store[path])

    from src.services.meetings import worker as worker_mod

    monkeypatch.setattr(worker_mod, "load_result", _load)
    return store


async def _seed(session: AsyncSession, store: dict[str, Any], *, analysis: Any) -> dict[str, str]:
    uid, ws, proj, mid = (str(uuid.uuid4()) for _ in range(4))
    email = f"g187-{uid[:8]}@example.com"
    await session.execute(
        text("insert into auth.users (id,email) values (cast(:u as uuid),:e)"),
        {"u": uid, "e": email},
    )
    await session.execute(
        text(
            "insert into public.users (id,email,display_name) values (cast(:u as uuid),:e,'G187')"
        ),
        {"u": uid, "e": email},
    )
    await session.execute(
        text(
            "insert into public.workspaces (id,owner_user_id,name) "
            "values (cast(:w as uuid),cast(:u as uuid),'G187 WS')"
        ),
        {"w": ws, "u": uid},
    )
    await session.execute(
        text(
            "insert into public.workspace_memberships (workspace_id,user_id,role) "
            "values (cast(:w as uuid),cast(:u as uuid),'owner') on conflict do nothing"
        ),
        {"w": ws, "u": uid},
    )
    await session.execute(
        text(
            "insert into public.projects (id,workspace_id,name,project_type,status) "
            "values (cast(:p as uuid),cast(:w as uuid),'LP 制作','client_work','active')"
        ),
        {"p": proj, "w": ws},
    )
    rpath = f"transcripts/results/{mid}.json"
    payload: dict[str, Any] = {"text": "打合せ本文"}
    if analysis is not None:
        payload["analysis"] = analysis
    store[rpath] = payload
    await session.execute(
        text(
            "insert into public.external_uploads "
            "(id, project_id, uploaded_by_user_id, type, storage_path, file_name, "
            " file_size_bytes, mime_type, parsed_at, parse_result_path) "
            "values (cast(:i as uuid), cast(:p as uuid), cast(:u as uuid), 'audio', "
            " :sp, '打合せ_0820.mp3', 1024, 'audio/mpeg', now(), :rp)"
        ),
        {"i": mid, "p": proj, "u": uid, "sp": f"meetings/{mid}.mp3", "rp": rpath},
    )
    await session.commit()
    return {"user": uid, "project": proj, "meeting": mid}


class TestDigestUsesTheWholeMeeting:
    def test_digest_carries_decisions_requirements_and_open_questions(self) -> None:
        """要約だけに頼らない (GAP-184 で厚くした解析を活かす)。"""
        d = proposal_svc.meeting_digest(ANALYSIS)
        assert "決まったこと" in d and "構成は A 案で確定" in d
        assert "出た要件" in d and "問い合わせフォームに自動返信" in d
        assert "未決事項" in d and "写真素材は誰が用意するか" in d
        assert "リスク・懸念" in d and "素材の到着遅れ" in d

    def test_digest_carries_numbers_and_next_meeting(self) -> None:
        d = proposal_svc.meeting_digest(ANALYSIS)
        assert "80 万円" in d and "4 月 1 日" in d
        assert "来週水曜 14:00" in d

    def test_empty_analysis_yields_empty_digest(self) -> None:
        assert proposal_svc.meeting_digest({}) == ""

    def test_malformed_entries_are_skipped(self) -> None:
        d = proposal_svc.meeting_digest(
            {"decisions": ["文字列だけ", {"title": ""}, {"title": "本物"}]}
        )
        assert "本物" in d and "文字列だけ" not in d


class TestProposeFromMeeting:
    async def test_proposal_is_grounded_in_the_meeting(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        client = _FakeClient()
        created = await proposal_svc.propose_from_meeting(
            session, actor_id=env["user"], meeting_id=env["meeting"], client=client
        )
        await session.commit()
        assert created is not None
        assert created.name == "デザイン確定フェーズ"
        assert "A 案" in created.reason

        # LLM へ実際に議事録の中身が渡っている
        sent = str(client.calls[0]["messages"][0].content)
        assert "構成は A 案で確定" in sent
        assert "問い合わせフォームに自動返信" in sent
        assert "写真素材は誰が用意するか" in sent
        # 「議事録に無いことを足すな」が system で指示されている
        assert "推測で足さない" in str(client.calls[0]["system"])

    async def test_proposal_records_which_meeting_it_came_from(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        """根拠を隠さない — どの打合せ由来かを残す。"""
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        created = await proposal_svc.propose_from_meeting(
            session, actor_id=env["user"], meeting_id=env["meeting"], client=_FakeClient()
        )
        await session.commit()
        assert created is not None
        assert created.source_meeting_id == env["meeting"]

    async def test_proposal_does_not_create_a_phase(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        """提案するだけ。確定は人が承認して初めて起きる。"""
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        created = await proposal_svc.propose_from_meeting(
            session, actor_id=env["user"], meeting_id=env["meeting"], client=_FakeClient()
        )
        await session.commit()
        assert created is not None and created.status == "pending"
        count = (
            await session.execute(
                text("select count(*) from public.phases where project_id = cast(:p as uuid)"),
                {"p": env["project"]},
            )
        ).scalar_one()
        assert int(count) == 0

    async def test_second_proposal_while_one_is_pending_is_refused(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        """未処理の提案を積み上げない (人が捌けなくなる)。"""
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        await proposal_svc.propose_from_meeting(
            session, actor_id=env["user"], meeting_id=env["meeting"], client=_FakeClient()
        )
        await session.commit()
        with pytest.raises(ValueError):
            await proposal_svc.propose_from_meeting(
                session, actor_id=env["user"], meeting_id=env["meeting"], client=_FakeClient()
            )

    async def test_missing_meeting_returns_none(self, session: AsyncSession) -> None:
        assert (
            await proposal_svc.propose_from_meeting(
                session, actor_id=str(uuid.uuid4()), meeting_id=str(uuid.uuid4())
            )
            is None
        )


class TestHonestFailures:
    async def test_meeting_without_analysis_is_refused(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        """解析が無いのに、それらしい提案をでっち上げない。"""
        env = await _seed(session, _stub_storage, analysis=None)
        with pytest.raises(proposal_svc.PhaseProposalError) as ei:
            await proposal_svc.propose_from_meeting(
                session, actor_id=env["user"], meeting_id=env["meeting"], client=_FakeClient()
            )
        assert ei.value.code == "analysis_missing"

    async def test_analysis_with_nothing_useful_is_refused(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        env = await _seed(session, _stub_storage, analysis={"speakers": [{"name": "田中"}]})
        with pytest.raises(proposal_svc.PhaseProposalError) as ei:
            await proposal_svc.propose_from_meeting(
                session, actor_id=env["user"], meeting_id=env["meeting"], client=_FakeClient()
            )
        assert ei.value.code == "analysis_missing"
        assert "根拠になる内容がありません" in ei.value.message

    async def test_bridge_offline_is_reported_not_faked(
        self, session: AsyncSession, _stub_storage: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """PC 未接続なら提案を作らない (嘘の提案を残さない)。"""
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        from src.services.chat_sse import relay as relay_mod

        async def _offline(*_a: object, **_k: object):
            raise relay_mod.RelayUnavailable
            yield ""

        monkeypatch.delenv("ATELIER_ALLOW_FAKE_LLM", raising=False)
        monkeypatch.setattr(relay_mod, "relay_stream_chunks", _offline)
        with pytest.raises(proposal_svc.PhaseProposalError) as ei:
            await proposal_svc.propose_from_meeting(
                session, actor_id=env["user"], meeting_id=env["meeting"]
            )
        assert ei.value.code == "bridge_offline"

        count = (
            await session.execute(
                text(
                    "select count(*) from public.phase_proposals "
                    "where project_id = cast(:p as uuid)"
                ),
                {"p": env["project"]},
            )
        ).scalar_one()
        assert int(count) == 0

    async def test_rate_limit_is_not_a_permanent_failure(
        self, session: AsyncSession, _stub_storage: dict[str, Any], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """枠の上限は必ずリセットされる。恒久的な失敗と混ぜない (GAP-184)。"""
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        from src.services.chat_sse import llm_chain

        async def _limited(**_kw: Any) -> tuple[str, str]:
            raise llm_chain.LLMUnavailable("rate_limited", "枠の上限です")

        monkeypatch.setattr(llm_chain, "llm_complete_or_injected", _limited)
        with pytest.raises(proposal_svc.PhaseProposalError) as ei:
            await proposal_svc.propose_from_meeting(
                session, actor_id=env["user"], meeting_id=env["meeting"]
            )
        assert ei.value.code == "rate_limited"

    async def test_non_json_reply_is_refused(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        with pytest.raises(proposal_svc.PhaseProposalError) as ei:
            await proposal_svc.propose_from_meeting(
                session,
                actor_id=env["user"],
                meeting_id=env["meeting"],
                client=_FakeClient("すみません、提案できません。"),
            )
        assert ei.value.code == "llm_failed"
