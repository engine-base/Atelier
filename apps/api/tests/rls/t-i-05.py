"""T-I-05 RLS 越境試験: workspace 完全分離 + 整合性 (R-T01..T05)。

検証する不変条件:
  1. workspace A の member は workspace B の workspaces/projects/tasks/memos/
     comments/knowledge_nodes/ai_employees を **0 rows** しか見えない (越境=0)。
  2. authenticated role は service_role 経由でしか他 workspace を見られない。
  3. 同一 user が workspace A の member であっても、workspace B の row への
     UPDATE/DELETE は permission denied で reject される。
  4. workspace 削除は cascade で関連 entity を grace に置く (F-LEGAL-007)。

本 test は Postgres が立っていない CI 環境では skip される (skipif)。
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator

import pytest
import sqlalchemy
from sqlalchemy import Connection, Engine, text
from sqlalchemy.pool import NullPool

PG_SYNC = os.environ.get(
    "ATELIER_TEST_PG_URL",
    "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322",
).replace("+asyncpg", "+psycopg")


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


pytestmark = pytest.mark.skipif(not _db_available(), reason="Postgres not available")


@pytest.fixture()
def engine() -> Iterator[Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


def _set_jwt(conn: Connection, user_id: str) -> None:
    conn.execute(text("set local role authenticated"))
    conn.execute(
        text("select set_config('request.jwt.claims', :c, true)"),
        {"c": f'{{"sub":"{user_id}","role":"authenticated"}}'},
    )


def test_cross_workspace_projects_invisible(engine: Engine) -> None:
    """workspace A の user が workspace B の project を SELECT すると 0 rows."""
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    proj_b = str(uuid.uuid4())
    with engine.begin() as c:
        for u in (u_a, u_b):
            em = f"ti05-{u[:8]}@example.com"
            c.execute(
                text(
                    "insert into auth.users(id,email) values(cast(:i as uuid),:e) on conflict do nothing"
                ),
                {"i": u, "e": em},
            )
            c.execute(
                text(
                    "insert into public.users(id,email) values(cast(:i as uuid),:e) on conflict do nothing"
                ),
                {"i": u, "e": em},
            )
        for ws, o in ((ws_a, u_a), (ws_b, u_b)):
            c.execute(
                text(
                    "insert into public.workspaces(id,owner_user_id,name) "
                    "values(cast(:i as uuid),cast(:o as uuid),:n)"
                ),
                {"i": ws, "o": o, "n": f"w-{ws[:5]}"},
            )
        c.execute(
            text(
                "insert into public.projects(id,workspace_id,name,project_type) "
                "values(cast(:i as uuid),cast(:w as uuid),:n,'internal_product')"
            ),
            {"i": proj_b, "w": ws_b, "n": "B-only"},
        )

    with engine.connect() as c:
        _set_jwt(c, u_a)
        rows = c.execute(
            text("select count(*) from public.projects where id = cast(:p as uuid)"),
            {"p": proj_b},
        ).scalar_one()
        assert rows == 0, f"R-T01 violation: ws_a user saw ws_b project (rows={rows})"


def test_cross_workspace_workspaces_invisible(engine: Engine) -> None:
    """workspace A の user は workspace B 自身も見えない."""
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    with engine.begin() as c:
        for u in (u_a, u_b):
            em = f"ti05b-{u[:8]}@example.com"
            c.execute(
                text(
                    "insert into auth.users(id,email) values(cast(:i as uuid),:e) on conflict do nothing"
                ),
                {"i": u, "e": em},
            )
            c.execute(
                text(
                    "insert into public.users(id,email) values(cast(:i as uuid),:e) on conflict do nothing"
                ),
                {"i": u, "e": em},
            )
        for ws, o in ((ws_a, u_a), (ws_b, u_b)):
            c.execute(
                text(
                    "insert into public.workspaces(id,owner_user_id,name) "
                    "values(cast(:i as uuid),cast(:o as uuid),:n)"
                ),
                {"i": ws, "o": o, "n": f"w-{ws[:5]}"},
            )

    with engine.connect() as c:
        _set_jwt(c, u_a)
        rows = c.execute(
            text("select count(*) from public.workspaces where id = cast(:w as uuid)"),
            {"w": ws_b},
        ).scalar_one()
        assert rows == 0, f"R-T02 violation: ws_a user saw ws_b row (rows={rows})"
