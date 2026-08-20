"""GAP-186: 議事録の抽出項目を「確認して採用」する unit tests (実 PG)。

経営者指示「1,2 だね」の ①（確認して採用 → 要件に追加）。

固定する挙動:
  - **自動反映しない**。人が選んだものだけが実データになる
  - 要件・アクション → tasks / 決定事項 → decisions(decided) /
    未決事項 → decisions(unresolved)
  - 引用 (quote) を必ず本文に残す = 創作でないか人が確かめられる
  - 二重採用しても増えない
  - 解析がまだ無い議事録には、嘘をつかず正直に断る
"""

# pyright: reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownVariableType=false
from __future__ import annotations

import os
import uuid
from typing import Any

import pytest
import sqlalchemy
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from src.services.meetings import adopt as adopt_svc

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
    "summary": "LP 制作の要件を確認した。",
    "agenda": ["現状の課題", "予算と納期"],
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
    ],
    "action_items": [
        {
            "title": "見積ドラフト作成",
            "owner": "ワンダ",
            "due": "今週金曜",
            "quote": "金曜までに見積もりをください",
        }
    ],
    "decisions": [
        {
            "title": "構成は A 案で確定",
            "detail": "トップ + 問い合わせの 2 ページ構成",
            "decided_by": "田中",
            "quote": "じゃあ A 案でいきましょう",
        }
    ],
    "open_questions": [
        {
            "question": "写真素材は誰が用意するか",
            "context": "既存素材の権利が不明",
            "quote": "写真ってこちらで用意するんでしたっけ",
        }
    ],
    # 反映先を持たない (読むためのもの)
    "risks": [{"title": "素材の到着遅れ", "impact": "公開日が後ろ倒し"}],
    "facts": [{"label": "予算", "value": "80 万円"}],
}


@pytest.fixture
async def session():
    engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        yield s
    await engine.dispose()


@pytest.fixture(autouse=True)
def _stub_storage(monkeypatch: pytest.MonkeyPatch):
    """この環境に Supabase Storage が無いので結果 JSON の置き場だけ差し替える。

    解析結果の中身・採用ロジック・DB 書き込みはすべて本物を通す。
    """
    store: dict[str, dict[str, Any]] = {}

    async def _load(path: str) -> dict[str, Any]:
        if path not in store:
            raise KeyError(path)
        return dict(store[path])

    from src.services.meetings import worker as worker_mod

    monkeypatch.setattr(worker_mod, "load_result", _load)
    return store


async def _seed(session: AsyncSession, store: dict[str, Any], *, analysis: Any) -> dict[str, str]:
    uid, ws, proj, mid = (str(uuid.uuid4()) for _ in range(4))
    email = f"g186-{uid[:8]}@example.com"
    await session.execute(
        text("insert into auth.users (id,email) values (cast(:u as uuid),:e)"),
        {"u": uid, "e": email},
    )
    await session.execute(
        text(
            "insert into public.users (id,email,display_name) values (cast(:u as uuid),:e,'G186')"
        ),
        {"u": uid, "e": email},
    )
    await session.execute(
        text(
            "insert into public.workspaces (id,owner_user_id,name) "
            "values (cast(:w as uuid),cast(:u as uuid),'G186 WS')"
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
            "values (cast(:p as uuid),cast(:w as uuid),'G186案件','client_work','active')"
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
            " :sp, '打合せ.mp3', 1024, 'audio/mpeg', now(), :rp)"
        ),
        {"i": mid, "p": proj, "u": uid, "sp": f"meetings/{mid}.mp3", "rp": rpath},
    )
    await session.commit()
    return {"user": uid, "project": proj, "meeting": mid}


def _key(items: list[adopt_svc.AdoptableItem], title: str) -> str:
    for i in items:
        if i.title == title:
            return i.key
    raise AssertionError(f"{title} が採用候補に無い")


