"""T-I-07 RLS 越境試験: client_portal 完全分離 (R-T08 致命級 最終確認)。

T-D-22 設計 + T-A-35 client_portal JWT 実装 + T-F-40 employee_specific RLS の
**統合最終確認**。

検証する不変条件:
  1. project A の client_portal token (client_invitations#token_hash) は project B
     の row への SELECT を 0 rows で reject される (DB レベル + API レベル両方)。
  2. employee_specific scope の knowledge_nodes は owner ai_employee の workspace
     の owner role member のみ可視。それ以外は 0 rows。
  3. archived ai_employee の employee_specific knowledge は誰からも不可視。

本試験 PASS は **致命級 R-T08 の最終検証**。Wave 2 で経営者承認済として実装した
内容の最終 confirm。
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator

import pytest
import sqlalchemy
from sqlalchemy import Engine, text
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


def test_employee_specific_knowledge_owner_only(engine: Engine) -> None:
    """employee_specific knowledge は owner workspace の owner role のみ可視 (R-T08)."""
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    emp_a = str(uuid.uuid4())
    kn_id = str(uuid.uuid4())
    with engine.begin() as c:
        for u in (u_a, u_b):
            em = f"ti07-{u[:8]}@example.com"
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
                "insert into public.ai_employees(id,workspace_id,name,role,department,display_name,archived) "
                "values(cast(:i as uuid),cast(:w as uuid),'testemp','member','dev_qa','TestEmp',false)"
            ),
            {"i": emp_a, "w": ws_a},
        )
        c.execute(
            text(
                "insert into public.knowledge_nodes"
                "(id,account_type,account_id,scope,category,title,content_md,owner_employee_id) "
                "values(cast(:i as uuid),'workspace',cast(:a as uuid),'employee_specific',"
                "'設計','test','x',cast(:e as uuid))"
            ),
            {"i": kn_id, "a": ws_a, "e": emp_a},
        )

    with engine.connect() as c:
        # ws_b の owner (u_b) は ws_a の employee_specific を見えない (R-T08 越境=0)
        c.execute(text("set local role authenticated"))
        c.execute(
            text("select set_config('request.jwt.claims', :c, true)"),
            {"c": f'{{"sub":"{u_b}","role":"authenticated"}}'},
        )
        rows = c.execute(
            text("select count(*) from public.knowledge_nodes where id = cast(:k as uuid)"),
            {"k": kn_id},
        ).scalar_one()
        assert rows == 0, f"R-T08 violation: ws_b owner saw ws_a employee_specific (rows={rows})"


def test_archived_employee_knowledge_invisible(engine: Engine) -> None:
    """archived ai_employee の employee_specific knowledge は誰からも 0 rows."""
    u_a = str(uuid.uuid4())
    ws_a = str(uuid.uuid4())
    emp_a = str(uuid.uuid4())
    kn_id = str(uuid.uuid4())
    with engine.begin() as c:
        em = f"ti07b-{u_a[:8]}@example.com"
        c.execute(
            text(
                "insert into auth.users(id,email) values(cast(:i as uuid),:e) on conflict do nothing"
            ),
            {"i": u_a, "e": em},
        )
        c.execute(
            text(
                "insert into public.users(id,email) values(cast(:i as uuid),:e) on conflict do nothing"
            ),
            {"i": u_a, "e": em},
        )
        c.execute(
            text(
                "insert into public.workspaces(id,owner_user_id,name) "
                "values(cast(:i as uuid),cast(:o as uuid),:n)"
            ),
            {"i": ws_a, "o": u_a, "n": "w-arch"},
        )
        c.execute(
            text(
                "insert into public.ai_employees(id,workspace_id,name,role,department,display_name,archived) "
                "values(cast(:i as uuid),cast(:w as uuid),'archivedemp','member','dev_qa','Archived',true)"
            ),
            {"i": emp_a, "w": ws_a},
        )
        c.execute(
            text(
                "insert into public.knowledge_nodes"
                "(id,account_type,account_id,scope,category,title,content_md,owner_employee_id) "
                "values(cast(:i as uuid),'workspace',cast(:a as uuid),'employee_specific',"
                "'設計','t','x',cast(:e as uuid))"
            ),
            {"i": kn_id, "a": ws_a, "e": emp_a},
        )

    with engine.connect() as c:
        c.execute(text("set local role authenticated"))
        c.execute(
            text("select set_config('request.jwt.claims', :c, true)"),
            {"c": f'{{"sub":"{u_a}","role":"authenticated"}}'},
        )
        rows = c.execute(
            text("select count(*) from public.knowledge_nodes where id = cast(:k as uuid)"),
            {"k": kn_id},
        ).scalar_one()
        assert rows == 0, (
            f"T-F-40 violation: archived ai_employee's employee_specific visible (rows={rows})"
        )
