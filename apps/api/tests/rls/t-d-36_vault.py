"""T-D-36 RLS 越境試験: project_credentials (プロジェクト・シークレット)。

検証する不変条件:
  1. project の workspace member は自 project のシークレットを見られる。
  2. 無関係な user は他 project のシークレットを **0 rows** しか見えない (越境=0)。

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


def test_vault_cross_project_invisible(engine: Engine) -> None:
    """workspace A の owner が作ったシークレットは、無関係な user B からは 0 rows。"""
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a = str(uuid.uuid4())
    proj_a = str(uuid.uuid4())
    cred_a = str(uuid.uuid4())
    with engine.begin() as c:
        for u in (u_a, u_b):
            em = f"vault-{u[:8]}@example.com"
            c.execute(
                text(
                    "insert into auth.users(id,email) values(cast(:i as uuid),:e) "
                    "on conflict do nothing"
                ),
                {"i": u, "e": em},
            )
            c.execute(
                text(
                    "insert into public.users(id,email) values(cast(:i as uuid),:e) "
                    "on conflict do nothing"
                ),
                {"i": u, "e": em},
            )
        c.execute(
            text(
                "insert into public.workspaces(id,owner_user_id,name) "
                "values(cast(:i as uuid),cast(:o as uuid),:n)"
            ),
            {"i": ws_a, "o": u_a, "n": "ws-a"},
        )
        c.execute(
            text(
                "insert into public.workspace_memberships(workspace_id,user_id,role) "
                "values(cast(:w as uuid),cast(:u as uuid),'owner') "
                "on conflict do nothing"  # t-d-90 owner bootstrap trigger と重複回避
            ),
            {"w": ws_a, "u": u_a},
        )
        c.execute(
            text(
                "insert into public.projects(id,workspace_id,name,project_type,status) "
                "values(cast(:i as uuid),cast(:w as uuid),:n,'internal_product','active')"
            ),
            {"i": proj_a, "w": ws_a, "n": "A-proj"},
        )
        c.execute(
            text(
                "insert into public.project_credentials"
                "(id,project_id,name,kind,encrypted_value,last4,created_by) "
                "values(cast(:i as uuid),cast(:p as uuid),:n,'token',:ev,:l4,cast(:o as uuid))"
            ),
            {"i": cred_a, "p": proj_a, "n": "secret", "ev": "gAAAA_enc", "l4": "ab12", "o": u_a},
        )

    # owner (u_a) は見える
    with engine.connect() as c:
        _set_jwt(c, u_a)
        seen = c.execute(
            text("select count(*) from public.project_credentials where id = cast(:i as uuid)"),
            {"i": cred_a},
        ).scalar_one()
        assert seen == 1, f"owner should see own vault (got {seen})"

    # 無関係な user_b は 0 rows (越境=0)
    with engine.connect() as c:
        _set_jwt(c, u_b)
        seen_b = c.execute(
            text("select count(*) from public.project_credentials where id = cast(:i as uuid)"),
            {"i": cred_a},
        ).scalar_one()
        assert seen_b == 0, f"R-vault violation: stranger saw vault (rows={seen_b})"
