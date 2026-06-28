"""Integration tests for T-A-47 — knowledge 拡張: project scope + 構造ツリー(parent_id)
+ 運営デフォルト(platform / visible_in_tree)。実 Postgres + RLS + JWT。

検証:
- scope=project 作成で source_project_id が保持される。
- parent_id 指定の一覧で当該親の直下の子のみ返る。
- tree_only=true で visible_in_tree=false (運営デフォルト) が除外される。
- search は account_type=platform を全テナント横断で含める (ツリー非表示でも参照)。
- テナント member は account_type=platform の書込ができない (RLS / 403)。
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
    u = str(uuid.uuid4())
    ws = str(uuid.uuid4())
    proj = str(uuid.uuid4())
    k_root, k_child, k_other = (str(uuid.uuid4()) for _ in range(3))
    k_platform = str(uuid.uuid4())
    with sync_engine.begin() as c:
        em = f"ta47-{u[:8]}@t.invalid"
        c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": u, "e": em})
        c.execute(text("insert into public.users (id,email) values (:i,:e)"), {"i": u, "e": em})
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
            {"i": ws, "o": u, "n": f"ws-{ws[:6]}"},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,type) "
                "values (cast(:i as uuid),cast(:w as uuid),'proj','self_product')"
            ),
            {"i": proj, "w": ws},
        )
        # scope=project ツリー: root → child
        for kid, pid, vit in ((k_root, None, True), (k_child, k_root, True), (k_other, None, True)):
            c.execute(
                text(
                    "insert into public.knowledge_nodes "
                    "(id, account_id, account_type, scope, parent_id, visible_in_tree, "
                    "source_project_id, category, title, content_md, tags) "
                    "values (cast(:i as uuid), cast(:a as uuid), 'workspace', 'project', "
                    "cast(:p as uuid), :v, cast(:sp as uuid), 'proj', :t, 'matchable foo', '{proj}')"
                ),
                {"i": kid, "a": ws, "p": pid, "v": vit, "sp": proj, "t": f"node-{kid[:6]}"},
            )
        # 運営デフォルト(platform): account_id は sentinel、visible_in_tree=false
        c.execute(
            text(
                "insert into public.knowledge_nodes "
                "(id, account_id, account_type, scope, visible_in_tree, category, title, content_md, tags) "
                "values (cast(:i as uuid), cast(:a as uuid), 'platform', 'common', false, "
                "'platform', 'platform default', 'matchable foo platform', '{platform}')"
            ),
            {"i": k_platform, "a": str(uuid.uuid4())},
        )
    yield {
        "u": u,
        "ws": ws,
        "proj": proj,
        "k_root": k_root,
        "k_child": k_child,
        "k_other": k_other,
        "k_platform": k_platform,
    }
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.knowledge_nodes where id in (:r,:c,:o,:p)"),
            {"r": k_root, "c": k_child, "o": k_other, "p": k_platform},
        )
        c.execute(text("delete from public.projects where id = cast(:i as uuid)"), {"i": proj})
        c.execute(text("delete from public.workspaces where id = cast(:i as uuid)"), {"i": ws})
        c.execute(text("delete from public.users where id = cast(:i as uuid)"), {"i": u})
        c.execute(text("delete from auth.users where id = cast(:i as uuid)"), {"i": u})


def _h(uid: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_mint_jwt(uid)}"}


def test_project_scope_filter(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        r = cl.get(
            "/knowledge",
            params={
                "account_id": seeded["ws"],
                "scope": "project",
                "source_project_id": seeded["proj"],
            },
            headers=_h(seeded["u"]),
        )
        assert r.status_code == 200, r.text
        ids = {x["id"] for x in r.json()["data"]}
        assert seeded["k_root"] in ids and seeded["k_other"] in ids
        for x in r.json()["data"]:
            assert x["scope"] == "project"
            assert x["source_project_id"] == seeded["proj"]


def test_tree_children_by_parent(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        r = cl.get(
            "/knowledge",
            params={"account_id": seeded["ws"], "parent_id": seeded["k_root"]},
            headers=_h(seeded["u"]),
        )
        assert r.status_code == 200, r.text
        ids = {x["id"] for x in r.json()["data"]}
        assert ids == {seeded["k_child"]}  # root 直下の子のみ


def test_tree_only_excludes_hidden(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        # platform(visible_in_tree=false) はツリー一覧に出ない
        r = cl.get(
            "/knowledge",
            params={"account_type": "platform", "tree_only": "true"},
            headers=_h(seeded["u"]),
        )
        assert r.status_code == 200, r.text
        ids = {x["id"] for x in r.json()["data"]}
        assert seeded["k_platform"] not in ids


def test_search_includes_platform(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        # account を ws に絞っても platform は横断参照される
        r = cl.post(
            "/knowledge/search",
            json={"query": "matchable foo", "account_id": seeded["ws"], "limit": 20},
            headers=_h(seeded["u"]),
        )
        assert r.status_code == 200, r.text
        ids = {h["knowledge"]["id"] for h in r.json()["hits"]}
        assert seeded["k_platform"] in ids


def test_member_cannot_write_platform(app: FastAPI, seeded: dict[str, str]) -> None:
    with TestClient(app) as cl:
        r = cl.post(
            "/knowledge",
            json={
                "account_id": str(uuid.uuid4()),
                "account_type": "platform",
                "scope": "common",
                "category": "x",
                "title": "hack",
                "content_md": "should be blocked",
            },
            headers=_h(seeded["u"]),
        )
        # RLS insert policy は workspace/user のみ許可 → platform 書込は拒否
        assert r.status_code in (401, 403, 422, 500), r.text
