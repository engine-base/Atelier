"""Integration tests for /chat/threads (T-A-16) — 実 Postgres + RLS + JWT。

user + workspace(owner) + project + ai_employee を seed し thread CRUD を検証。
実 DB 無なら skip。
"""

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
from tests.routes._fixtures import ensure_ai_employee  # noqa: E402


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
    u_a, u_b, u_v = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    proj_a, emp_a = str(uuid.uuid4()), str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b, u_v):
            em = f"ta16-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        for ws, owner in ((ws_a, u_a), (ws_b, u_b)):
            c.execute(
                text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
                {"i": ws, "o": owner, "n": f"ws-{ws[:6]}"},
            )
        # u_v を ws_a の viewer として追加 (閲覧可・投稿不可の検証用)
        c.execute(
            text(
                "insert into public.workspace_memberships (workspace_id,user_id,role) "
                "values (cast(:w as uuid),cast(:u as uuid),'viewer')"
            ),
            {"w": ws_a, "u": u_v},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type) values (:i,:w,:n,'internal_product')"
            ),
            {"i": proj_a, "w": ws_a, "n": "proj-a"},
        )
        # ローカル dev DB は workspace 作成トリガーが 10 名を自動シードするため
        # (CI のクリーン DB では no-op)、先に消してから固定 id の tony を入れる
        # (test_skills と同パターン)。
        c.execute(
            text("delete from public.ai_employees where workspace_id = cast(:w as uuid)"),
            {"w": ws_a},
        )
        # GAP-173: 運営シードが入った DB ではトリガが既に tony を作っている
        emp_a = ensure_ai_employee(
            c,
            workspace_id=ws_a,
            name="tony",
            display_name="トニー",
            role="lead",
            department="sales",
            employee_id=emp_a,
        )
    yield {
        "u_a": u_a,
        "u_b": u_b,
        "u_v": u_v,
        "ws_a": ws_a,
        "proj_a": proj_a,
        "emp_a": emp_a,
    }
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(
            text("delete from public.users where id in (:a,:b,:v)"),
            {"a": u_a, "b": u_b, "v": u_v},
        )
        c.execute(
            text("delete from auth.users where id in (:a,:b,:v)"),
            {"a": u_a, "b": u_b, "v": u_v},
        )


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestChatThreads:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/chat/threads").status_code == 401

    def test_crud_and_archive(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/chat/threads",
                json={
                    "project_id": seeded["proj_a"],
                    "ai_employee_id": seeded["emp_a"],
                    "title": "T1",
                },
                headers=h,
            )
            assert r.status_code == 201, r.text
            th = r.json()["data"]
            assert th["archived"] is False
            tid = th["id"]

            assert any(
                x["id"] == tid
                for x in client.get(
                    f"/chat/threads?project_id={seeded['proj_a']}", headers=h
                ).json()["data"]
            )
            assert client.get(f"/chat/threads/{tid}", headers=h).status_code == 200

            # archive
            pr = client.patch(f"/chat/threads/{tid}", json={"archived": True}, headers=h)
            assert pr.status_code == 200
            assert pr.json()["data"]["archived"] is True
            # archived は既定一覧から除外、include_archived で出る
            assert all(
                x["id"] != tid
                for x in client.get(
                    f"/chat/threads?project_id={seeded['proj_a']}", headers=h
                ).json()["data"]
            )
            assert any(
                x["id"] == tid
                for x in client.get(
                    f"/chat/threads?project_id={seeded['proj_a']}&include_archived=true", headers=h
                ).json()["data"]
            )

            assert client.delete(f"/chat/threads/{tid}", headers=h).status_code == 204
            assert client.get(f"/chat/threads/{tid}", headers=h).status_code == 404

    def test_cross_workspace_invisible_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            tid = client.post(
                "/chat/threads",
                json={"project_id": seeded["proj_a"], "ai_employee_id": seeded["emp_a"]},
                headers=ha,
            ).json()["data"]["id"]
            assert client.get(f"/chat/threads/{tid}", headers=hb).status_code == 404
            client.delete(f"/chat/threads/{tid}", headers=ha)


