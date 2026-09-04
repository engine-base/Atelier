"""GAP-208: 法務文書が「条文に照らして直した内容」を保ち続けることを機械で守る。

経営者判断 (2026-08-22): 「弁護士には頼まない。AI 側で仕上げてほしい」。
**私は弁護士ではないため「法的に完璧」は保証できない**旨を伝えたうえでの判断。
だからこそ、直した論点が将来また抜け落ちるのを機械で止める価値が高い。

ここで固定する事実:
  - 免責が **全部免責でない**（消費者契約法 8 条で無効になる形に戻さない）
  - 料金・支払い・解約が書かれており、**実装の金額と一致**している
  - 越境移転（米国）が提供先・所在国つきで書かれている
  - 特商法表記に **解約方法** が書かれている
  - 旧版は消さない（同意記録との突き合わせが壊れる）
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
                "select body_md from public.legal_documents"
                " where doc_type = :d and locale = 'ja' and is_current"
            ),
            {"d": doc_type},
        )
    ).first()
    assert row is not None, f"{doc_type} の現行版が無い"
    return str(row.body_md)


class TestLiabilityClause:
    """旧 第7条は軽過失を **全部免責** していた（無効になれば免責が丸ごと消える）。"""

    async def test_liability_is_capped_not_fully_excluded(self, session: AsyncSession) -> None:
        body = await _current(session, "terms_of_service")
        # 上限を定める一部制限であること
        assert "上限" in body
        assert "12 か月" in body, "賠償上限の算定期間が書かれていない"

    async def test_gross_negligence_is_not_limited(self, session: AsyncSession) -> None:
        """故意・重過失に制限を及ぼさない（及ぼすと消費者契約法 8 条で無効）。"""
        body = await _current(session, "terms_of_service")
        assert "故意または重大な過失による場合には" in body
        assert "適用されません" in body

    async def test_old_full_exclusion_wording_is_gone(self, session: AsyncSession) -> None:
        """**戻ってきたら落とす** — 旧文言の再導入を機械で止める。"""
        body = await _current(session, "terms_of_service")
        assert "故意または重過失による場合を除き責任を負いません" not in body


class TestPriceAndCancellation:
    async def test_terms_state_the_actual_price(self, session: AsyncSession) -> None:
        """**実装の金額と一致**していること（規約だけ古くなるのを防ぐ）。"""
        from src.services.billing import PRO_PLAN_UNIT_AMOUNT

        body = await _current(session, "terms_of_service")
        assert f"{PRO_PLAN_UNIT_AMOUNT:,}" in body, "規約の金額が実装と一致していない"
        assert "消費税込" in body

    async def test_terms_state_auto_renewal(self, session: AsyncSession) -> None:
        body = await _current(session, "terms_of_service")
        assert "自動的に更新" in body

    async def test_terms_state_how_to_cancel(self, session: AsyncSession) -> None:
        body = await _current(session, "terms_of_service")
        assert "解約" in body
        assert "日割り" in body, "返金の有無が書かれていない"

    async def test_terms_state_the_deletion_grace_period(self, session: AsyncSession) -> None:
        """猶予期間が実装 (_GRACE_DAYS) と一致していること。"""
        from src.services.platform_jobs import _GRACE_DAYS  # pyright: ignore[reportPrivateUsage]

        body = await _current(session, "terms_of_service")
        assert f"{_GRACE_DAYS} 日間の猶予期間" in body

    async def test_tokushoho_states_how_to_cancel(self, session: AsyncSession) -> None:
        """特商法表記に **解約の方法** が無いのは継続課金として成立しない。"""
        body = await _current(session, "tokushoho")
        assert "解約の方法" in body
        assert "プランの管理・解約" in body, "画面のボタン名と一致していない"

    async def test_tokushoho_states_the_actual_price(self, session: AsyncSession) -> None:
        from src.services.billing import PRO_PLAN_UNIT_AMOUNT

        body = await _current(session, "tokushoho")
        assert f"{PRO_PLAN_UNIT_AMOUNT:,}" in body

    async def test_tokushoho_says_anthropic_fee_is_on_the_user(self, session: AsyncSession) -> None:
        body = await _current(session, "tokushoho")
        assert "Anthropic" in body
        assert "ご負担" in body


class TestCrossBorderTransfer:
    async def test_privacy_names_the_country_and_recipients(self, session: AsyncSession) -> None:
        """越境移転は **提供先と所在国** が要る（「送信されます」だけでは足りない）。"""
        body = await _current(session, "privacy_policy")
        assert "外国にある第三者" in body
        assert "アメリカ合衆国" in body
        for recipient in ("Anthropic PBC", "Stripe", "Fly.io", "Vercel"):
            assert recipient in body, f"提供先 {recipient} が書かれていない"

    async def test_privacy_explains_how_to_check_the_regime(self, session: AsyncSession) -> None:
        body = await _current(session, "privacy_policy")
        assert "個人情報保護委員会" in body

    async def test_privacy_states_retention(self, session: AsyncSession) -> None:
        from src.services.platform_jobs import _GRACE_DAYS  # pyright: ignore[reportPrivateUsage]

        body = await _current(session, "privacy_policy")
        assert f"{_GRACE_DAYS} 日間の猶予期間" in body

    async def test_privacy_still_says_no_training_by_default(self, session: AsyncSession) -> None:
        """**AI 学習デフォルト OFF は絶対に後退させない**（CLAUDE.md ルール6）。"""
        body = await _current(session, "privacy_policy")
        assert "既定では AI モデルの学習に使用しません" in body
        assert "オプトイン" in body


class TestNewClauses:
    async def test_minor_consent(self, session: AsyncSession) -> None:
        body = await _current(session, "terms_of_service")
        assert "未成年" in body and "法定代理人" in body

    async def test_antisocial_forces(self, session: AsyncSession) -> None:
        body = await _current(session, "terms_of_service")
        assert "反社会的勢力" in body

    async def test_governing_law_and_jurisdiction(self, session: AsyncSession) -> None:
        body = await _current(session, "terms_of_service")
        assert "日本法" in body
        assert "専属的合意管轄" in body


class TestHistoryIsKept:
    async def test_all_previous_versions_remain(self, session: AsyncSession) -> None:
        """旧版を消さない（consents.version との突き合わせが壊れる）。"""
        rows = (
            await session.execute(
                text(
                    "select doc_type, count(*) as n from public.legal_documents"
                    " where locale = 'ja' group by doc_type"
                )
            )
        ).all()
        counts = {str(r.doc_type): int(r.n) for r in rows}
        # 「n 件以上」だと、その環境にたまたま残っている古い行の数に依存する。
        # 見たいのは **migration が入れた版が 1 つも消えていないこと** なので、
        # 版そのもので照合する (GAP-188 → GAP-204 → GAP-208 の 3 世代)。
        versions = {
            (str(r.doc_type), str(r.version))
            for r in (
                await session.execute(
                    text(
                        "select doc_type, version from public.legal_documents"
                        " where locale = 'ja'"
                    )
                )
            ).all()
        }
        must_remain = {
            ("terms_of_service", "2026-08-20"),  # GAP-188 (自分の Claude 契約)
            ("terms_of_service", "2026-08-21"),  # GAP-204 (知的財産)
            ("terms_of_service", "2026-08-22"),  # GAP-208 (全面是正)
            ("privacy_policy", "2026-08-20"),
            ("privacy_policy", "2026-08-22"),
        }
        missing = sorted(must_remain - versions)
        assert missing == [], f"旧版が消えている: {missing}"
        assert counts.get("terms_of_service", 0) >= 3, "利用規約の旧版が消えている"
        assert counts.get("privacy_policy", 0) >= 2, "プライバシーポリシーの旧版が消えている"

    async def test_exactly_one_current_per_type(self, session: AsyncSession) -> None:
        rows = (
            await session.execute(
                text(
                    "select doc_type, count(*) as n from public.legal_documents"
                    " where locale = 'ja' and is_current group by doc_type"
                )
            )
        ).all()
        for r in rows:
            assert int(r.n) == 1, f"{r.doc_type} の current が {r.n} 行ある"
