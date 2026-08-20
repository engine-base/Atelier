"""GAP-188: 利用規約に「各自の Claude 契約が必要」が書かれていることの回帰テスト。

経営者質問「ちゃんと法的にも合法だよね？」への対応。

実態 (GAP-175/134 で確定したアーキテクチャ):
    AI 実行は利用者自身の PC 上で、利用者自身が Anthropic 社と契約する Claude で
    走る。当社は AI の推論そのものを提供していない。

ところが規約にはその記載が一切無く、**実装と規約が乖離していた**。
このテストは、規約の現行版がその実態を書いていることを機械で守る
(将来また規約だけ古いまま実装が進む、を防ぐ)。
"""

from __future__ import annotations

import os

import pytest
import sqlalchemy
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

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


pytestmark = pytest.mark.skipif(not _db_available(), reason="local Postgres not available")


@pytest.fixture
async def session():
    engine = create_async_engine(PG_ASYNC, poolclass=NullPool)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    async with factory() as s:
        yield s
    await engine.dispose()


async def _current(session: AsyncSession, doc_type: str) -> str:
    row = (
        await session.execute(
            text(
                "select body_md from public.legal_documents "
                "where doc_type = :d and locale = 'ja' and is_current"
            ),
            {"d": doc_type},
        )
    ).first()
    assert row is not None, f"{doc_type} の現行版が無い"
    return str(row.body_md)


class TestTermsMatchTheArchitecture:
    async def test_terms_require_the_users_own_claude_contract(self, session: AsyncSession) -> None:
        """「利用者自身が Claude を契約している必要がある」が書かれている。"""
        body = await _current(session, "terms_of_service")
        assert "Anthropic" in body
        assert "Claude" in body
        assert "契約" in body
        assert "ユーザー自身のコンピュータ上" in body

    async def test_terms_say_anthropic_fees_are_the_users(self, session: AsyncSession) -> None:
        """Anthropic 社への料金は利用者負担、と明記されている。"""
        body = await _current(session, "terms_of_service")
        assert "ユーザーの負担" in body
        assert "当社の利用料金には含まれません" in body

    async def test_terms_say_we_do_not_resell_claude(self, session: AsyncSession) -> None:
        """代理・再販・仲介をしていないことを明記する（実態と一致させる）。"""
        body = await _current(session, "terms_of_service")
        assert "代理・再販・仲介しません" in body

    async def test_terms_say_the_user_must_follow_anthropic_terms(
        self, session: AsyncSession
    ) -> None:
        body = await _current(session, "terms_of_service")
        assert "Anthropic 社の利用規約" in body

    async def test_terms_disclose_when_ai_becomes_unavailable(self, session: AsyncSession) -> None:
        """枠上限・Bridge 未起動・PC 停止で使えなくなることを隠さない。"""
        body = await _current(session, "terms_of_service")
        assert "利用枠" in body
        assert "Bridge" in body
        assert "一時的に利用できません" in body

    async def test_privacy_policy_discloses_the_transfer_to_anthropic(
        self, session: AsyncSession
    ) -> None:
        """入力内容が利用者の PC 経由で Anthropic 社へ送られることを書く。"""
        body = await _current(session, "privacy_policy")
        assert "Anthropic" in body
        assert "送信" in body

    async def test_privacy_policy_still_says_no_training_by_default(
        self, session: AsyncSession
    ) -> None:
        """AI 学習デフォルト OFF は維持されている（後退させない）。"""
        body = await _current(session, "privacy_policy")
        assert "学習に使用しません" in body
        assert "オプトイン" in body


class TestOldVersionsAreKept:
    async def test_previous_versions_remain_for_consent_matching(
        self, session: AsyncSession
    ) -> None:
        """旧版を消さない — 旧版に同意した記録を壊さない。"""
        rows = (
            await session.execute(
                text(
                    "select version, is_current from public.legal_documents "
                    "where doc_type = 'terms_of_service' and locale = 'ja' order by version"
                )
            )
        ).all()
        assert len(rows) >= 2, "旧版が残っていない"
        assert sum(1 for r in rows if r.is_current) == 1, "現行版が 1 つでない"