@pytest.mark.integration
class TestChatMessages:
    def _thread(self, client: TestClient, seeded: dict[str, str]) -> str:
        return client.post(
            "/chat/threads",
            json={"project_id": seeded["proj_a"], "ai_employee_id": seeded["emp_a"]},
            headers=_h(seeded["u_a"]),
        ).json()["data"]["id"]

    def test_messages_unauthenticated_401(self, app: FastAPI, seeded: dict[str, str]) -> None:
        with TestClient(app) as client:
            tid = self._thread(client, seeded)
            assert client.get(f"/chat/threads/{tid}/messages").status_code == 401
            assert (
                client.post(f"/chat/threads/{tid}/messages", json={"content": "x"}).status_code
                == 401
            )
            client.delete(f"/chat/threads/{tid}", headers=_h(seeded["u_a"]))

    def test_send_and_list(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._thread(client, seeded)
            r = client.post(f"/chat/threads/{tid}/messages", json={"content": "hello"}, headers=h)
            assert r.status_code == 201, r.text
            msg = r.json()["data"]
            assert msg["role"] == "user"
            assert msg["content"] == "hello"
            assert msg["thread_id"] == tid

            lst = client.get(f"/chat/threads/{tid}/messages", headers=h)
            assert lst.status_code == 200
            assert any(m["id"] == msg["id"] for m in lst.json()["data"])
            client.delete(f"/chat/threads/{tid}", headers=h)

    def test_viewer_cannot_post_403(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hv = _h(seeded["u_a"]), _h(seeded["u_v"])
        with TestClient(app) as client:
            tid = self._thread(client, seeded)
            # viewer はスレッドを閲覧できる
            assert client.get(f"/chat/threads/{tid}/messages", headers=hv).status_code == 200
            # が、投稿はできない (403)
            assert (
                client.post(
                    f"/chat/threads/{tid}/messages", json={"content": "nope"}, headers=hv
                ).status_code
                == 403
            )
            client.delete(f"/chat/threads/{tid}", headers=ha)

    def test_cross_workspace_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            tid = self._thread(client, seeded)
            assert client.get(f"/chat/threads/{tid}/messages", headers=hb).status_code == 404
            assert (
                client.post(
                    f"/chat/threads/{tid}/messages", json={"content": "x"}, headers=hb
                ).status_code
                == 404
            )
            client.delete(f"/chat/threads/{tid}", headers=ha)


@pytest.mark.integration
class TestChatBranchAndFeedback:
    """T-A-19: メッセージ分岐 (parent_message_id) + feedback (audit_logs 記録)。"""

    def _thread(self, client: TestClient, seeded: dict[str, str]) -> str:
        return client.post(
            "/chat/threads",
            json={"project_id": seeded["proj_a"], "ai_employee_id": seeded["emp_a"]},
            headers=_h(seeded["u_a"]),
        ).json()["data"]["id"]

    def test_branch_with_parent_message_id(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._thread(client, seeded)
            # 親メッセージ
            parent = client.post(
                f"/chat/threads/{tid}/messages", json={"content": "root"}, headers=h
            ).json()["data"]
            # 分岐 (parent_message_id 指定)
            r = client.post(
                f"/chat/threads/{tid}/messages",
                json={"content": "branch reply", "parent_message_id": parent["id"]},
                headers=h,
            )
            assert r.status_code == 201, r.text
            child = r.json()["data"]
            assert child["parent_message_id"] == parent["id"]
            assert child["thread_id"] == tid
            client.delete(f"/chat/threads/{tid}", headers=h)

    def test_feedback_requires_auth_401(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._thread(client, seeded)
            mid = client.post(
                f"/chat/threads/{tid}/messages", json={"content": "hi"}, headers=h
            ).json()["data"]["id"]
            # 未認証
            assert (
                client.post(f"/chat/messages/{mid}/feedback", json={"value": "up"}).status_code
                == 401
            )
            client.delete(f"/chat/threads/{tid}", headers=h)

    def test_feedback_recorded_and_audit_logged(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._thread(client, seeded)
            mid = client.post(
                f"/chat/threads/{tid}/messages", json={"content": "rate me"}, headers=h
            ).json()["data"]["id"]
            r = client.post(
                f"/chat/messages/{mid}/feedback",
                json={"value": "down", "comment": "too generic"},
                headers=h,
            )
            assert r.status_code == 201, r.text
            body = r.json()["data"]
            assert body["value"] == "down"
            assert body["message_id"] == mid
            assert body["comment"] == "too generic"
            fb_id = body["feedback_id"]
            # audit_logs に記録
            with sync_engine.connect() as c:
                n = c.execute(
                    text(
                        "select count(*) from public.audit_logs "
                        "where action='chat_message.feedback' "
                        "and target_id=cast(:t as uuid) and actor_id=:a"
                    ),
                    {"t": mid, "a": seeded["u_a"]},
                ).scalar_one()
            assert n >= 1
            assert uuid.UUID(fb_id)  # uuid 形式
            client.delete(f"/chat/threads/{tid}", headers=h)

    def test_feedback_cross_workspace_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        ha, hb = _h(seeded["u_a"]), _h(seeded["u_b"])
        with TestClient(app) as client:
            tid = self._thread(client, seeded)
            mid = client.post(
                f"/chat/threads/{tid}/messages", json={"content": "x"}, headers=ha
            ).json()["data"]["id"]
            # 別 WS の user からは message 不可視 → 404
            assert (
                client.post(
                    f"/chat/messages/{mid}/feedback", json={"value": "up"}, headers=hb
                ).status_code
                == 404
            )
            client.delete(f"/chat/threads/{tid}", headers=ha)

    def test_feedback_invalid_value_422(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._thread(client, seeded)
            mid = client.post(
                f"/chat/threads/{tid}/messages", json={"content": "x"}, headers=h
            ).json()["data"]["id"]
            assert (
                client.post(
                    f"/chat/messages/{mid}/feedback",
                    json={"value": "neutral"},
                    headers=h,
                ).status_code
                == 422
            )
            client.delete(f"/chat/threads/{tid}", headers=h)


@pytest.mark.integration
class TestBranchThread:
    """GAP-031①: POST /chat/messages/{id}/branch — 履歴コピー + parent 連鎖。"""

    def _thread(self, client: TestClient, seeded: dict[str, str]) -> str:
        return client.post(
            "/chat/threads",
            json={
                "project_id": seeded["proj_a"],
                "ai_employee_id": seeded["emp_a"],
                "title": "元スレッド",
            },
            headers=_h(seeded["u_a"]),
        ).json()["data"]["id"]

    def test_branch_copies_history_up_to_message(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._thread(client, seeded)
            client.post(f"/chat/threads/{tid}/messages", json={"content": "one"}, headers=h)
            m2 = client.post(
                f"/chat/threads/{tid}/messages", json={"content": "two"}, headers=h
            ).json()["data"]
            client.post(f"/chat/threads/{tid}/messages", json={"content": "three"}, headers=h)

            # m2 で分岐 → one, two のみコピー (three は含まない)
            r = client.post(f"/chat/messages/{m2['id']}/branch", headers=h)
            assert r.status_code == 201, r.text
            branched = r.json()["data"]
            assert branched["title"] == "分岐: 元スレッド"
            assert branched["project_id"] == seeded["proj_a"]

            msgs = client.get(f"/chat/threads/{branched['id']}/messages", headers=h).json()["data"]
            assert [m["content"] for m in msgs] == ["one", "two"]
            # parent 連鎖: 先頭は分岐元メッセージ (m2)、2 件目は先頭コピー
            assert msgs[0]["parent_message_id"] == m2["id"]
            assert msgs[1]["parent_message_id"] == msgs[0]["id"]
            # 元スレッドは不変 (3 件のまま)
            orig = client.get(f"/chat/threads/{tid}/messages", headers=h).json()["data"]
            assert len(orig) == 3
            client.delete(f"/chat/threads/{branched['id']}", headers=h)
            client.delete(f"/chat/threads/{tid}", headers=h)

    def test_branch_cross_workspace_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        """R-T08: 他 WS の user は分岐できない (message 不可視 404)。"""
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._thread(client, seeded)
            m1 = client.post(
                f"/chat/threads/{tid}/messages", json={"content": "secret"}, headers=h
            ).json()["data"]
            r = client.post(f"/chat/messages/{m1['id']}/branch", headers=_h(seeded["u_b"]))
            assert r.status_code == 404
            client.delete(f"/chat/threads/{tid}", headers=h)


@pytest.mark.integration
class TestToolApprovals:
    """GAP-031①: ツール実行の人間承認 (承認して実行 / 差戻)。"""

    def _thread(self, client: TestClient, seeded: dict[str, str]) -> str:
        return client.post(
            "/chat/threads",
            json={
                "project_id": seeded["proj_a"],
                "ai_employee_id": seeded["emp_a"],
                "title": "承認テスト",
            },
            headers=_h(seeded["u_a"]),
        ).json()["data"]["id"]

    def _seed_approval(
        self, sync_engine: sqlalchemy.Engine, *, user_id: str, thread_id: str, title: str
    ) -> str:
        """request_tool_approval が書くのと同形の pending 行をシード。"""
        approval_id = str(uuid.uuid4())
        payload = json.dumps(
            {
                "tool": "save_deliverable",
                "tool_input": {
                    "title": title,
                    "category": "要件定義",
                    "content_md": f"# {title}\n本文",
                },
                "thread_id": thread_id,
            },
            ensure_ascii=False,
        )
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "insert into public.approval_inbox "
                    "(id, user_id, type, target_type, target_id, title, payload) "
                    "values (cast(:i as uuid), cast(:u as uuid), 'tool_execution', "
                    "'chat_thread', cast(:t as uuid), :ttl, cast(:pl as jsonb))"
                ),
                {
                    "i": approval_id,
                    "u": user_id,
                    "t": thread_id,
                    "ttl": f"ツール実行の承認: save_deliverable（{title}）",
                    "pl": payload,
                },
            )
        return approval_id

    def test_execute_runs_tool_and_resolves(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        title = f"承認成果物-{uuid.uuid4().hex[:6]}"
        with TestClient(app) as client:
            tid = self._thread(client, seeded)
            aid = self._seed_approval(
                sync_engine, user_id=seeded["u_a"], thread_id=tid, title=title
            )
            # 一覧に pending が出る
            listed = client.get(f"/chat/tool-approvals?thread_id={tid}", headers=h).json()["data"]
            assert [a["id"] for a in listed] == [aid]
            assert listed[0]["tool"] == "save_deliverable"

            # 承認して実行 → 実 knowledge が生まれる
            r = client.post(f"/chat/tool-approvals/{aid}/execute", headers=h)
            assert r.status_code == 200, r.text
            assert title in r.json()["data"]["result"]
            with sync_engine.begin() as c:
                kn = c.execute(
                    text("select count(*) from public.knowledge_nodes where title = :t"),
                    {"t": title},
                ).scalar_one()
                assert kn == 1
                status_row = c.execute(
                    text(
                        "select status, resolution_note from public.approval_inbox "
                        "where id = cast(:i as uuid)"
                    ),
                    {"i": aid},
                ).one()
                assert status_row.status == "approved"
                assert title in str(status_row.resolution_note)
            # スレッドに tool メッセージが記録される
            msgs = client.get(f"/chat/threads/{tid}/messages", headers=h).json()["data"]
            assert any(m["role"] == "tool" and title in m["content"] for m in msgs)
            # 二重実行は 409
            assert client.post(f"/chat/tool-approvals/{aid}/execute", headers=h).status_code == 409
            with sync_engine.begin() as c:
                c.execute(text("delete from public.knowledge_nodes where title = :t"), {"t": title})
            client.delete(f"/chat/threads/{tid}", headers=h)

    def test_reject_resolves_without_execution(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        h = _h(seeded["u_a"])
        title = f"差戻成果物-{uuid.uuid4().hex[:6]}"
        with TestClient(app) as client:
            tid = self._thread(client, seeded)
            aid = self._seed_approval(
                sync_engine, user_id=seeded["u_a"], thread_id=tid, title=title
            )
            r = client.post(f"/chat/tool-approvals/{aid}/reject", headers=h)
            assert r.status_code == 200
            with sync_engine.begin() as c:
                st = c.execute(
                    text("select status from public.approval_inbox where id = cast(:i as uuid)"),
                    {"i": aid},
                ).scalar_one()
                assert st == "rejected"
                kn = c.execute(
                    text("select count(*) from public.knowledge_nodes where title = :t"),
                    {"t": title},
                ).scalar_one()
                assert kn == 0  # 実行されていない
            msgs = client.get(f"/chat/threads/{tid}/messages", headers=h).json()["data"]
            assert any(m["role"] == "system" and "差し戻され" in m["content"] for m in msgs)
            client.delete(f"/chat/threads/{tid}", headers=h)

    def test_cross_user_invisible_404(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """R-T08: 他人の承認は見えない・実行できない (inbox は本人のみ)。"""
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            tid = self._thread(client, seeded)
            aid = self._seed_approval(
                sync_engine, user_id=seeded["u_a"], thread_id=tid, title="他人不可"
            )
            hb = _h(seeded["u_b"])
            assert client.post(f"/chat/tool-approvals/{aid}/execute", headers=hb).status_code == 404
            listed = client.get(f"/chat/tool-approvals?thread_id={tid}", headers=hb).json()["data"]
            assert listed == []
            with sync_engine.begin() as c:
                c.execute(
                    text("delete from public.approval_inbox where id = cast(:i as uuid)"),
                    {"i": aid},
                )
            client.delete(f"/chat/threads/{tid}", headers=h)


@pytest.mark.integration
class TestChatAttachments:
    """GAP-001: チャット添付 (署名付き 2 段階アップロード + メッセージ関連付け)。"""

    def _mk_thread(self, client: TestClient, seeded: dict[str, str]) -> str:
        r = client.post(
            "/chat/threads",
            headers=_h(seeded["u_a"]),
            json={
                "project_id": seeded["proj_a"],
                "ai_employee_id": seeded["emp_a"],
                "title": "添付テスト",
            },
        )
        assert r.status_code == 201, r.text
        return str(r.json()["data"]["id"])

    def test_upload_url_503_when_storage_unconfigured(
        self, app: FastAPI, seeded: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("ATELIER_SUPABASE_ADMIN_API_URL", raising=False)
        monkeypatch.delenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", raising=False)
        with TestClient(app) as client:
            tid = self._mk_thread(client, seeded)
            r = client.post(
                "/chat/attachments/upload-url",
                headers=_h(seeded["u_a"]),
                json={
                    "thread_id": tid,
                    "file_name": "spec.pdf",
                    "mime_type": "application/pdf",
                    "file_size_bytes": 1000,
                },
            )
            assert r.status_code == 503

    def test_upload_url_rejects_bad_mime_and_size(
        self, app: FastAPI, seeded: dict[str, str], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("ATELIER_SUPABASE_ADMIN_API_URL", raising=False)
        with TestClient(app) as client:
            tid = self._mk_thread(client, seeded)
            base = {"thread_id": tid, "file_name": "x", "mime_type": "application/x-msdownload"}
            r = client.post(
                "/chat/attachments/upload-url",
                headers=_h(seeded["u_a"]),
                json={**base, "file_name": "evil.exe", "file_size_bytes": 10},
            )
            assert r.status_code == 415
            r = client.post(
                "/chat/attachments/upload-url",
                headers=_h(seeded["u_a"]),
                json={
                    "thread_id": tid,
                    "file_name": "big.pdf",
                    "mime_type": "application/pdf",
                    "file_size_bytes": 10 * 1024 * 1024 + 1,
                },
            )
            assert r.status_code == 413

    def test_upload_url_viewer_403_and_invisible_404(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        with TestClient(app) as client:
            tid = self._mk_thread(client, seeded)
            body = {
                "thread_id": tid,
                "file_name": "a.pdf",
                "mime_type": "application/pdf",
                "file_size_bytes": 10,
            }
            r = client.post("/chat/attachments/upload-url", headers=_h(seeded["u_v"]), json=body)
            assert r.status_code == 403  # viewer は投稿不可
            r = client.post("/chat/attachments/upload-url", headers=_h(seeded["u_b"]), json=body)
            assert r.status_code == 404  # R-T08: 他 WS からはスレッド自体不可視

    def test_stream_persists_attachments_and_rejects_cross_thread(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("ATELIER_ALLOW_FAKE_LLM", "1")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        with TestClient(app) as client:
            tid = self._mk_thread(client, seeded)
            att = {
                "file_name": "spec.pdf",
                "mime_type": "application/pdf",
                "file_size_bytes": 1234,
                "storage_path": f"chat-attachments/{tid}/x/spec.pdf",
            }
            # 他スレッド配下の storage_path は 422 (可視性バイパス拒否)
            r = client.post(
                f"/chat/threads/{tid}/stream",
                headers=_h(seeded["u_a"]),
                json={
                    "user_message": "添付を見て",
                    "use_knowledge_rag": False,
                    "attachments": [
                        {**att, "storage_path": "chat-attachments/other-thread/x/spec.pdf"}
                    ],
                },
            )
            assert r.status_code == 422
            # 正しい添付は user message に永続される
            r = client.post(
                f"/chat/threads/{tid}/stream",
                headers=_h(seeded["u_a"]),
                json={
                    "user_message": "添付を見て",
                    "use_knowledge_rag": False,
                    "attachments": [att],
                },
            )
            assert r.status_code == 200, r.text
            msgs = client.get(f"/chat/threads/{tid}/messages", headers=_h(seeded["u_a"])).json()[
                "data"
            ]
            user_msgs = [m for m in msgs if m["role"] == "user"]
            assert len(user_msgs) == 1
            assert user_msgs[0]["attachments"] == [att]

    def test_attachment_url_signed_and_404s(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("ATELIER_ALLOW_FAKE_LLM", "1")
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "http://storage.test")
        monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "sk-test")

        import src.storage_signing as signing

        class _FakeResponse:
            status_code = 200
            text = ""

            def json(self) -> dict[str, object]:
                return {"signedURL": "/object/download/chat-attachments/x/spec.pdf?token=abc"}

        class _FakeClient:
            def __init__(self, *_a: object, **_k: object) -> None:
                pass

            async def __aenter__(self) -> _FakeClient:
                return self

            async def __aexit__(self, *_a: object) -> bool:
                return False

            async def post(self, url: str, **_k: object) -> _FakeResponse:
                return _FakeResponse()

        monkeypatch.setattr(signing.httpx, "AsyncClient", _FakeClient)
        with TestClient(app) as client:
            tid = self._mk_thread(client, seeded)
            att = {
                "file_name": "spec.pdf",
                "mime_type": "application/pdf",
                "file_size_bytes": 1234,
                "storage_path": f"chat-attachments/{tid}/x/spec.pdf",
            }
            client.post(
                f"/chat/threads/{tid}/stream",
                headers=_h(seeded["u_a"]),
                json={
                    "user_message": "添付あり",
                    "use_knowledge_rag": False,
                    "attachments": [att],
                },
            )
            msgs = client.get(f"/chat/threads/{tid}/messages", headers=_h(seeded["u_a"])).json()[
                "data"
            ]
            mid = next(m["id"] for m in msgs if m["role"] == "user")
            r = client.get(f"/chat/messages/{mid}/attachments/0/url", headers=_h(seeded["u_a"]))
            assert r.status_code == 200, r.text
            assert "/object/download/chat-attachments/" in r.json()["data"]["url"]
            assert r.json()["data"]["file_name"] == "spec.pdf"
            # index 範囲外 404
            r = client.get(f"/chat/messages/{mid}/attachments/5/url", headers=_h(seeded["u_a"]))
            assert r.status_code == 404
            # R-T08: 他 WS ユーザーからはメッセージ不可視 → 404
            r = client.get(f"/chat/messages/{mid}/attachments/0/url", headers=_h(seeded["u_b"]))
            assert r.status_code == 404


@pytest.mark.integration
class TestChatCommands:
    """GAP-002: /コマンド のサーバー実行 (decision 記録 / task 起票)。"""

    def _mk_thread(self, client: TestClient, seeded: dict[str, str]) -> str:
        r = client.post(
            "/chat/threads",
            headers=_h(seeded["u_a"]),
            json={
                "project_id": seeded["proj_a"],
                "ai_employee_id": seeded["emp_a"],
                "title": "コマンドテスト",
            },
        )
        assert r.status_code == 201, r.text
        return str(r.json()["data"]["id"])

    def test_decision_command_creates_decision_and_messages(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        with TestClient(app) as client:
            tid = self._mk_thread(client, seeded)
            r = client.post(
                f"/chat/threads/{tid}/commands",
                headers=_h(seeded["u_a"]),
                json={"command": "decision", "args": "配色は secondary を正とする"},
            )
            assert r.status_code == 201, r.text
            d = r.json()["data"]
            assert d["target_type"] == "decision"
            assert "確定事項として記録しました" in d["note"]
        with sync_engine.begin() as c:
            row = c.execute(
                text(
                    "select body, with_user, decided_by from public.decisions "
                    "where id = cast(:i as uuid)"
                ),
                {"i": d["target_id"]},
            ).first()
            assert row is not None
            assert row.body == "配色は secondary を正とする"
            assert row.with_user is True
            assert str(row.decided_by) == seeded["emp_a"]
            # スレッドに コマンド原文 (user) + 実行結果 (system) が永続
            msgs = c.execute(
                text(
                    "select role, content from public.chat_messages "
                    "where thread_id = cast(:t as uuid) order by created_at, id"
                ),
                {"t": tid},
            ).all()
            assert [str(m.role) for m in msgs] == ["user", "system"]
            assert msgs[0].content == "/決定 配色は secondary を正とする"
            assert "記録しました" in msgs[1].content
            # audit
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action='chat_command.executed' and target_id = cast(:t as uuid)"
                ),
                {"t": tid},
            ).scalar_one()
            assert cnt == 1

    def test_task_command_creates_triage_task(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        with TestClient(app) as client:
            tid = self._mk_thread(client, seeded)
            r = client.post(
                f"/chat/threads/{tid}/commands",
                headers=_h(seeded["u_a"]),
                json={"command": "task", "args": "LP のヒーローコピー見直し"},
            )
            assert r.status_code == 201, r.text
            d = r.json()["data"]
            assert d["target_type"] == "task"
        with sync_engine.begin() as c:
            row = c.execute(
                text(
                    "select title, category, lifecycle_stage, description from public.tasks "
                    "where id = cast(:i as uuid)"
                ),
                {"i": d["target_id"]},
            ).first()
            assert row is not None
            assert row.title == "LP のヒーローコピー見直し"
            assert row.category == "チャット起票"
            assert str(row.lifecycle_stage) == "triage"
            assert "見積は未実施" in str(row.description)

    def test_command_validation_and_permissions(self, app: FastAPI, seeded: dict[str, str]) -> None:
        with TestClient(app) as client:
            tid = self._mk_thread(client, seeded)
            # 空白のみ args は 422
            r = client.post(
                f"/chat/threads/{tid}/commands",
                headers=_h(seeded["u_a"]),
                json={"command": "decision", "args": "   "},
            )
            assert r.status_code == 422
            # 未対応 command は 422 (schema literal)
            r = client.post(
                f"/chat/threads/{tid}/commands",
                headers=_h(seeded["u_a"]),
                json={"command": "deploy", "args": "x"},
            )
            assert r.status_code == 422
            # viewer は 403
            r = client.post(
                f"/chat/threads/{tid}/commands",
                headers=_h(seeded["u_v"]),
                json={"command": "decision", "args": "x"},
            )
            assert r.status_code == 403
            # 他 WS user はスレッド不可視 404 (R-T08)
            r = client.post(
                f"/chat/threads/{tid}/commands",
                headers=_h(seeded["u_b"]),
                json={"command": "decision", "args": "x"},
            )
            assert r.status_code == 404
