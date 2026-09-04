"""Integration tests for /comments (T-A-22) — 実 Postgres + RLS + JWT。実 DB 無なら skip。"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import time
import uuid
from collections.abc import AsyncGenerator, Iterator
from typing import Annotated

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
JWT_SECRET = "test-jwt-secret"
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", JWT_SECRET)

import sqlalchemy  # noqa: E402
from fastapi import Depends, FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.dependencies import CurrentUser, get_current_user, get_rls_session  # noqa: E402


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _mint_jwt(user_id: str) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    payload = _b64url(
        json.dumps(
            {
                "sub": user_id,
                "role": "authenticated",
                "aud": "authenticated",
                "exp": int(time.time()) + 3600,
            }
        ).encode()
    )
    sig = _b64url(
        hmac.new(
            JWT_SECRET.encode(), f"{header}.{payload}".encode("ascii"), hashlib.sha256
        ).digest()
    )
    return f"{header}.{payload}.{sig}"


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


@pytest.fixture()
def app() -> Iterator[FastAPI]:
    test_engine = create_async_engine(PG_ASYNC, poolclass=NullPool)

    async def _override_session(
        user: Annotated[CurrentUser, Depends(get_current_user)],
    ) -> AsyncGenerator[AsyncSession, None]:
        claims = json.dumps({"sub": user.id, "role": user.role})
        async with AsyncSession(test_engine) as session:
            await session.execute(
                text("select set_config('request.jwt.claims', :c, true)"), {"c": claims}
            )
            await session.execute(text("set local role authenticated"))
            try:
                yield session
            except Exception:
                await session.rollback()
                raise
            else:
                await session.commit()

    from src.routes import api_router

    application = FastAPI()
    application.include_router(api_router)
    application.dependency_overrides[get_rls_session] = _override_session
    yield application
    asyncio.run(test_engine.dispose())


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


@pytest.fixture()
def seeded(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    proj_a, out_a = str(uuid.uuid4()), str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta22-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        for ws, owner in ((ws_a, u_a), (ws_b, u_b)):
            c.execute(
                text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
                {"i": ws, "o": owner, "n": f"ws-{ws[:6]}"},
            )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type) "
                "values (:i,:w,:n,'internal_product')"
            ),
            {"i": proj_a, "w": ws_a, "n": "proj-a"},
        )
        c.execute(
            text(
                "insert into public.workflow_outputs (id,project_id,stage,summary) "
                "values (cast(:i as uuid),cast(:p as uuid),'design','sum')"
            ),
            {"i": out_a, "p": proj_a},
        )
    yield {"u_a": u_a, "u_b": u_b, "ws_a": ws_a, "proj_a": proj_a, "out_a": out_a}
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
def _cleanup_notice_threads(engine: sqlalchemy.Engine, project_id: str) -> None:
    """通知が作った「コメント」スレッドを片づける (次のテストの分母を汚さない)。"""
    with engine.begin() as c:
        c.execute(
            text(
                "delete from public.chat_messages where thread_id in ("
                "  select id from public.chat_threads"
                "   where project_id = cast(:p as uuid) and title = 'コメント')"
            ),
            {"p": project_id},
        )
        c.execute(
            text(
                "delete from public.chat_threads "
                "where project_id = cast(:p as uuid) and title = 'コメント'"
            ),
            {"p": project_id},
        )


class TestComments:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            r = client.get(
                "/comments",
                params={"target_type": "workflow_output", "target_id": str(uuid.uuid4())},
            )
            assert r.status_code == 401

    def test_crud_and_resolve(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        tgt = {"target_type": "workflow_output", "target_id": seeded["out_a"]}
        with TestClient(app) as client:
            r = client.post("/comments", json={**tgt, "content": "hello"}, headers=h)
            assert r.status_code == 201, r.text
            c = r.json()["data"]
            assert c["status"] == "open"
            assert c["author_user_id"] == seeded["u_a"]
            cid = c["id"]

            lst = client.get("/comments", params=tgt, headers=h)
            assert lst.status_code == 200
            assert any(x["id"] == cid for x in lst.json()["data"])
            assert client.get(f"/comments/{cid}", headers=h).status_code == 200

            # 編集 + 解決
            pr = client.patch(
                f"/comments/{cid}", json={"content": "edited", "status": "resolved"}, headers=h
            )
            assert pr.status_code == 200
            assert pr.json()["data"]["content"] == "edited"
            assert pr.json()["data"]["status"] == "resolved"

            # 返信 (スレッド)
            rep = client.post(
                "/comments", json={**tgt, "content": "re", "parent_comment_id": cid}, headers=h
            )
            assert rep.status_code == 201
            assert rep.json()["data"]["parent_comment_id"] == cid

            # 論理削除 → 取得不可
            assert client.delete(f"/comments/{cid}", headers=h).status_code == 204
            assert client.get(f"/comments/{cid}", headers=h).status_code == 404

    def test_gap286_owner_resolves_member_comment_and_gap283_dashboard_shows_it(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """GAP-286: owner は他人 (メンバー) のコメントを解決できる。
        GAP-283 (通し J31-12): メンバーの comment.create が owner のダッシュボード
        recent_activities に出る。"""
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "insert into public.workspace_memberships (workspace_id, user_id, role) "
                    "values (cast(:w as uuid), cast(:u as uuid), 'member') on conflict do nothing"
                ),
                {"w": seeded["ws_a"], "u": seeded["u_b"]},
            )
        try:
            with TestClient(app) as client:
                posted = client.post(
                    "/comments",
                    json={
                        "target_type": "workflow_output",
                        "target_id": seeded["out_a"],
                        "content": "メンバーからの指摘",
                    },
                    headers=_h(seeded["u_b"]),
                )
                assert posted.status_code == 201, posted.text
                cid = posted.json()["data"]["id"]
                # owner が解決できる (以前は 403)
                r = client.patch(
                    f"/comments/{cid}", json={"status": "resolved"}, headers=_h(seeded["u_a"])
                )
                assert r.status_code == 200, r.text
                assert r.json()["data"]["status"] == "resolved"
                # owner のダッシュボードにメンバーの comment.create が出る
                dash = client.get(
                    f"/projects/{seeded['proj_a']}/dashboard", headers=_h(seeded["u_a"])
                )
                assert dash.status_code == 200, dash.text
                actions = [a["action"] for a in dash.json()["data"]["recent_activities"]]
                assert "comment.create" in actions, actions
        finally:
            with sync_engine.begin() as c:
                c.execute(
                    text(
                        "delete from public.workspace_memberships where workspace_id = cast(:w as uuid) "
                        "and user_id = cast(:u as uuid)"
                    ),
                    {"w": seeded["ws_a"], "u": seeded["u_b"]},
                )

    def test_cross_workspace_forbidden_and_invisible(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        tgt = {"target_type": "workflow_output", "target_id": seeded["out_a"]}
        with TestClient(app) as client:
            # 別 WS の user は対象を見られないので作成は 403
            assert (
                client.post("/comments", json={**tgt, "content": "x"}, headers=hb).status_code
                == 403
            )
            # u_a が作成 → u_b からは不可視 (404)
            cid = client.post("/comments", json={**tgt, "content": "mine"}, headers=ha).json()[
                "data"
            ]["id"]
            assert client.get(f"/comments/{cid}", headers=hb).status_code == 404
            assert (
                client.patch(f"/comments/{cid}", json={"content": "hack"}, headers=hb).status_code
                == 404
            )
            client.delete(f"/comments/{cid}", headers=ha)

    def test_誰が書いたのかが名前で分かる(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """GAP-226 — 2026-08-26 の通し J23-02 で見つけた穴。

        `/comments` は `author_user_id` / `author_invitation_id` (UUID) しか返して
        いなかった。画面はそれを見て **「クライアント（招待）」**「メンバー
        8f3bbf48」としか出せない。窓口が 2 人いる案件では **誰が言ったのか
        区別できない**。

        ここで固定するのは 3 つ:
          1. 社内メンバーの書き込みは、その人の表示名で返る
          2. クライアントの書き込みは、招待の表示名で返る
          3. どちらの発言かを画面が見分けられる (`is_client_author`)
        """
        h = _h(seeded["u_a"])
        tgt = {"target_type": "workflow_output", "target_id": seeded["out_a"]}
        with sync_engine.begin() as c:
            c.execute(
                text("update public.users set display_name = :n where id = :i"),
                {"n": "社内の担当者", "i": seeded["u_a"]},
            )
        with TestClient(app) as client:
            r = client.post("/comments", json={**tgt, "content": "社内から"}, headers=h)
            assert r.status_code == 201, r.text
            posted = r.json()["data"]
            assert posted["author_name"] == "社内の担当者", posted
            assert posted["is_client_author"] is False

            got = client.get(f"/comments/{posted['id']}", headers=h).json()["data"]
            assert got["author_name"] == "社内の担当者"

            lst = client.get("/comments", params=tgt, headers=h).json()["data"]
            mine = next(x for x in lst if x["id"] == posted["id"])
            assert mine["author_name"] == "社内の担当者"
            # UUID の断片で代用していない
            assert seeded["u_a"][:8] not in (mine["author_name"] or "")

    def test_gap318_同じ対象に複数の書き手がいても誰の発言か見分けられる(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """SI02-307 (訂正後): 同じ成果物に社内メンバー 2 人 + クライアント窓口が書いても、
        それぞれの **表示名** が出て、社内発かクライアント発かを見分けられる。

        旧行は「クライアント窓口が同じ **タスク** にコメント」を前提にしていたが、
        クライアントが書けるのは成果物 / モックだけ (R-T08 の最小開示) で、
        タスクは社内専用。前提が仕様と矛盾していたため永久に BLOCKED だった。
        """
        import hashlib as _hashlib

        tgt = {"target_type": "workflow_output", "target_id": seeded["out_a"]}
        inv = str(uuid.uuid4())
        token = "client-token-si02307-aaaa"
        with sync_engine.begin() as c:
            c.execute(
                text("update public.users set display_name = :n where id = :i"),
                {"n": "高本まさと", "i": seeded["u_a"]},
            )
            c.execute(
                text("update public.users set display_name = :n where id = :i"),
                {"n": "佐藤ゆい", "i": seeded["u_b"]},
            )
            c.execute(
                text(
                    "insert into public.workspace_memberships (workspace_id, user_id, role) "
                    "values (cast(:w as uuid), cast(:u as uuid), 'member') on conflict do nothing"
                ),
                {"w": seeded["ws_a"], "u": seeded["u_b"]},
            )
            c.execute(
                text(
                    "insert into public.client_invitations"
                    "(id,project_id,email,token_hash,scopes,expires_at,client_display_name) "
                    "values (cast(:i as uuid),cast(:p as uuid),:e,:h,"
                    "'[\"view\",\"comment\"]'::jsonb, now() + interval '7 days', :n)"
                ),
                {
                    "i": inv,
                    "p": seeded["proj_a"],
                    "e": "kokyaku@ext.example.com",
                    "h": _hashlib.sha256(token.encode()).hexdigest(),
                    "n": "顧客の田中様",
                },
            )
        try:
            with TestClient(app) as client:
                assert (
                    client.post(
                        "/comments",
                        json={**tgt, "content": "A から"},
                        headers=_h(seeded["u_a"]),
                    ).status_code
                    == 201
                )
                assert (
                    client.post(
                        "/comments",
                        json={**tgt, "content": "B から"},
                        headers=_h(seeded["u_b"]),
                    ).status_code
                    == 201
                )
                ct = client.post(
                    "/client/auth/signin",
                    json={
                        "invitation_token": token,
                        "agree_legal": True,
                        "agree_confidential": True,
                    },
                )
                assert ct.status_code == 200, ct.text
                ctok = ct.json()["data"]["client_access_token"]
                posted = client.post(
                    f"/client/projects/{seeded['proj_a']}/comments",
                    json={
                        "target_type": "workflow_output",
                        "target_id": seeded["out_a"],
                        "content": "クライアントから",
                    },
                    headers={"Authorization": f"Bearer {ctok}"},
                )
                assert posted.status_code == 201, posted.text
                # クライアントは **タスク** にはコメントできない (社内専用・設計どおり)
                assert (
                    client.post(
                        f"/client/projects/{seeded['proj_a']}/comments",
                        json={
                            "target_type": "task",
                            "target_id": str(uuid.uuid4()),
                            "content": "task へ",
                        },
                        headers={"Authorization": f"Bearer {ctok}"},
                    ).status_code
                    == 422
                )
                lst = client.get("/comments", params=tgt, headers=_h(seeded["u_a"])).json()["data"]
                # SI02-307 の対象 = タスク詳細のコメント。社内 2 人で同じことを確かめる
                task_id = str(uuid.uuid4())
                with sync_engine.begin() as c2:
                    c2.execute(
                        text(
                            "insert into public.tasks (id, project_id, title, category, type, "
                            " estimated_hours, priority) values (cast(:i as uuid), cast(:p as uuid), "
                            " 'SI02-307 表示名', 'backend', 'feature', 1, 'high')"
                        ),
                        {"i": task_id, "p": seeded["proj_a"]},
                    )
                ttgt = {"target_type": "task", "target_id": task_id}
                for uid, body in (
                    (seeded["u_a"], "タスクへ A から"),
                    (seeded["u_b"], "タスクへ B から"),
                ):
                    assert (
                        client.post(
                            "/comments", json={**ttgt, "content": body}, headers=_h(uid)
                        ).status_code
                        == 201
                    )
                tlist = client.get("/comments", params=ttgt, headers=_h(seeded["u_a"])).json()[
                    "data"
                ]
                tnames = {x["content"]: x["author_name"] for x in tlist}
                assert tnames["タスクへ A から"] == "高本まさと"
                assert tnames["タスクへ B から"] == "佐藤ゆい"
            by_content = {x["content"]: x for x in lst}
            assert by_content["A から"]["author_name"] == "高本まさと"
            assert by_content["B から"]["author_name"] == "佐藤ゆい"
            assert by_content["クライアントから"]["author_name"] == "顧客の田中様"
            assert by_content["A から"]["is_client_author"] is False
            assert by_content["B から"]["is_client_author"] is False
            assert by_content["クライアントから"]["is_client_author"] is True
            # 種別だけ / UUID の断片で代用していない
            for x in by_content.values():
                assert x["author_name"] not in ("クライアント（招待）", "メンバー")
        finally:
            with sync_engine.begin() as c:
                c.execute(
                    text(
                        "delete from public.comments where author_invitation_id = cast(:i as uuid)"
                    ),
                    {"i": inv},
                )
                c.execute(
                    text("delete from public.client_invitations where id = cast(:i as uuid)"),
                    {"i": inv},
                )
                c.execute(
                    text("delete from public.comments where target_type = 'task'"),
                )
                c.execute(text("delete from public.tasks where title = 'SI02-307 表示名'"))

    def test_名前が引けなくても行は消えない(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """名前を **left** join で引く理由を固定する。

        inner join にすると「表示名が未設定の人のコメントが一覧から消える」。
        誰の発言か分からないより、**発言そのものが消えるほうがずっと悪い**。
        """
        h = _h(seeded["u_a"])
        tgt = {"target_type": "workflow_output", "target_id": seeded["out_a"]}
        with sync_engine.begin() as c:
            c.execute(
                text("update public.users set display_name = null where id = :i"),
                {"i": seeded["u_a"]},
            )
        with TestClient(app) as client:
            r = client.post("/comments", json={**tgt, "content": "名無しの書き込み"}, headers=h)
            assert r.status_code == 201, r.text
            assert r.json()["data"]["author_name"] is None
            lst = client.get("/comments", params=tgt, headers=h).json()["data"]
            assert any(x["content"] == "名無しの書き込み" for x in lst), "行が消えている"

    def test_unresolved_count_by_project(self, app: FastAPI, seeded: dict[str, str]) -> None:
        """GAP-005: プロジェクト横断の未解決コメント集計 (open のみ、解決/削除は除外)。"""
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        tgt = {"target_type": "workflow_output", "target_id": seeded["out_a"]}
        with TestClient(app) as client:
            url = f"/comments/unresolved-count?project_id={seeded['proj_a']}"
            base = client.get(url, headers=ha).json()["data"]["count"]
            c1 = client.post("/comments", json={**tgt, "content": "未解決1"}, headers=ha).json()[
                "data"
            ]["id"]
            c2 = client.post("/comments", json={**tgt, "content": "未解決2"}, headers=ha).json()[
                "data"
            ]["id"]
            assert client.get(url, headers=ha).json()["data"]["count"] == base + 2
            # 解決すると減る
            client.patch(f"/comments/{c1}", json={"status": "resolved"}, headers=ha)
            assert client.get(url, headers=ha).json()["data"]["count"] == base + 1
            # 削除でも減る
            client.delete(f"/comments/{c2}", headers=ha)
            assert client.get(url, headers=ha).json()["data"]["count"] == base
            # 越境 user は対象が不可視なので 0 (RLS)
            assert client.get(url, headers=hb).json()["data"]["count"] == 0

    def test_gap299_コメントは担当AI社員のスレッドに届く(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """GAP-299 (通し J46-03 / J45-09 / J48-05): 成果物にコメントしても
        担当 AI 社員には何も届かず、指摘が次の作業につながらなかった。

        届け先は「その社員のプロジェクトチャット」。system メッセージとして積むので、
        次にその社員へ話しかけたときの文脈にそのまま乗る。

        **誰に届くか**は「部門 → COO → 既定」で決まる (成果物に担当欄は無い)。
        本番の workspace には運営テンプレから実体化された社員が既にいるので、
        「テストが作った特定の 1 人」ではなく **工程のハブ (COO) に届くこと**を見る。
        """
        h = _h(seeded["u_a"])
        tgt = {"target_type": "workflow_output", "target_id": seeded["out_a"]}
        with TestClient(app) as client:
            r = client.post(
                "/comments", json={**tgt, "content": "ここの数字を直してほしい"}, headers=h
            )
            assert r.status_code == 201, r.text
            cid = r.json()["data"]["id"]
        with sync_engine.connect() as c:
            msg = c.execute(
                text(
                    "select m.content, m.role, e.role as emp_role, e.department "
                    "from public.chat_messages m "
                    "join public.chat_threads t on t.id = m.thread_id "
                    "join public.ai_employees e on e.id = t.ai_employee_id "
                    "where t.project_id = cast(:p as uuid) and m.role = 'system' "
                    "order by m.created_at desc limit 1"
                ),
                {"p": seeded["proj_a"]},
            ).first()
            assert msg is not None, "担当 AI 社員のスレッドに何も積まれていない"
            assert "ここの数字を直してほしい" in msg.content
            assert "成果物" in msg.content
            assert str(msg.emp_role) == "coo" or str(msg.department) == "executive"
            # 送信の痕跡が監査ログに残る (届いたことを後から確かめられる)
            n = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action='comment.assignee_notified' and target_id=:t"
                ),
                {"t": cid},
            ).scalar_one()
            assert n == 1
        _cleanup_notice_threads(sync_engine, seeded["proj_a"])

    def test_gap299_担当が決まっていない対象でも宛先が決まる(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """モック / 成果物には担当欄が無い。部門 → COO → 既定 の順で宛先を決めるので、
        「担当が空だから通知しない」で消えることはない。モックなら **design 部門**。"""
        mock_id = str(uuid.uuid4())
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "insert into public.mocks (id, project_id, screen_name, html_storage_path) "
                    "values (cast(:i as uuid), cast(:p as uuid), 'ログイン画面', 'mockdb://x')"
                ),
                {"i": mock_id, "p": seeded["proj_a"]},
            )
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/comments",
                json={"target_type": "mock", "target_id": mock_id, "content": "余白が広い"},
                headers=h,
            )
            assert r.status_code == 201, r.text
        with sync_engine.connect() as c:
            got = c.execute(
                text(
                    "select m.content, e.department from public.chat_messages m "
                    "join public.chat_threads t on t.id = m.thread_id "
                    "join public.ai_employees e on e.id = t.ai_employee_id "
                    "where t.project_id = cast(:p as uuid) and m.role = 'system' "
                    "order by m.created_at desc limit 1"
                ),
                {"p": seeded["proj_a"]},
            ).first()
            assert got is not None, "design 部門の社員に届いていない"
            assert "余白が広い" in got.content
            assert "モック" in got.content
            assert str(got.department) == "design", f"宛先の部門が違う: {got.department}"
        with sync_engine.begin() as c:
            c.execute(
                text("delete from public.comments where target_id = cast(:m as uuid)"),
                {"m": mock_id},
            )
            c.execute(text("delete from public.mocks where id = cast(:m as uuid)"), {"m": mock_id})
        _cleanup_notice_threads(sync_engine, seeded["proj_a"])
