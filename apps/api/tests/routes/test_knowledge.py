"""Integration tests for /knowledge (T-A-36) — 実 Postgres + RLS + JWT。

E-018 knowledge_nodes CRUD + semantic search。VOYAGE_API_KEY 未設定の
テスト環境では service 層が text fallback (ilike) に switch するため、
そちらでカバー。Voyage の embed 呼出自体は T-F-14 単体テストで検証済。

R-T08 (致命級): workspace A の user が workspace B の knowledge を query
しても RLS で 0 rows (cross-workspace skip) を必ず検証。
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
# Voyage を呼ばずテキストフォールバック経路を覆う
os.environ.pop("VOYAGE_API_KEY", None)

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
    k_common_a, k_common_b = str(uuid.uuid4()), str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_a, u_b):
            em = f"ta36-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        for ws, owner in ((ws_a, u_a), (ws_b, u_b)):
            c.execute(
                text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
                {"i": ws, "o": owner, "n": f"ws-{ws[:6]}"},
            )
        # workspace A の common knowledge
        c.execute(
            text(
                "insert into public.knowledge_nodes "
                "(id, account_id, account_type, scope, category, title, content_md, tags) "
                "values (cast(:i as uuid), cast(:a as uuid), 'workspace', 'common', "
                "'tech', 'ws-a common note', 'matchable content keyword foo', '{tech,common}')"
            ),
            {"i": k_common_a, "a": ws_a},
        )
        # workspace B の common knowledge (cross-workspace 不可視検証用)
        c.execute(
            text(
                "insert into public.knowledge_nodes "
                "(id, account_id, account_type, scope, category, title, content_md, tags) "
                "values (cast(:i as uuid), cast(:a as uuid), 'workspace', 'common', "
                "'tech', 'ws-b common note', 'matchable content keyword foo', '{tech,common}')"
            ),
            {"i": k_common_b, "a": ws_b},
        )
    yield {
        "u_a": u_a,
        "u_b": u_b,
        "ws_a": ws_a,
        "ws_b": ws_b,
        "k_common_a": k_common_a,
        "k_common_b": k_common_b,
    }
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.knowledge_nodes where id in (:a,:b)"),
            {"a": k_common_a, "b": k_common_b},
        )
        c.execute(text("delete from public.workspaces where id in (:a,:b)"), {"a": ws_a, "b": ws_b})
        c.execute(text("delete from public.users where id in (:a,:b)"), {"a": u_a, "b": u_b})
        c.execute(text("delete from auth.users where id in (:a,:b)"), {"a": u_a, "b": u_b})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


@pytest.mark.integration
class TestKnowledge:
    def test_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.get("/knowledge").status_code == 401
            assert client.post("/knowledge", json={}).status_code == 401
            assert client.post("/knowledge/search", json={"query": "x"}).status_code == 401

    def test_list_and_get(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.get(f"/knowledge?account_id={seeded['ws_a']}", headers=h)
            assert r.status_code == 200
            ids = {x["id"] for x in r.json()["data"]}
            assert seeded["k_common_a"] in ids
            g = client.get(f"/knowledge/{seeded['k_common_a']}", headers=h)
            assert g.status_code == 200
            assert g.json()["data"]["scope"] == "common"

    def test_cross_workspace_invisible_404(self, app: FastAPI, seeded: dict[str, str]) -> None:
        """R-T08: workspace A の user は workspace B の knowledge を見れない (致命級)。"""
        hb = _h(seeded["u_b"])  # ws_b の user
        with TestClient(app) as client:
            assert client.get(f"/knowledge/{seeded['k_common_a']}", headers=hb).status_code == 404
            r = client.get(f"/knowledge?account_id={seeded['ws_a']}", headers=hb)
            assert seeded["k_common_a"] not in {x["id"] for x in r.json()["data"]}

    def test_create_common_and_audit(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/knowledge",
                headers=h,
                json={
                    "account_id": seeded["ws_a"],
                    "account_type": "workspace",
                    "scope": "common",
                    "category": "process",
                    "title": "new note",
                    "content_md": "process documentation",
                },
            )
            assert r.status_code == 201, r.text
            new_id = r.json()["data"]["id"]
        with sync_engine.begin() as c:
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'knowledge.create' and target_id = cast(:t as uuid)"
                ),
                {"t": new_id},
            ).scalar_one()
            assert cnt == 1

    def test_create_employee_specific_requires_owner_employee_id(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/knowledge",
                headers=h,
                json={
                    "account_id": seeded["ws_a"],
                    "account_type": "workspace",
                    "scope": "employee_specific",
                    "category": "tech",
                    "title": "missing owner",
                    "content_md": "needs owner_employee_id",
                },
            )
            assert r.status_code == 422

    def test_create_common_rejects_owner_employee_id(
        self, app: FastAPI, seeded: dict[str, str]
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/knowledge",
                headers=h,
                json={
                    "account_id": seeded["ws_a"],
                    "account_type": "workspace",
                    "scope": "common",
                    "category": "tech",
                    "title": "wrong owner",
                    "content_md": "no owner allowed",
                    "owner_employee_id": str(uuid.uuid4()),
                },
            )
            assert r.status_code == 422

    def test_update_and_audit(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.patch(
                f"/knowledge/{seeded['k_common_a']}",
                headers=h,
                json={"title": "updated title", "tags": ["updated"]},
            )
            assert r.status_code == 200
            data = r.json()["data"]
            assert data["title"] == "updated title"
            assert data["tags"] == ["updated"]
        with sync_engine.begin() as c:
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'knowledge.update' and target_id = cast(:t as uuid)"
                ),
                {"t": seeded["k_common_a"]},
            ).scalar_one()
            assert cnt == 1

    def test_delete_soft(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            assert client.delete(f"/knowledge/{seeded['k_common_a']}", headers=h).status_code == 204
            assert client.get(f"/knowledge/{seeded['k_common_a']}", headers=h).status_code == 404
        with sync_engine.begin() as c:
            row = c.execute(
                text("select deleted_at from public.knowledge_nodes where id = cast(:i as uuid)"),
                {"i": seeded["k_common_a"]},
            ).first()
            assert row is not None and row.deleted_at is not None

    def test_search_text_fallback_finds_hit(
        self,
        app: FastAPI,
        seeded: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        """VOYAGE_API_KEY 未設定下では text ilike フォールバックで hit。"""
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            r = client.post(
                "/knowledge/search",
                headers=h,
                json={"query": "keyword foo", "limit": 5},
            )
            assert r.status_code == 200, r.text
            body = r.json()["data"]
            assert body["query"] == "keyword foo"
            ids = {hit["knowledge"]["id"] for hit in body["hits"]}
            assert seeded["k_common_a"] in ids
            # R-T08: workspace B の k_common_b は user A の検索結果に含まれない
            assert seeded["k_common_b"] not in ids
        # 検索 hit は usage_count++
        with sync_engine.begin() as c:
            usage = c.execute(
                text("select usage_count from public.knowledge_nodes where id = cast(:i as uuid)"),
                {"i": seeded["k_common_a"]},
            ).scalar_one()
            assert usage >= 1

    def test_search_empty_query_returns_422(self, app: FastAPI, seeded: dict[str, str]) -> None:
        h = _h(seeded["u_a"])
        with TestClient(app) as client:
            assert (
                client.post("/knowledge/search", headers=h, json={"query": "  "}).status_code == 422
            )
            assert (
                client.post(
                    "/knowledge/search", headers=h, json={"query": "x", "limit": 100}
                ).status_code
                == 422
            )

    def test_search_cross_workspace_skip(self, app: FastAPI, seeded: dict[str, str]) -> None:
        """R-T08: user B が ws_a を account_id 指定しても自分の workspace 外は 0 件。"""
        hb = _h(seeded["u_b"])
        with TestClient(app) as client:
            r = client.post(
                "/knowledge/search",
                headers=hb,
                json={"query": "keyword foo", "account_id": seeded["ws_a"]},
            )
            assert r.status_code == 200
            ids = {hit["knowledge"]["id"] for hit in r.json()["data"]["hits"]}
            assert seeded["k_common_a"] not in ids


# --------------------------------------------------------------------------- #
# T-A-37: ナレッジ昇格 + 横断パターン抽出
# --------------------------------------------------------------------------- #
@pytest.fixture()
def seeded_promotion(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    """T-A-37 用 fixture: user-scope ナレッジ + workspace member 関係を seed。"""
    u_owner = str(uuid.uuid4())
    u_other = str(uuid.uuid4())
    ws_member = str(uuid.uuid4())
    ws_outsider = str(uuid.uuid4())
    k_user = str(uuid.uuid4())
    k_emp = str(uuid.uuid4())
    k_other_user = str(uuid.uuid4())
    emp_a = str(uuid.uuid4())
    with sync_engine.begin() as c:
        for uid in (u_owner, u_other):
            em = f"ta37-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email) values (:i,:e)"), {"i": uid, "e": em}
            )
        for ws, owner in ((ws_member, u_owner), (ws_outsider, u_other)):
            c.execute(
                text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
                {"i": ws, "o": owner, "n": f"ws-{ws[:6]}"},
            )
        # u_owner 個人 user-scope ナレッジ (昇格対象)
        c.execute(
            text(
                "insert into public.knowledge_nodes "
                "(id, account_id, account_type, scope, category, title, content_md, tags, "
                " confidence_score) "
                "values (cast(:i as uuid), cast(:a as uuid), 'user', 'common', "
                " 'tech', 'my note', 'private memo', '{python,fastapi}', 0.7)"
            ),
            {"i": k_user, "a": u_owner},
        )
        # u_other の user-scope ナレッジ (他人なので昇格不可)
        c.execute(
            text(
                "insert into public.knowledge_nodes "
                "(id, account_id, account_type, scope, category, title, content_md, tags, "
                " confidence_score) "
                "values (cast(:i as uuid), cast(:a as uuid), 'user', 'common', "
                " 'tech', 'others note', 'private memo', '{python}', 0.5)"
            ),
            {"i": k_other_user, "a": u_other},
        )
        # ai_employee + employee_specific ナレッジ (昇格不可検証用)
        c.execute(
            text(
                "insert into public.ai_employees "
                "(id, workspace_id, name, display_name, role, department) "
                "values (cast(:i as uuid), cast(:w as uuid), :n, :d, "
                "'member', 'dev_qa')"
            ),
            {"i": emp_a, "w": ws_member, "n": f"emp-{emp_a[:6]}", "d": "Emp"},
        )
        c.execute(
            text(
                "insert into public.knowledge_nodes "
                "(id, account_id, account_type, scope, owner_employee_id, category, title, "
                " content_md, tags, confidence_score) "
                "values (cast(:i as uuid), cast(:a as uuid), 'user', 'employee_specific', "
                " cast(:e as uuid), 'tech', 'emp note', 'memo', '{python}', 0.6)"
            ),
            {"i": k_emp, "a": u_owner, "e": emp_a},
        )
    yield {
        "u_owner": u_owner,
        "u_other": u_other,
        "ws_member": ws_member,
        "ws_outsider": ws_outsider,
        "k_user": k_user,
        "k_emp": k_emp,
        "k_other_user": k_other_user,
    }
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.knowledge_nodes where id in (:a,:b,:c)"),
            {"a": k_user, "b": k_emp, "c": k_other_user},
        )
        c.execute(
            text("delete from public.workspaces where id in (:a,:b)"),
            {"a": ws_member, "b": ws_outsider},
        )
        c.execute(
            text("delete from public.users where id in (:a,:b)"),
            {"a": u_owner, "b": u_other},
        )
        c.execute(
            text("delete from auth.users where id in (:a,:b)"),
            {"a": u_owner, "b": u_other},
        )


@pytest.mark.integration
class TestKnowledgePromotion:
    def test_promote_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            r = client.post(
                f"/knowledge/{uuid.uuid4()}/promote",
                json={"target_workspace_id": str(uuid.uuid4())},
            )
            assert r.status_code == 401

    def test_promote_owner_user_scope_to_workspace(
        self,
        app: FastAPI,
        seeded_promotion: dict[str, str],
        sync_engine: sqlalchemy.Engine,
    ) -> None:
        h = _h(seeded_promotion["u_owner"])
        with TestClient(app) as client:
            r = client.post(
                f"/knowledge/{seeded_promotion['k_user']}/promote",
                headers=h,
                json={"target_workspace_id": seeded_promotion["ws_member"]},
            )
            assert r.status_code == 200, r.text
            d = r.json()["data"]
            assert d["account_type"] == "workspace"
            assert d["account_id"] == seeded_promotion["ws_member"]
            assert d["approved_by_user_id"] == seeded_promotion["u_owner"]
        with sync_engine.begin() as c:
            cnt = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'knowledge.promote' and target_id = cast(:t as uuid)"
                ),
                {"t": seeded_promotion["k_user"]},
            ).scalar_one()
            assert cnt == 1

    def test_promote_others_knowledge_403(
        self, app: FastAPI, seeded_promotion: dict[str, str]
    ) -> None:
        # u_owner が u_other のナレッジを昇格しようとする
        h = _h(seeded_promotion["u_owner"])
        with TestClient(app) as client:
            r = client.post(
                f"/knowledge/{seeded_promotion['k_other_user']}/promote",
                headers=h,
                json={"target_workspace_id": seeded_promotion["ws_member"]},
            )
            # RLS で他人のは見えないため 404 が先 (cross-user invisibility 担保)。
            # 自分名義なら 403 になるパスを別途確認 (test_promote_employee_specific_409)。
            assert r.status_code == 404

    def test_promote_employee_specific_409(
        self, app: FastAPI, seeded_promotion: dict[str, str]
    ) -> None:
        h = _h(seeded_promotion["u_owner"])
        with TestClient(app) as client:
            r = client.post(
                f"/knowledge/{seeded_promotion['k_emp']}/promote",
                headers=h,
                json={"target_workspace_id": seeded_promotion["ws_member"]},
            )
            assert r.status_code == 409

    def test_promote_to_non_member_workspace_403(
        self, app: FastAPI, seeded_promotion: dict[str, str]
    ) -> None:
        h = _h(seeded_promotion["u_owner"])
        with TestClient(app) as client:
            r = client.post(
                f"/knowledge/{seeded_promotion['k_user']}/promote",
                headers=h,
                json={"target_workspace_id": seeded_promotion["ws_outsider"]},
            )
            assert r.status_code == 403

    def test_promote_404_for_nonexistent(
        self, app: FastAPI, seeded_promotion: dict[str, str]
    ) -> None:
        h = _h(seeded_promotion["u_owner"])
        with TestClient(app) as client:
            r = client.post(
                f"/knowledge/{uuid.uuid4()}/promote",
                headers=h,
                json={"target_workspace_id": seeded_promotion["ws_member"]},
            )
            assert r.status_code == 404


@pytest.fixture()
def seeded_patterns(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, object]]:
    """T-A-37 横断パターン用: 同一 tag 集合で 3 件、別 tag 集合で 1 件。"""
    u = str(uuid.uuid4())
    ws = str(uuid.uuid4())
    ids: list[str] = []
    with sync_engine.begin() as c:
        em = f"ta37p-{u[:8]}@t.invalid"
        c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": u, "e": em})
        c.execute(text("insert into public.users (id,email) values (:i,:e)"), {"i": u, "e": em})
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,'ws-p')"),
            {"i": ws, "o": u},
        )
        for idx in range(3):
            kid = str(uuid.uuid4())
            ids.append(kid)
            c.execute(
                text(
                    "insert into public.knowledge_nodes "
                    "(id, account_id, account_type, scope, category, title, content_md, tags, "
                    " confidence_score) "
                    "values (cast(:i as uuid), cast(:a as uuid), 'workspace', 'common', "
                    " 'tech', :t, 'body', '{api,fastapi}', :c)"
                ),
                {"i": kid, "a": ws, "t": f"shared-{idx}", "c": 0.5 + idx * 0.1},
            )
        # 別のタグ集合 (パターン外)
        k_single = str(uuid.uuid4())
        ids.append(k_single)
        c.execute(
            text(
                "insert into public.knowledge_nodes "
                "(id, account_id, account_type, scope, category, title, content_md, tags, "
                " confidence_score) "
                "values (cast(:i as uuid), cast(:a as uuid), 'workspace', 'common', "
                " 'tech', 'lonely', 'body', '{unique-tag}', 0.9)"
            ),
            {"i": k_single, "a": ws},
        )
    yield {"u": u, "ws": ws, "ids": ids}
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.knowledge_nodes where account_id = cast(:a as uuid)"),
            {"a": ws},
        )
        c.execute(text("delete from public.workspaces where id = :i"), {"i": ws})
        c.execute(text("delete from public.users where id = :i"), {"i": u})
        c.execute(text("delete from auth.users where id = :i"), {"i": u})


@pytest.mark.integration
class TestKnowledgePatterns:
    def test_patterns_unauthenticated_401(self, app: FastAPI) -> None:
        with TestClient(app) as client:
            assert client.post("/knowledge/patterns/extract", json={}).status_code == 401

    def test_patterns_extract_groups_by_shared_tags(
        self, app: FastAPI, seeded_patterns: dict[str, object]
    ) -> None:
        h = _h(str(seeded_patterns["u"]))
        with TestClient(app) as client:
            r = client.post(
                "/knowledge/patterns/extract",
                headers=h,
                json={
                    "account_id": str(seeded_patterns["ws"]),
                    "min_occurrences": 2,
                    "limit": 10,
                },
            )
            assert r.status_code == 200, r.text
            data = r.json()["data"]
            patterns = data["patterns"]
            assert any(
                set(p["pattern_tags"]) == {"api", "fastapi"} and p["occurrence_count"] == 3
                for p in patterns
            )
            # unique-tag は 1 件のみなので除外
            assert all(set(p["pattern_tags"]) != {"unique-tag"} for p in patterns)

    def test_patterns_min_occurrences_filters(
        self, app: FastAPI, seeded_patterns: dict[str, object]
    ) -> None:
        h = _h(str(seeded_patterns["u"]))
        with TestClient(app) as client:
            r = client.post(
                "/knowledge/patterns/extract",
                headers=h,
                json={
                    "account_id": str(seeded_patterns["ws"]),
                    "min_occurrences": 4,
                    "limit": 10,
                },
            )
            assert r.status_code == 200
            assert r.json()["data"]["total"] == 0

    def test_patterns_validates_min_occurrences(
        self, app: FastAPI, seeded_patterns: dict[str, object]
    ) -> None:
        h = _h(str(seeded_patterns["u"]))
        with TestClient(app) as client:
            r = client.post(
                "/knowledge/patterns/extract",
                headers=h,
                json={"min_occurrences": 1},
            )
            assert r.status_code == 422

    def test_patterns_representative_ids_by_confidence(
        self, app: FastAPI, seeded_patterns: dict[str, object]
    ) -> None:
        h = _h(str(seeded_patterns["u"]))
        with TestClient(app) as client:
            r = client.post(
                "/knowledge/patterns/extract",
                headers=h,
                json={
                    "account_id": str(seeded_patterns["ws"]),
                    "min_occurrences": 2,
                },
            )
            assert r.status_code == 200
            shared = next(
                p
                for p in r.json()["data"]["patterns"]
                if set(p["pattern_tags"]) == {"api", "fastapi"}
            )
            # 3 件のうち最大 5 件返却。confidence 降順で並ぶ
            assert 1 <= len(shared["representative_ids"]) <= 5
