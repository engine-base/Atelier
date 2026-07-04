"""Tests for /search（横断検索, T-UC-40）。

- サービスの純関数（kinds_for / row_to_hit）は DB 不要で検証。
- ルートは svc.search をモックして 200 / 422 を検証。
- ★実 SQL は実 Postgres で実行して検証する（モックでは enum/列名の実スキーマ乖離を
  原理的に検出できない。実際 employee 検索の coalesce(role,'') が実機で 500 になっていた）。
"""

from __future__ import annotations

import os
import uuid
from types import SimpleNamespace
from typing import Any

import pytest
import sqlalchemy
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.routes.search import router
from src.schemas.search import SearchHit
from src.services import search as search_svc

pytest.importorskip("fastapi")
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

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


def test_kinds_for_all_returns_every_kind() -> None:
    assert search_svc.kinds_for("all") == ["project", "task", "knowledge", "employee"]


def test_kinds_for_single_and_unknown() -> None:
    assert search_svc.kinds_for("task") == ["task"]
    assert search_svc.kinds_for("bogus") == []


def test_row_to_hit_normalizes_snippet_none() -> None:
    hit = search_svc.row_to_hit("project", SimpleNamespace(id="p1", title="P", snippet=None))
    assert hit == SearchHit(id="p1", kind="project", title="P", snippet="")


def test_row_to_hit_keeps_snippet() -> None:
    hit = search_svc.row_to_hit("task", SimpleNamespace(id="t1", title="T", snippet="詳細"))
    assert hit.snippet == "詳細"
    assert hit.kind == "task"


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: CurrentUser(
        id="u1", role="authenticated", claims={}
    )
    app.dependency_overrides[get_rls_session] = lambda: SimpleNamespace()
    return app


def test_search_route_returns_hits(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _fake_search(_session: Any, *, q: str, kind: str) -> list[SearchHit]:
        assert q == "atelier"
        assert kind == "all"
        return [SearchHit(id="p1", kind="project", title="Atelier", snippet="")]

    monkeypatch.setattr(search_svc, "search", _fake_search)
    with TestClient(_app()) as client:
        res = client.get("/search", params={"q": "atelier"})
    assert res.status_code == 200
    assert res.json()["data"] == [
        {"id": "p1", "kind": "project", "title": "Atelier", "snippet": ""}
    ]


def test_search_route_422_without_q() -> None:
    with TestClient(_app()) as client:
        res = client.get("/search")
    assert res.status_code == 422


@pytest.mark.skipif(not _db_available(), reason="Postgres not available")
def test_search_real_sql_employee_no_500() -> None:
    """実 SQL を実 Postgres で実行。employee 検索が enum で 500 しないことを担保。

    回帰: coalesce(role, '') は '' を ai_employee_role_enum に解決しようとして
    「invalid input value for enum: ""」で 500 になっていた（役割は非 NULL でも発火）。
    role::text へ修正済み。kind='all' でも 4 kind 全 SQL が実行できることを確認する。
    """
    import asyncio

    ws = str(uuid.uuid4())
    owner = str(uuid.uuid4())
    emp = str(uuid.uuid4())

    async def _run() -> list[SearchHit]:
        eng = create_async_engine(PG_ASYNC, poolclass=NullPool)
        try:
            async with eng.begin() as c:
                await c.execute(
                    text("insert into auth.users(id,email) values(:i,:e) on conflict do nothing"),
                    {"i": owner, "e": f"srch-{owner[:8]}@t.invalid"},
                )
                await c.execute(
                    text("insert into public.users(id,email) values(:i,:e) on conflict do nothing"),
                    {"i": owner, "e": f"srch-{owner[:8]}@t.invalid"},
                )
                await c.execute(
                    text("insert into public.workspaces(id,owner_user_id,name) values(:i,:o,:n)"),
                    {"i": ws, "o": owner, "n": "SrchWS"},
                )
                await c.execute(
                    text(
                        "insert into public.ai_employees(id,workspace_id,name,display_name,role,department) "
                        "values(:i,:w,'srchemp','SrchTony','lead','sales')"
                    ),
                    {"i": emp, "w": ws},
                )
            async with AsyncSession(eng) as s:
                # kind='all' で全 SQL（employee 含む）を実行 → 500 にならないこと
                hits = await search_svc.search(s, q="Srch", kind="all")
            return hits
        finally:
            async with eng.begin() as c:
                await c.execute(text("delete from public.ai_employees where id=:i"), {"i": emp})
                await c.execute(text("delete from public.workspaces where id=:i"), {"i": ws})
                await c.execute(text("delete from public.users where id=:i"), {"i": owner})
                await c.execute(text("delete from auth.users where id=:i"), {"i": owner})
            await eng.dispose()

    hits = asyncio.run(_run())
    emp_hits = [h for h in hits if h.kind == "employee" and h.id == emp]
    assert emp_hits, "employee 検索がヒットしない（実 SQL 経路が壊れている）"
    assert emp_hits[0].snippet == "lead"  # role::text がそのまま入る
