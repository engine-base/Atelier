"""Integration tests for /chat/threads/{id}/stream (T-A-18) — 実 Postgres + RLS + JWT。

F-CTX01 文脈構築 + LLM 応答 SSE 配信。ANTHROPIC_API_KEY 未設定環境では
service が fake stream にフォールバックするため、SSE 配信パス + DB persist +
audit を deterministic に検証できる。
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
from typing import Annotated, cast

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
JWT_SECRET = "test-jwt-secret"
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", JWT_SECRET)
# 実 Anthropic / Voyage 呼出を避けて deterministic fallback path を通す
os.environ.pop("ANTHROPIC_API_KEY", None)
os.environ.pop("VOYAGE_API_KEY", None)
# T-A-48: 本番は LLM 未接続時 fake を返さないが、テストでは echo fallback を許可する
os.environ["ATELIER_ALLOW_FAKE_LLM"] = "1"

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
    proj_a = str(uuid.uuid4())
    emp_a = str(uuid.uuid4())
    thread_a = str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta18-{uid[:8]}@t.invalid"
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
        # ai_employee (chat_threads.ai_employee_id 必須)
        c.execute(
            text(
                "insert into public.ai_employees "
                "(id, workspace_id, name, display_name, role, department) "
                "values (cast(:i as uuid), cast(:w as uuid), :n, :d, "
                "'member', 'dev_qa')"
            ),
            {"i": emp_a, "w": ws_a, "n": f"emp-{emp_a[:6]}", "d": "Test Employee"},
        )
        c.execute(
            text(
                "insert into public.chat_threads "
                "(id, project_id, ai_employee_id, title) "
                "values (cast(:i as uuid), cast(:p as uuid), cast(:e as uuid), :t)"
            ),
            {"i": thread_a, "p": proj_a, "e": emp_a, "t": "thread-a"},
        )
        # 既存履歴 1 件 (assistant 過去応答)
        c.execute(
            text(
                "insert into public.chat_messages (id, thread_id, role, content) "
                "values (cast(:i as uuid), cast(:t as uuid), 'assistant', "
                "'前回の応答')"
            ),
            {"i": str(uuid.uuid4()), "t": thread_a},
        )
    yield {
        "u_a": u_a,
        "u_b": u_b,
        "ws_a": ws_a,
        "proj_a": proj_a,
        "thread_a": thread_a,
    }
    with sync_engine.begin() as c:
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


def _parse_sse(body: bytes) -> list[dict[str, object]]:
    events: list[dict[str, object]] = []
    for raw in body.split(b"\n\n"):
        line = raw.strip()
        if not line.startswith(b"data:"):
            continue
        events.append(json.loads(line[5:].strip()))
    return events


@pytest.mark.integration
class TestChatSSE:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            tid = uuid.uuid4()
            assert (
                client.post(
                    f"/chat/threads/{tid}/stream",
                    json={"user_message": "hi"},
                ).status_code
                == 401
            )
            assert (
                client.post(
                    f"/chat/threads/{tid}/context-preview",
                    json={"user_message": "hi"},
                ).status_code
                == 401
            )

    def test_stream_404_for_nonexistent_thread(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            assert (
                client.post(
                    f"/chat/threads/{uuid.uuid4()}/stream",
                    headers=h,
                    json={"user_message": "hi"},
                ).status_code
                == 404
            )

    def test_stream_cross_workspace_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        hb = _h(seeded["u_b"])
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/stream",
                headers=hb,
                json={"user_message": "hi"},
            )
            assert r.status_code == 404

    def test_stream_persists_user_and_assistant_messages(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/stream",
                headers=h,
                json={
                    "user_message": "hello world",
                    "use_knowledge_rag": False,
                    "include_history": 5,
                },
            )
            assert r.status_code == 200
            assert r.headers["content-type"].startswith("text/event-stream")
            events = _parse_sse(r.content)
        types = [e["type"] for e in events]
        assert "context" in types
        assert "start" in types
        assert "end" in types
        assert types.count("delta") >= 1
        # fake stream は "echo: hello world" を 1 文字ずつ delta
        joined = "".join(str(e.get("content", "")) for e in events if e["type"] == "delta")
        assert "echo: hello world" in joined
        # DB persist + audit_logs を sync engine で確認
        with sync_engine.begin() as c:
            cnt_user = c.execute(
                text(
                    "select count(*) from public.chat_messages "
                    "where thread_id = cast(:t as uuid) and role = 'user' "
                    "and content = 'hello world'"
                ),
                {"t": seeded["thread_a"]},
            ).scalar_one()
            assert cnt_user == 1
            cnt_assistant = c.execute(
                text(
                    "select count(*) from public.chat_messages "
                    "where thread_id = cast(:t as uuid) and role = 'assistant' "
                    "and content like 'echo:%'"
                ),
                {"t": seeded["thread_a"]},
            ).scalar_one()
            assert cnt_assistant == 1
            audit_cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'chat.message.create' "
                    "and (after->>'thread_id') = :t"
                ),
                {"t": seeded["thread_a"]},
            ).scalar_one()
            # user 1 + assistant 1
            assert audit_cnt >= 2

    def test_stream_context_includes_history_count(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/stream",
                headers=h,
                json={
                    "user_message": "follow up",
                    "use_knowledge_rag": False,
                    "include_history": 10,
                },
            )
            events = _parse_sse(r.content)
        ctx_evt = next(e for e in events if e["type"] == "context")
        meta = ctx_evt["metadata"]
        assert isinstance(meta, dict)
        # 既存 history 1 件 (seeded fixture で挿入)
        assert cast("int", meta["history_count"]) >= 1
        assert isinstance(meta["rag_hit_ids"], list)

    def test_context_preview_does_not_persist(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["u_a"])
        with sync_engine.begin() as c:
            before = c.execute(
                text(
                    "select count(*) from public.chat_messages where thread_id = cast(:t as uuid)"
                ),
                {"t": seeded["thread_a"]},
            ).scalar_one()
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/context-preview",
                headers=h,
                json={"user_message": "preview only", "include_history": 5},
            )
            assert r.status_code == 200
            data = r.json()["data"]
            assert "system_prompt" in data
            assert "Atelier" in data["system_prompt"]
            assert isinstance(data["rag_hit_ids"], list)
        # 副作用なし
        with sync_engine.begin() as c:
            after = c.execute(
                text(
                    "select count(*) from public.chat_messages where thread_id = cast(:t as uuid)"
                ),
                {"t": seeded["thread_a"]},
            ).scalar_one()
            assert before == after

    def test_stream_rejects_empty_user_message_422(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/stream",
                headers=h,
                json={"user_message": ""},
            )
            assert r.status_code == 422

    def test_stream_rejects_oversize_history_422(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/stream",
                headers=h,
                json={"user_message": "x", "include_history": 1000},
            )
            assert r.status_code == 422


@pytest.fixture()
def seeded_knowledge(
    sync_engine: sqlalchemy.Engine, seeded: dict[str, str]
) -> Iterator[dict[str, str]]:
    """ws_a に RAG hit する knowledge を 1 件足す (GAP-012 バックリンク検証用)。"""
    kid = str(uuid.uuid4())
    with sync_engine.begin() as c:
        c.execute(
            text(
                "insert into public.knowledge_nodes "
                "(id, account_id, account_type, scope, category, title, content_md, tags) "
                "values (cast(:i as uuid), cast(:a as uuid), 'workspace', 'common', "
                "'tech', 'backlink target note', 'gap012-backlink-keyword content', '{tech}')"
            ),
            {"i": kid, "a": seeded["ws_a"]},
        )
    yield {**seeded, "kid": kid}
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.knowledge_nodes where id = cast(:i as uuid)"), {"i": kid}
        )


@pytest.mark.integration
class TestKnowledgeBacklinks:
    """GAP-012: チャット RAG 消費 → knowledge_references 永続化 → 逆引き API。"""

    def _stream(self, client: TestClient, seeded: dict[str, str]) -> None:
        r = client.post(
            f"/chat/threads/{seeded['thread_a']}/stream",
            headers=_h(seeded["u_a"]),
            json={
                # text fallback は user_message 全文の ilike 部分一致 — content に
                # そのまま含まれる文字列を送る
                "user_message": "gap012-backlink-keyword",
                "use_knowledge_rag": True,
                "rag_account_id": seeded["ws_a"],
            },
        )
        assert r.status_code == 200

    def test_stream_records_reference_and_lists_backlink(
        self, app: FastAPI, seeded_knowledge: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        s = seeded_knowledge
        with TestClient(app) as client:
            self._stream(client, s)
            with sync_engine.begin() as c:
                row = c.execute(
                    text(
                        "select referrer_type, referrer_id, reference_count "
                        "from public.knowledge_references "
                        "where knowledge_id = cast(:k as uuid)"
                    ),
                    {"k": s["kid"]},
                ).one()
            assert row.referrer_type == "chat_thread"
            assert str(row.referrer_id) == s["thread_a"]
            assert row.reference_count == 1

            r = client.get(f"/knowledge/{s['kid']}/references", headers=_h(s["u_a"]))
            assert r.status_code == 200
            data = r.json()["data"]
            assert data["total"] == 1
            ref = data["references"][0]
            assert ref["referrer_type"] == "chat_thread"
            assert ref["referrer_title"] == "thread-a"
            assert ref["context"] == "チャット応答で参照（RAG）"

    def test_repeat_reference_dedupes_to_count(
        self, app: FastAPI, seeded_knowledge: dict[str, str]
    ) -> None:
        s = seeded_knowledge
        with TestClient(app) as client:
            self._stream(client, s)
            self._stream(client, s)
            r = client.get(f"/knowledge/{s['kid']}/references", headers=_h(s["u_a"]))
            assert r.status_code == 200
            data = r.json()["data"]
            assert data["total"] == 1  # 同一スレッドの再参照は 1 行に畳む
            assert data["references"][0]["reference_count"] == 2

    def test_references_cross_workspace_404(
        self, app: FastAPI, seeded_knowledge: dict[str, str]
    ) -> None:
        """R-T08: 他 workspace の user はバックリンクも見えない (knowledge 可視性を継承)。"""
        s = seeded_knowledge
        with TestClient(app) as client:
            self._stream(client, s)
            r = client.get(f"/knowledge/{s['kid']}/references", headers=_h(s["u_b"]))
            assert r.status_code == 404


@pytest.mark.integration
def test_gap149_peer_thread_summaries_injected(
    app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
) -> None:
    """GAP-149: 同一プロジェクトの別 AI 社員スレッドの要約が system prompt に載る。

    スレッドは project × 社員で分かれるため、そのままでは社員間で会話が
    引き継がれない — 他スレッドのローリング要約 (GAP-132) を横断注入する。
    """
    import uuid as _uuid

    emp_b = str(_uuid.uuid4())
    thread_b = str(_uuid.uuid4())
    with sync_engine.begin() as c:
        c.execute(
            text(
                "insert into public.ai_employees "
                "(id, workspace_id, name, display_name, role, department) "
                "values (cast(:i as uuid), cast(:w as uuid), :n, :d, 'lead', 'design')"
            ),
            {"i": emp_b, "w": seeded["ws_a"], "n": f"wanda-{emp_b[:6]}", "d": "ワンダ"},
        )
        c.execute(
            text(
                "insert into public.chat_threads "
                "(id, project_id, ai_employee_id, title, context_summary) "
                "values (cast(:i as uuid), cast(:p as uuid), cast(:e as uuid), :t, :s)"
            ),
            {
                "i": thread_b,
                "p": seeded["proj_a"],
                "e": emp_b,
                "t": "LP デザイン相談",
                "s": "LP のメインカラーは紺に決定。ヒーローは 3 案から A 案を採用。",
            },
        )
    try:
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/context-preview",
                headers=_h(seeded["u_a"]),
                json={"user_message": "現状教えて", "include_history": 5},
            )
            assert r.status_code == 200
            sys_p = r.json()["data"]["system_prompt"]
            assert "プロジェクト内の他の会話の要点" in sys_p
            assert "ワンダとの会話「LP デザイン相談」" in sys_p
            assert "メインカラーは紺に決定" in sys_p
    finally:
        with sync_engine.begin() as c:
            c.execute(
                text("delete from public.chat_threads where id = cast(:i as uuid)"),
                {"i": thread_b},
            )
            c.execute(
                text("delete from public.ai_employees where id = cast(:i as uuid)"),
                {"i": emp_b},
            )


# ── GAP-161: 添付資料が本当に AI へ渡るか ───────────────────────────


@pytest.mark.integration
class TestGap161AttachmentsReachTheAI:
    """従来は保存・表示のみで LLM に渡っていなかった実バグの回帰テスト。"""

    def _install_storage_fake(self, monkeypatch: pytest.MonkeyPatch, payload: bytes) -> None:
        from typing import Any

        from src import storage_signing

        monkeypatch.setenv("ATELIER_SUPABASE_ADMIN_API_URL", "https://stor.invalid")
        monkeypatch.setenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", "svc-key")

        class _Res:
            def __init__(self, payload_json: dict[str, Any] | None = None) -> None:
                self.status_code = 200
                self._payload = payload_json or {}
                self.content = payload

            def json(self) -> dict[str, Any]:
                return self._payload

        class _Client:
            def __init__(self, *_a: Any, **_k: Any) -> None: ...

            async def __aenter__(self) -> _Client:
                return self

            async def __aexit__(self, *_a: Any) -> bool:
                return False

            async def post(self, _url: str, **_k: Any) -> _Res:
                return _Res({"signedURL": "/object/sign/chat/x?token=d"})

            async def get(self, _url: str, **_k: Any) -> _Res:
                return _Res()

        monkeypatch.setattr(storage_signing.httpx, "AsyncClient", _Client)
        import httpx as _httpx

        monkeypatch.setattr(_httpx, "AsyncClient", _Client)

    def test_excel_attachment_content_is_injected_into_system_prompt(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        import io

        from openpyxl import Workbook

        wb = Workbook()
        ws = wb.active
        assert ws is not None
        ws.title = "見積内訳"
        ws.append(["項目", "金額"])
        ws.append(["初期設計", 480000])
        buf = io.BytesIO()
        wb.save(buf)
        self._install_storage_fake(monkeypatch, buf.getvalue())

        # 添付つきメッセージを直接 seed (アップロード自体は GAP-001 の別テスト)
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "insert into public.chat_messages (thread_id, role, content, attachments) "
                    "values (cast(:t as uuid), 'user', 'この見積を参考にして', cast(:a as jsonb))"
                ),
                {
                    "t": seeded["thread_a"],
                    "a": json.dumps(
                        [
                            {
                                "storage_path": "chat-attachments/x/見積.xlsx",
                                "file_name": "見積.xlsx",
                                "mime_type": (
                                    "application/vnd.openxmlformats-officedocument"
                                    ".spreadsheetml.sheet"
                                ),
                            }
                        ]
                    ),
                },
            )
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/context-preview",
                headers=_h(seeded["u_a"]),
                json={"user_message": "この資料を踏まえて見積を出して", "include_history": 5},
            )
            assert r.status_code == 200
            sys_p = r.json()["data"]["system_prompt"]
        assert "# 添付資料" in sys_p
        assert "見積.xlsx" in sys_p
        # 実データが入っていること (ファイル名だけでなく中身)
        assert "初期設計 | 480000" in sys_p
        assert "推測で補わず" in sys_p

    def test_unfetchable_attachment_is_reported_honestly(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """storage 未設定などで取得できない添付は「取り込めなかった」と明示する。"""
        monkeypatch.delenv("ATELIER_SUPABASE_ADMIN_API_URL", raising=False)
        monkeypatch.delenv("ATELIER_SUPABASE_SERVICE_ROLE_KEY", raising=False)
        with sync_engine.begin() as c:
            c.execute(
                text(
                    "insert into public.chat_messages (thread_id, role, content, attachments) "
                    "values (cast(:t as uuid), 'user', '資料です', cast(:a as jsonb))"
                ),
                {
                    "t": seeded["thread_a"],
                    "a": json.dumps(
                        [
                            {
                                "storage_path": "chat-attachments/x/design.png",
                                "file_name": "design.png",
                                "mime_type": "image/png",
                            }
                        ]
                    ),
                },
            )
        with TestClient(app) as client:
            r = client.post(
                f"/chat/threads/{seeded['thread_a']}/context-preview",
                headers=_h(seeded["u_a"]),
                json={"user_message": "これ見て", "include_history": 5},
            )
            assert r.status_code == 200
            sys_p = r.json()["data"]["system_prompt"]
        assert "design.png" in sys_p
        assert "取り込めませんでした" in sys_p
        # 偽の中身を作らない
        assert "推測" in sys_p


# ── GAP-164: 会話から「使えるノウハウ」を自動でナレッジに残す ────


@pytest.mark.integration
class TestGap164AutoKnowledgeCapture:
    def test_generalizable_knowhow_becomes_a_candidate_for_review(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """GAP-167: 一般化できるノウハウは **候補** になる (直接ナレッジにしない)。"""
        from typing import Any

        from src.services.knowledge import auto_capture

        with sync_engine.begin() as c:
            for i in range(4):
                c.execute(
                    text(
                        "insert into public.chat_messages (thread_id, role, content) "
                        "values (cast(:t as uuid), cast(:r as chat_message_role_enum), :c)"
                    ),
                    {
                        "t": seeded["thread_a"],
                        "r": "user" if i % 2 == 0 else "assistant",
                        "c": f"見積の前提条件は必ず書く ({i})",
                    },
                )

        async def _fake_complete(**kwargs: Any) -> tuple[str, str]:
            del kwargs
            return (
                '[{"title":"見積は前提条件を明記する",'
                '"content_md":"見積には対象範囲と前提条件を必ず書く。'
                '書かないと追加要望との境目が曖昧になり、後で揉める。",'
                '"category":"ノウハウ","tags":["見積"]}]',
                "fake",
            )

        async def run() -> list[str]:
            engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
            try:
                async with AsyncSession(engine) as session:
                    ids = await auto_capture.capture_from_thread(
                        session,
                        thread_id=seeded["thread_a"],
                        actor_id=seeded["u_a"],
                        complete=_fake_complete,
                    )
                    await session.commit()
                    # 2 回目は同じ題なので作らない (重複で埋めない)
                    again = await auto_capture.capture_from_thread(
                        session,
                        thread_id=seeded["thread_a"],
                        actor_id=seeded["u_a"],
                        complete=_fake_complete,
                    )
                    await session.commit()
                    assert again == []
                    return ids
            finally:
                await engine.dispose()

        created = asyncio.run(run())
        assert len(created) == 1
        try:
            with sync_engine.begin() as c:
                row = c.execute(
                    text(
                        "select title, status, workspace_id, category "
                        "from public.knowledge_candidates where id = cast(:i as uuid)"
                    ),
                    {"i": created[0]},
                ).one()
                # まだナレッジ本体には入っていない (人が採用して初めて入る)
                n = c.execute(
                    text(
                        "select count(*) from public.knowledge_nodes "
                        "where account_id = cast(:w as uuid) and title = :t "
                        "and deleted_at is null"
                    ),
                    {"w": seeded["ws_a"], "t": "見積は前提条件を明記する"},
                ).scalar_one()
            assert row.title == "見積は前提条件を明記する"
            assert row.status == "pending"
            assert str(row.workspace_id) == seeded["ws_a"]
            assert n == 0
        finally:
            with sync_engine.begin() as c:
                c.execute(
                    text("delete from public.knowledge_candidates where id = cast(:i as uuid)"),
                    {"i": created[0]},
                )

    def test_nothing_is_invented_when_there_is_no_knowhow(
        self, app: FastAPI, seeded: dict[str, str], sync_engine: sqlalchemy.Engine
    ) -> None:
        """拾うものが無ければ何も作らない。壊れた応答でも作らない。"""
        from typing import Any

        from src.services.knowledge import auto_capture

        with sync_engine.begin() as c:
            for i in range(4):
                c.execute(
                    text(
                        "insert into public.chat_messages (thread_id, role, content) "
                        "values (cast(:t as uuid), 'user', :c)"
                    ),
                    {"t": seeded["thread_a"], "c": f"お疲れ様です ({i})"},
                )

        async def _empty(**kwargs: Any) -> tuple[str, str]:
            del kwargs
            return "[]", "fake"

        async def _broken(**kwargs: Any) -> tuple[str, str]:
            del kwargs
            return "これはJSONではありません", "fake"

        async def run() -> tuple[list[str], list[str]]:
            engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
            try:
                async with AsyncSession(engine) as session:
                    a = await auto_capture.capture_from_thread(
                        session,
                        thread_id=seeded["thread_a"],
                        actor_id=seeded["u_a"],
                        complete=_empty,
                    )
                    b = await auto_capture.capture_from_thread(
                        session,
                        thread_id=seeded["thread_a"],
                        actor_id=seeded["u_a"],
                        complete=_broken,
                    )
                    return a, b
            finally:
                await engine.dispose()

        empty, broken = asyncio.run(run())
        assert empty == [] and broken == []

    def test_prompt_forbids_client_specific_facts(self) -> None:
        """抽出プロンプトが案件固有情報の持ち出しを禁じていること (漏えい防止)。"""
        from src.services.knowledge import auto_capture

        assert "社名・人名・金額・URL・日付" in auto_capture._SYSTEM
        assert "無理に作らない" in auto_capture._SYSTEM
        # 壊れた JSON / 短すぎる本文は採用しない
        assert auto_capture.parse_candidates("{}") == []
        assert auto_capture.parse_candidates('[{"title":"x","content_md":"短い"}]') == []
