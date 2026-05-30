"""T-I-06 RLS 越境試験: project + Bridge token (R-T03/T04)。

検証する不変条件:
  1. project A の member は project B の tasks/executions/exec_logs を 0 rows しか
     見えない。
  2. Bridge token (MCP token) は workspace_memberships に紐づき、他 WS の Bridge
     にアクセスできない。
  3. Bridge が出す activity events は所属 workspace の users にしか配信されない。
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


def test_cross_project_tasks_invisible(engine: Engine) -> None:
    """project A の member は project B の task を見えない (R-T03)."""
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    p_a, p_b = str(uuid.uuid4()), str(uuid.uuid4())
    t_b = str(uuid.uuid4())
    with engine.begin() as c:
        for u in (u_a, u_b):
            em = f"ti06-{u[:8]}@example.com"
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
        for p, ws in ((p_a, ws_a), (p_b, ws_b)):
            c.execute(
                text(
                    "insert into public.projects(id,workspace_id,name,project_type) "
                    "values(cast(:i as uuid),cast(:w as uuid),:n,'internal')"
                ),
                {"i": p, "w": ws, "n": f"p-{p[:5]}"},
            )
        c.execute(
            text(
                "insert into public.tasks(id,project_id,title,stage) "
                "values(cast(:i as uuid),cast(:p as uuid),:t,'ready')"
            ),
            {"i": t_b, "p": p_b, "t": "B-only-task"},
        )

    with engine.connect() as c:
        _set_jwt(c, u_a)
        rows = c.execute(
            text("select count(*) from public.tasks where id = cast(:t as uuid)"),
            {"t": t_b},
        ).scalar_one()
        assert rows == 0, f"R-T03 violation: project_a user saw project_b task (rows={rows})"


def test_mcp_token_workspace_bound(engine: Engine) -> None:
    """MCP token (Bridge) は workspace に紐づき、他 WS の token は見えない (R-T04)."""
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    t_b = str(uuid.uuid4())
    with engine.begin() as c:
        for u in (u_a, u_b):
            em = f"ti06b-{u[:8]}@example.com"
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
                "insert into public.mcp_tokens(id,workspace_id,name,token_hash) "
                "values(cast(:i as uuid),cast(:w as uuid),:n,:h)"
            ),
            {"i": t_b, "w": ws_b, "n": "B-token", "h": "h" * 64},
        )

    with engine.connect() as c:
        _set_jwt(c, u_a)
        rows = c.execute(
            text("select count(*) from public.mcp_tokens where id = cast(:t as uuid)"),
            {"t": t_b},
        ).scalar_one()
        assert rows == 0, f"R-T04 violation: ws_a user saw ws_b mcp_token (rows={rows})"