class TestWhatCanBeAdopted:
    async def test_only_items_with_a_destination_are_offered(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        """リスク・数値・議題はタスク化しない (台帳をノイズで埋めない)。"""
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        items = await adopt_svc.list_adoptable(session, meeting_id=env["meeting"])
        kinds = {i.kind for i in items}
        assert kinds == {"requirement", "action", "decision", "open_question"}
        titles = {i.title for i in items}
        assert "素材の到着遅れ" not in titles  # リスクは出さない
        assert "問い合わせフォームに自動返信" in titles

    async def test_every_item_carries_its_quote(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        """引用があるから「創作していないか」を人が確かめられる。"""
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        items = await adopt_svc.list_adoptable(session, meeting_id=env["meeting"])
        by_title = {i.title: i for i in items}
        assert by_title["問い合わせフォームに自動返信"].quote == "自動返信は絶対に欲しいです"
        assert by_title["構成は A 案で確定"].quote == "じゃあ A 案でいきましょう"

    async def test_nothing_is_created_until_a_person_adopts(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        """一覧を見ただけでは実データは 1 件も増えない (自動反映しない)。"""
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        await adopt_svc.list_adoptable(session, meeting_id=env["meeting"])
        for table in ("tasks", "decisions"):
            count = (
                await session.execute(
                    text(
                        f"select count(*) from public.{table} where project_id = cast(:p as uuid)"
                    ),
                    {"p": env["project"]},
                )
            ).scalar_one()
            assert int(count) == 0

    async def test_empty_titles_are_dropped(self) -> None:
        out = adopt_svc.extract_items({"requirements": [{"title": "  "}, {"title": "本物"}]})
        assert [i["title"] for i in out] == ["本物"]

    async def test_key_is_stable_across_whitespace(self) -> None:
        assert adopt_svc.item_key("requirement", "自動 返信") == adopt_svc.item_key(
            "requirement", " 自動  返信 "
        )


class TestAdoptCreatesRealRecords:
    async def test_requirement_becomes_a_task_with_the_quote(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        items = await adopt_svc.list_adoptable(session, meeting_id=env["meeting"])
        key = _key(items, "問い合わせフォームに自動返信")

        result = await adopt_svc.adopt(
            session, meeting_id=env["meeting"], actor_id=env["user"], keys=[key]
        )
        await session.commit()
        assert len(result.created) == 1
        assert result.created[0]["target_type"] == "task"

        row = (
            await session.execute(
                text(
                    "select title, description, type, priority, category from public.tasks "
                    "where id = cast(:i as uuid)"
                ),
                {"i": result.created[0]["target_id"]},
            )
        ).first()
        assert row is not None
        assert row.title == "問い合わせフォームに自動返信"
        assert str(row.type) == "feature"  # functional → feature
        assert str(row.priority) == "high"  # must → high
        assert "自動返信は絶対に欲しいです" in row.description  # 引用が残る
        assert "工数" in row.description  # 未確定であることを隠さない
        assert "議事録" in row.category

    async def test_non_functional_requirement_maps_to_infrastructure(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        items = await adopt_svc.list_adoptable(session, meeting_id=env["meeting"])
        result = await adopt_svc.adopt(
            session,
            meeting_id=env["meeting"],
            actor_id=env["user"],
            keys=[_key(items, "スマホ表示を優先")],
        )
        await session.commit()
        row = (
            await session.execute(
                text("select type, priority from public.tasks where id = cast(:i as uuid)"),
                {"i": result.created[0]["target_id"]},
            )
        ).first()
        assert row is not None
        assert str(row.type) == "infrastructure"
        assert str(row.priority) == "medium"  # should → medium

    async def test_action_keeps_owner_and_due(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        items = await adopt_svc.list_adoptable(session, meeting_id=env["meeting"])
        result = await adopt_svc.adopt(
            session,
            meeting_id=env["meeting"],
            actor_id=env["user"],
            keys=[_key(items, "見積ドラフト作成")],
        )
        await session.commit()
        desc = (
            await session.execute(
                text("select description from public.tasks where id = cast(:i as uuid)"),
                {"i": result.created[0]["target_id"]},
            )
        ).scalar_one()
        assert "ワンダ" in desc and "今週金曜" in desc

    async def test_decision_and_open_question_land_in_decisions(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        """決まったことと、まだ決まっていないことを区別して残す。"""
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        items = await adopt_svc.list_adoptable(session, meeting_id=env["meeting"])
        result = await adopt_svc.adopt(
            session,
            meeting_id=env["meeting"],
            actor_id=env["user"],
            keys=[_key(items, "構成は A 案で確定"), _key(items, "写真素材は誰が用意するか")],
        )
        await session.commit()
        rows = (
            await session.execute(
                text(
                    "select status, body, reflected_to, with_user from public.decisions "
                    "where project_id = cast(:p as uuid) order by created_at"
                ),
                {"p": env["project"]},
            )
        ).all()
        assert len(result.created) == 2
        statuses = {str(r.status) for r in rows}
        assert statuses == {"decided", "unresolved"}
        # どこから来たかが辿れる + 人が決めたものだと分かる
        assert all("議事録" in str(r.reflected_to) for r in rows)
        assert all(r.with_user is True for r in rows)
        assert any("じゃあ A 案でいきましょう" in str(r.body) for r in rows)

    async def test_adopting_twice_does_not_duplicate(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        """二重に押しても増えない。正直に「すでに採用済み」と返す。"""
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        items = await adopt_svc.list_adoptable(session, meeting_id=env["meeting"])
        key = _key(items, "問い合わせフォームに自動返信")
        await adopt_svc.adopt(session, meeting_id=env["meeting"], actor_id=env["user"], keys=[key])
        await session.commit()

        again = await adopt_svc.adopt(
            session, meeting_id=env["meeting"], actor_id=env["user"], keys=[key]
        )
        await session.commit()
        assert again.created == []
        assert again.already == [key]
        assert "すでに採用済み" in again.message

        count = (
            await session.execute(
                text("select count(*) from public.tasks where project_id = cast(:p as uuid)"),
                {"p": env["project"]},
            )
        ).scalar_one()
        assert int(count) == 1

    async def test_adopted_items_are_marked_and_linked(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        """採用済みは一覧で分かり、反映先へ辿れる。"""
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        items = await adopt_svc.list_adoptable(session, meeting_id=env["meeting"])
        key = _key(items, "見積ドラフト作成")
        await adopt_svc.adopt(session, meeting_id=env["meeting"], actor_id=env["user"], keys=[key])
        await session.commit()

        after = await adopt_svc.list_adoptable(session, meeting_id=env["meeting"])
        hit = next(i for i in after if i.key == key)
        assert hit.adopted is True
        assert hit.target_type == "task"
        assert hit.target_id is not None
        others = [i for i in after if i.key != key]
        assert all(i.adopted is False for i in others)


class TestHonestFailures:
    async def test_unknown_key_is_reported_not_silently_skipped(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        result = await adopt_svc.adopt(
            session, meeting_id=env["meeting"], actor_id=env["user"], keys=["requirement:でたらめ"]
        )
        await session.commit()
        assert result.created == []
        assert result.missing == ["requirement:でたらめ"]
        assert "見つからず" in result.message

    async def test_meeting_without_analysis_is_refused_clearly(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        env = await _seed(session, _stub_storage, analysis=None)
        with pytest.raises(adopt_svc.AdoptError) as ei:
            await adopt_svc.list_adoptable(session, meeting_id=env["meeting"])
        assert ei.value.code == "invalid_state"
        assert "構造化解析の結果がありません" in ei.value.message

    async def test_pending_analysis_points_at_the_resume_button(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        """GAP-185 の「解析を再開」へ誘導する (行き止まりにしない)。"""
        env = await _seed(session, _stub_storage, analysis=None)
        await session.execute(
            text(
                "update public.external_uploads set analysis_pending_since = now() "
                "where id = cast(:i as uuid)"
            ),
            {"i": env["meeting"]},
        )
        await session.commit()
        with pytest.raises(adopt_svc.AdoptError) as ei:
            await adopt_svc.list_adoptable(session, meeting_id=env["meeting"])
        assert "解析を再開" in ei.value.message

    async def test_missing_meeting_is_reported(self, session: AsyncSession) -> None:
        with pytest.raises(adopt_svc.AdoptError) as ei:
            await adopt_svc.list_adoptable(session, meeting_id=str(uuid.uuid4()))
        assert ei.value.code == "not_found"

    async def test_empty_selection_is_rejected(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        with pytest.raises(adopt_svc.AdoptError) as ei:
            await adopt_svc.adopt(session, meeting_id=env["meeting"], actor_id=env["user"], keys=[])
        assert ei.value.code == "invalid_state"

    async def test_bulk_selection_is_capped(
        self, session: AsyncSession, _stub_storage: dict[str, Any]
    ) -> None:
        env = await _seed(session, _stub_storage, analysis=ANALYSIS)
        with pytest.raises(adopt_svc.AdoptError) as ei:
            await adopt_svc.adopt(
                session,
                meeting_id=env["meeting"],
                actor_id=env["user"],
                keys=[f"requirement:{i}" for i in range(adopt_svc.MAX_ADOPT_PER_CALL + 1)],
            )
        assert ei.value.code == "too_many"
