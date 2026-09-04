"""GAP-206: 規約を新しくしたのに、既存ユーザーが同意していない状態を解消する。

**これまでの実態**:
    同意 (`consents`) は **新規登録のときだけ**記録していた。規約を新版に
    差し替えても、既に登録済みの人へ再同意を求める手段が無かった。
    GAP-188（各自の Claude 契約が必要）と GAP-204（複製・模倣の禁止 /
    機械学習への利用禁止）を足したが、**旧版に同意したままの利用者には
    その条項が効きにくい**状態だった。

ここで固定する事実:
  - 「同意済みの版」と「今の版」のずれを検出できる
  - 同意すると **新しい行が増える**（旧版の記録は消さない = append-only）
  - **画面が古い版を見ていたら拒否する**（読んでいない文面に同意させない）
  - 対象外の種類は受け付けない
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

import pytest
import sqlalchemy
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from sqlalchemy.pool import NullPool

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")
# 実 PG の場所は環境で違う (CI は TCP、手元の検証環境は unix socket)。
# 決め打ちすると CI で「Postgres not available」= 全 skip になり、
# **配線が切れているのに緑**という一番危ない状態になる (Gate #14 の skip ガード)。
PG_URL = (
    os.environ.get("ATELIER_TEST_PG_URL")
    or os.environ.get("ATELIER_DB_URL")
    or "postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322"
)
os.environ.setdefault("ATELIER_DB_URL", PG_URL)

from src.db.session import (  # noqa: E402 - env を先に立ててから読む
    DatabaseSettings,
    create_engine,
    create_session_factory,
)
from src.services import consents as svc  # noqa: E402


def _db_available() -> bool:
    try:
        eng = sqlalchemy.create_engine(PG_URL.replace("+asyncpg", "+psycopg"), poolclass=NullPool)
        try:
            with eng.connect() as c:
                c.execute(text("select 1"))
        finally:
            eng.dispose()
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(not _db_available(), reason="local Postgres not available")

Factory = async_sessionmaker[AsyncSession]


@asynccontextmanager
async def env() -> AsyncGenerator[tuple[Factory, str], None]:
    """テストと同じ event loop で engine を作り、使い捨てユーザーを 1 人用意する。"""
    engine = create_engine(DatabaseSettings(url=PG_URL))
    factory = create_session_factory(engine)
    user_id = str(uuid.uuid4())
    try:
        async with factory() as s:
            await s.execute(
                text("insert into auth.users (id) values (cast(:u as uuid))"), {"u": user_id}
            )
            await s.execute(
                text("insert into public.users (id, email) values (cast(:u as uuid), :e)"),
                {"u": user_id, "e": f"{user_id}@example.test"},
            )
            await s.commit()
        yield factory, user_id
    finally:
        async with factory() as s:
            await s.execute(
                text("delete from public.consents where user_id = cast(:u as uuid)"), {"u": user_id}
            )
            await s.execute(
                text("delete from public.users where id = cast(:u as uuid)"), {"u": user_id}
            )
            await s.execute(
                text("delete from auth.users where id = cast(:u as uuid)"), {"u": user_id}
            )
            await s.commit()
        await engine.dispose()


async def _current_version(session: AsyncSession, doc_type: str) -> str:
    row = (
        await session.execute(
            text(
                "select version from public.legal_documents"
                " where doc_type = :d and locale = 'ja' and is_current"
            ),
            {"d": doc_type},
        )
    ).one()
    return str(row.version)


async def _accept(session: AsyncSession, user_id: str, doc_type: str, version: str) -> None:
    """旧版に同意した状態を作る (signup 相当)。"""
    await session.execute(
        text(
            "insert into public.consents (user_id, type, version, accepted)"
            " values (cast(:u as uuid), cast(:t as consent_type_enum), :v, true)"
        ),
        {"u": user_id, "t": doc_type, "v": version},
    )
    await session.commit()


class TestDetection:
    @pytest.mark.anyio
    async def test_never_consented_needs_consent(self) -> None:
        """一度も同意していない人は「要る」と出る。"""
        async with env() as (factory, user_id), factory() as s:
            rows = await svc.consent_status(s, user_id=user_id)
        assert rows, "対象の法令ページが 1 つも無い"
        assert all(r.needs_consent for r in rows)
        assert all(r.accepted_version is None for r in rows)

    @pytest.mark.anyio
    async def test_old_version_needs_consent(self) -> None:
        """**旧版に同意したまま**の人を検出できる（これが無かった）。"""
        async with env() as (factory, user_id), factory() as s:
            await _accept(s, user_id, "terms_of_service", "2026-05-25")
            rows = {r.doc_type: r for r in await svc.consent_status(s, user_id=user_id)}
        terms = rows["terms_of_service"]
        assert terms.accepted_version == "2026-05-25"
        assert terms.current_version != "2026-05-25"
        assert terms.needs_consent is True

    @pytest.mark.anyio
    async def test_current_version_does_not_need_consent(self) -> None:
        async with env() as (factory, user_id), factory() as s:
            current = await _current_version(s, "terms_of_service")
            await _accept(s, user_id, "terms_of_service", current)
            rows = {r.doc_type: r for r in await svc.consent_status(s, user_id=user_id)}
        assert rows["terms_of_service"].needs_consent is False

    @pytest.mark.anyio
    async def test_pending_lists_only_what_is_missing(self) -> None:
        async with env() as (factory, user_id), factory() as s:
            current = await _current_version(s, "terms_of_service")
            await _accept(s, user_id, "terms_of_service", current)
            pending = await svc.pending_consents(s, user_id=user_id)
        assert {p.doc_type for p in pending} == {"privacy_policy"}

    @pytest.mark.anyio
    async def test_refusal_is_not_consent(self) -> None:
        """`accepted = false`（拒否）は「同意した」に数えない。"""
        async with env() as (factory, user_id), factory() as s:
            current = await _current_version(s, "terms_of_service")
            await s.execute(
                text(
                    "insert into public.consents (user_id, type, version, accepted)"
                    " values (cast(:u as uuid), 'terms_of_service', :v, false)"
                ),
                {"u": user_id, "v": current},
            )
            await s.commit()
            rows = {r.doc_type: r for r in await svc.consent_status(s, user_id=user_id)}
        assert rows["terms_of_service"].needs_consent is True


class TestAccept:
    @pytest.mark.anyio
    async def test_accepting_adds_a_row_and_keeps_the_old_one(self) -> None:
        """**旧版の記録を消さない**（いつ何に同意したかを残す）。"""
        async with env() as (factory, user_id), factory() as s:
            await _accept(s, user_id, "terms_of_service", "2026-05-25")
            current = await _current_version(s, "terms_of_service")
            await svc.accept_current(
                s, user_id=user_id, doc_type="terms_of_service", version=current
            )
            await s.commit()
            versions = [
                str(r.version)
                for r in (
                    await s.execute(
                        text(
                            "select version from public.consents"
                            " where user_id = cast(:u as uuid) and type = 'terms_of_service'"
                            " order by accepted_at"
                        ),
                        {"u": user_id},
                    )
                ).all()
            ]
            rows = {r.doc_type: r for r in await svc.consent_status(s, user_id=user_id)}
        assert versions == ["2026-05-25", current], "旧版の記録が消えている"
        assert rows["terms_of_service"].needs_consent is False

    @pytest.mark.anyio
    async def test_stale_version_is_rejected(self) -> None:
        """**画面が古い版を見ていたら拒否**（読んでいない文面に同意させない）。"""
        async with env() as (factory, user_id), factory() as s:
            with pytest.raises(svc.ConsentError) as exc:
                await svc.accept_current(
                    s, user_id=user_id, doc_type="terms_of_service", version="2026-05-25"
                )
        assert exc.value.code == "version_mismatch"
        assert "読み直して" in exc.value.message

    @pytest.mark.anyio
    async def test_unsupported_type_is_rejected(self) -> None:
        async with env() as (factory, user_id), factory() as s:
            with pytest.raises(svc.ConsentError) as exc:
                await svc.accept_current(
                    s, user_id=user_id, doc_type="tokushoho", version="2026-05-25"
                )
        assert exc.value.code == "unsupported_type"

    @pytest.mark.anyio
    async def test_ip_and_user_agent_are_recorded(self) -> None:
        """いつ・どこから同意したかを残す（後から争うときの証跡）。"""
        async with env() as (factory, user_id), factory() as s:
            current = await _current_version(s, "privacy_policy")
            await svc.accept_current(
                s,
                user_id=user_id,
                doc_type="privacy_policy",
                version=current,
                ip_address="203.0.113.9",
                user_agent="TestAgent/1.0",
            )
            await s.commit()
            row = (
                await s.execute(
                    text(
                        "select host(ip_address) as ip, user_agent from public.consents"
                        " where user_id = cast(:u as uuid) and type = 'privacy_policy'"
                    ),
                    {"u": user_id},
                )
            ).one()
        assert row.ip == "203.0.113.9"
        assert row.user_agent == "TestAgent/1.0"


class TestNoForcedBlock:
    def test_service_does_not_block_usage(self) -> None:
        """**同意するまで使わせない、という強制は入れていない**。

        それは法務レビューの結果と経営判断で決めることで、実装が先走って
        よいものではない。ここで作ったのは「求められる状態」であって
        「強制」ではない — その線引きをテストでも固定しておく。
        """
        import pathlib

        src = (
            pathlib.Path(__file__).resolve().parents[1] / "src" / "services" / "consents"
        ) / "__init__.py"
        body = src.read_text(encoding="utf-8")
        for forbidden in ("403", "raise_for_consent", "block_until_consent"):
            assert forbidden not in body, f"強制の実装が入っている: {forbidden}"
