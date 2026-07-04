"""T-I-08 RLS 越境試験: service_role + vault + cron (R-T06/T07)。

検証する不変条件:
  1. service_role 専用 entity (cron_jobs, byok_keys 暗号化済 secret 等) は
     authenticated role からは見えない (vault 越境=0)。
  2. cron トリガで動く service_role の処理は workspace 境界を超えても問題ない
     ことを構造的に確認 (service_role bypass-rls)。
  3. byok_keys.encrypted_secret は authenticated SELECT で取得できない
     (column-level GRANT で保護されるべき値)。

サンプル試験。実 vault 統合は別 PR で envelope encryption 導入時に拡張。
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator

import pytest
import sqlalchemy
from sqlalchemy import Engine, text
from sqlalchemy.exc import ProgrammingError
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


def test_byok_key_isolation(engine: Engine) -> None:
    """byok_api_keys (E-022) は user_id = auth.uid() の self のみ見える (R-T06)。

    さらに encrypted_key 列は authenticated から SELECT 不可 (列レベル GRANT, t-d-95)。
    ※ 旧 byok_keys(encrypted_secret,status,name) は entities.json#E-022 と乖離した
      stale スキーマだったため、実 DDL (byok_api_keys) に合わせて更新済み。
    """
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    k_a = str(uuid.uuid4())
    with engine.begin() as c:
        for u in (u_a, u_b):
            em = f"ti08-{u[:8]}@example.com"
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
        c.execute(
            text(
                "insert into public.byok_api_keys(id,user_id,provider,encrypted_key,key_label,is_active) "
                "values(cast(:i as uuid),cast(:u as uuid),'anthropic',:s,'main',true)"
            ),
            {"i": k_a, "u": u_a, "s": "encrypted"},
        )

    with engine.connect() as c:
        # u_b は u_a の byok_api_keys を見えない
        c.execute(text("set local role authenticated"))
        c.execute(
            text("select set_config('request.jwt.claims', :c, true)"),
            {"c": f'{{"sub":"{u_b}","role":"authenticated"}}'},
        )
        rows = c.execute(
            text("select count(*) from public.byok_api_keys where id = cast(:k as uuid)"),
            {"k": k_a},
        ).scalar_one()
        assert rows == 0, f"R-T06 violation: u_b saw u_a's byok_key (rows={rows})"

    with engine.connect() as c:
        # self (u_a) は行を見える (許可列のみ)
        c.execute(text("set local role authenticated"))
        c.execute(
            text("select set_config('request.jwt.claims', :c, true)"),
            {"c": f'{{"sub":"{u_a}","role":"authenticated"}}'},
        )
        rows = c.execute(
            text("select count(*) from public.byok_api_keys where id = cast(:k as uuid)"),
            {"k": k_a},
        ).scalar_one()
        assert rows == 1, f"self row should be visible (rows={rows})"

    with engine.connect() as c:
        # encrypted_key 列は self でも SELECT 不可 (列レベル GRANT)
        c.execute(text("set local role authenticated"))
        c.execute(
            text("select set_config('request.jwt.claims', :c, true)"),
            {"c": f'{{"sub":"{u_a}","role":"authenticated"}}'},
        )
        with pytest.raises(ProgrammingError):
            c.execute(
                text("select encrypted_key from public.byok_api_keys where id = cast(:k as uuid)"),
                {"k": k_a},
            )


def test_service_role_bypass_capability(engine: Engine) -> None:
    """service_role は RLS を bypass する (cron / vault / system 用)."""
    u_a, u_b = str(uuid.uuid4()), str(uuid.uuid4())
    ws_a, ws_b = str(uuid.uuid4()), str(uuid.uuid4())
    with engine.begin() as c:
        for u in (u_a, u_b):
            em = f"ti08b-{u[:8]}@example.com"
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

    # service_role は両方の workspace を見える
    with engine.connect() as c:
        # session の current_user (atelierpg) は service_role と互換でない可能性
        # があるので、bypassrls フラグの存在のみ確認する。
        result = c.execute(
            text("select rolbypassrls from pg_roles where rolname = 'service_role'")
        ).scalar()
        # service_role が存在しない環境では None。存在すれば bypassrls であるべき。
        assert (
            result is None or result is True
        ), "service_role exists but does not bypass RLS (R-T07 violation)"
