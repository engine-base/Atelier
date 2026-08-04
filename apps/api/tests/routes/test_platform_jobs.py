"""GAP-014 プラットフォーム必須ジョブの integration tests — 実 Postgres。

purge_deleted_accounts は実 FK (workspaces restrict / cascade) を跨ぐ破壊的
ロジックのため、実 DB で「30 日経過のみ消え、猶予中・現役は絶対に残る」を検証する。
run_integrity_check は実スキーマの矛盾検出 + approval_inbox 通知 (dedupe) を検証。
"""

from __future__ import annotations

import asyncio
import os
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

PG_ASYNC = os.environ.get(
    "ATELIER_TEST_PG_URL", "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
PG_SYNC = PG_ASYNC.replace("+asyncpg", "+psycopg")
os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

import sqlalchemy  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine  # noqa: E402
from sqlalchemy.pool import NullPool  # noqa: E402

from src.services.platform_jobs import (  # noqa: E402
    next_run_utc,
    purge_deleted_accounts,
    run_integrity_check,
)


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


def _run_service(fn: Any) -> dict[str, str]:
    """service 関数を service-role (RLS 無し) の AsyncSession で実行して commit。"""

    async def _inner() -> dict[str, str]:
        engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
        try:
            async with AsyncSession(engine) as session:
                result = await fn(session)
                await session.commit()
                return result
        finally:
            await engine.dispose()

    return asyncio.run(_inner())


@pytest.fixture()
def sync_engine() -> Iterator[sqlalchemy.Engine]:
    eng = sqlalchemy.create_engine(PG_SYNC, poolclass=NullPool)
    yield eng
    eng.dispose()


class TestNextRunUtc:
    def test_daily_before_and_after(self) -> None:
        now = datetime(2026, 8, 4, 10, 0, tzinfo=UTC)
        nxt = next_run_utc("0 15 * * *", now)
        assert nxt == datetime(2026, 8, 4, 15, 0, tzinfo=UTC)
        nxt2 = next_run_utc("0 15 * * *", datetime(2026, 8, 4, 16, 0, tzinfo=UTC))
        assert nxt2 == datetime(2026, 8, 5, 15, 0, tzinfo=UTC)

    def test_every_minute(self) -> None:
        now = datetime(2026, 8, 4, 10, 30, 20, tzinfo=UTC)
        assert next_run_utc("* * * * *", now) == datetime(2026, 8, 4, 10, 31, tzinfo=UTC)

    def test_weekly(self) -> None:
        # 2026-08-04 は火曜。次の月曜 (cron dow=1) 00:00 は 08-10。
        now = datetime(2026, 8, 4, 10, 0, tzinfo=UTC)
        assert next_run_utc("0 0 * * 1", now) == datetime(2026, 8, 10, 0, 0, tzinfo=UTC)

    def test_unsupported_returns_none(self) -> None:
        now = datetime(2026, 8, 4, 10, 0, tzinfo=UTC)
        assert next_run_utc("0 0 1 * *", now) is None  # 月次 (dom 指定) は非対応
        assert next_run_utc("*/5 * * * *", now) is None
        assert next_run_utc("bogus", now) is None


@pytest.fixture()
def purge_seed(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    """3 ユーザー: 31 日前退会 (purge 対象) / 5 日前退会 (猶予中) / 現役。"""
    u_due, u_grace, u_active = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    ws_due, ws_active = str(uuid.uuid4()), str(uuid.uuid4())
    now = datetime.now(UTC)
    with sync_engine.begin() as c:
        for uid, deleted in (
            (u_due, now - timedelta(days=31)),
            (u_grace, now - timedelta(days=5)),
            (u_active, None),
        ):
            em = f"gap014-{uid[:8]}@t.invalid"
            c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": uid, "e": em})
            c.execute(
                text("insert into public.users (id,email,deleted_at) values (:i,:e,:d)"),
                {"i": uid, "e": em, "d": deleted},
            )
        for ws, owner in ((ws_due, u_due), (ws_active, u_active)):
            c.execute(
                text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
                {"i": ws, "o": owner, "n": f"gap014-{ws[:6]}"},
            )
    yield {"u_due": u_due, "u_grace": u_grace, "u_active": u_active, "ws_due": ws_due}
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.workspaces where id in (:a,:b)"),
            {"a": ws_due, "b": ws_active},
        )
        for uid in (u_due, u_grace, u_active):
            c.execute(text("delete from public.users where id = cast(:i as uuid)"), {"i": uid})
            c.execute(text("delete from auth.users where id = cast(:i as uuid)"), {"i": uid})


@pytest.mark.integration
class TestPurgeDeletedAccounts:
    def test_purges_only_grace_expired(
        self, sync_engine: sqlalchemy.Engine, purge_seed: dict[str, str]
    ) -> None:
        result = _run_service(purge_deleted_accounts)
        assert int(result["purged_users"]) >= 1
        with sync_engine.begin() as c:
            remain = {
                str(r.id)
                for r in c.execute(
                    text("select id from public.users where id in (:a,:b,:c)"),
                    {
                        "a": purge_seed["u_due"],
                        "b": purge_seed["u_grace"],
                        "c": purge_seed["u_active"],
                    },
                ).all()
            }
            # 31 日経過のみ物理削除。猶予中 (T-A-05 復活可能) と現役は絶対に残る
            assert purge_seed["u_due"] not in remain
            assert purge_seed["u_grace"] in remain
            assert purge_seed["u_active"] in remain
            # auth 側も消えている
            auth_gone = c.execute(
                text("select count(*) from auth.users where id = cast(:i as uuid)"),
                {"i": purge_seed["u_due"]},
            ).scalar_one()
            assert auth_gone == 0
            # 所有 workspace も削除
            ws_gone = c.execute(
                text("select count(*) from public.workspaces where id = cast(:i as uuid)"),
                {"i": purge_seed["ws_due"]},
            ).scalar_one()
            assert ws_gone == 0
            # 削除実行の監査証跡
            audited = c.execute(
                text(
                    "select count(*) from public.audit_logs "
                    "where action = 'platform.account.purged' and target_id = cast(:i as uuid)"
                ),
                {"i": purge_seed["u_due"]},
            ).scalar_one()
            assert audited == 1

    def test_noop_when_nothing_due(self, sync_engine: sqlalchemy.Engine) -> None:
        result = _run_service(purge_deleted_accounts)
        assert result["status"] == "ok"
        assert result["purged_users"] == "0"


@pytest.fixture()
def integrity_seed(sync_engine: sqlalchemy.Engine) -> Iterator[dict[str, str]]:
    """dangling dependency を持つタスク 1 件をシード。"""
    owner = str(uuid.uuid4())
    ws = str(uuid.uuid4())
    proj = str(uuid.uuid4())
    task = str(uuid.uuid4())
    with sync_engine.begin() as c:
        em = f"gap014i-{owner[:8]}@t.invalid"
        c.execute(text("insert into auth.users (id,email) values (:i,:e)"), {"i": owner, "e": em})
        c.execute(text("insert into public.users (id,email) values (:i,:e)"), {"i": owner, "e": em})
        c.execute(
            text("insert into public.workspaces (id,owner_user_id,name) values (:i,:o,:n)"),
            {"i": ws, "o": owner, "n": f"gap014i-{ws[:6]}"},
        )
        c.execute(
            text(
                "insert into public.projects (id,workspace_id,name,project_type) "
                "values (:i,:w,:n,'internal_product')"
            ),
            {"i": proj, "w": ws, "n": "integrity-seed"},
        )
        c.execute(
            text(
                "insert into public.tasks "
                "(id,project_id,title,type,category,estimated_hours,dependencies) "
                "values (cast(:i as uuid), cast(:p as uuid), 'dangling dep task', "
                "'feature', 'backend', 1, cast(:deps as uuid[]))"
            ),
            {"i": task, "p": proj, "deps": [str(uuid.uuid4())]},
        )
    yield {"owner": owner, "ws": ws, "proj": proj, "task": task}
    with sync_engine.begin() as c:
        c.execute(
            text("delete from public.approval_inbox where target_id = cast(:p as uuid)"),
            {"p": proj},
        )
        c.execute(text("delete from public.workspaces where id = cast(:i as uuid)"), {"i": ws})
        c.execute(text("delete from public.users where id = cast(:i as uuid)"), {"i": owner})
        c.execute(text("delete from auth.users where id = cast(:i as uuid)"), {"i": owner})


@pytest.mark.integration
class TestIntegrityCheck:
    def test_detects_and_notifies_owner_once(
        self, sync_engine: sqlalchemy.Engine, integrity_seed: dict[str, str]
    ) -> None:
        result = _run_service(run_integrity_check)
        assert int(result["projects_with_issues"]) >= 1
        with sync_engine.begin() as c:
            rows = c.execute(
                text(
                    "select user_id, status, payload from public.approval_inbox "
                    "where type = 'integrity_alert' and target_id = cast(:p as uuid)"
                ),
                {"p": integrity_seed["proj"]},
            ).all()
            assert len(rows) == 1
            assert str(rows[0].user_id) == integrity_seed["owner"]
            assert rows[0].status == "pending"
        # 2 回目: pending がある間は重複通知しない (dedupe)
        _run_service(run_integrity_check)
        with sync_engine.begin() as c:
            cnt = c.execute(
                text(
                    "select count(*) from public.approval_inbox "
                    "where type = 'integrity_alert' and target_id = cast(:p as uuid)"
                ),
                {"p": integrity_seed["proj"]},
            ).scalar_one()
            assert cnt == 1
