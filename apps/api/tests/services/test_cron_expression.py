"""GAP-179: cron 式 → 次回発火時刻の unit tests。

利用者が画面に入れた式が「日本時間で」正しく解釈されることを固定する。
"""

from __future__ import annotations

import os
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

os.environ.setdefault("ATELIER_AUTH_JWT_SECRET", "test-jwt-secret")

from src.services.cron.expression import (
    CronExpressionError,
    describe_ja,
    next_occurrence,
    parse_cron,
)

UTC = ZoneInfo("UTC")
JST = ZoneInfo("Asia/Tokyo")


def _utc(y: int, mo: int, d: int, h: int, mi: int) -> datetime:
    return datetime(y, mo, d, h, mi, tzinfo=UTC)


class TestParse:
    def test_wildcards(self) -> None:
        p = parse_cron("* * * * *")
        assert len(p.minutes) == 60
        assert len(p.hours) == 24
        assert p.dom_restricted is False
        assert p.dow_restricted is False

    def test_step_and_range_and_list(self) -> None:
        p = parse_cron("0,30 9-17/4 * * 1-5")
        assert p.minutes == frozenset({0, 30})
        assert p.hours == frozenset({9, 13, 17})
        assert p.days_of_week == frozenset({1, 2, 3, 4, 5})

    def test_sunday_seven_is_zero(self) -> None:
        assert parse_cron("0 0 * * 7").days_of_week == frozenset({0})

    @pytest.mark.parametrize(
        "expr",
        [
            "* * * *",  # フィールド不足
            "60 * * * *",  # 分の範囲外
            "* 24 * * *",  # 時の範囲外
            "* * 0 * *",  # 日は 1 始まり
            "abc * * * *",  # 数字でない
            "17-5 * * * *",  # 範囲逆転
            "*/0 * * * *",  # 間隔 0
        ],
    )
    def test_invalid_raises_japanese_error(self, expr: str) -> None:
        with pytest.raises(CronExpressionError) as exc:
            parse_cron(expr)
        assert str(exc.value)  # 日本語メッセージが入っている


class TestNextOccurrence:
    def test_daily_9am_jst_is_midnight_utc(self) -> None:
        """「毎朝 9 時」= JST 09:00 = UTC 00:00。ここがズレると全部ズレる。"""
        got = next_occurrence("0 9 * * *", after=_utc(2026, 8, 19, 3, 0))
        assert got == _utc(2026, 8, 20, 0, 0)

    def test_same_day_when_still_ahead(self) -> None:
        got = next_occurrence("0 9 * * *", after=_utc(2026, 8, 18, 23, 0))
        assert got == _utc(2026, 8, 19, 0, 0)

    def test_strictly_after_never_returns_the_same_minute(self) -> None:
        exactly = _utc(2026, 8, 19, 0, 0)
        assert next_occurrence("0 9 * * *", after=exactly) == _utc(2026, 8, 20, 0, 0)

    def test_every_minute(self) -> None:
        got = next_occurrence("* * * * *", after=_utc(2026, 8, 19, 3, 30))
        assert got == _utc(2026, 8, 19, 3, 31)

    def test_weekday_only(self) -> None:
        """平日 09:00 JST。金曜の実行後は月曜になる。"""
        friday_jst_9 = datetime(2026, 8, 21, 9, 0, tzinfo=JST)
        got = next_occurrence("0 9 * * 1-5", after=friday_jst_9.astimezone(UTC))
        assert got.astimezone(JST) == datetime(2026, 8, 24, 9, 0, tzinfo=JST)

    def test_monthly_day_of_month(self) -> None:
        got = next_occurrence("30 3 1 * *", after=_utc(2026, 8, 19, 0, 0))
        assert got.astimezone(JST) == datetime(2026, 9, 1, 3, 30, tzinfo=JST)

    def test_dom_and_dow_both_restricted_is_or(self) -> None:
        """Vixie cron 互換: 日と曜日が両方指定なら「どちらか一致」で発火。"""
        # 2026-09-01 は火曜。1 日 or 日曜 に発火する式。
        got = next_occurrence("0 0 1 * 0", after=datetime(2026, 8, 27, 0, 0, tzinfo=JST))
        assert got.astimezone(JST) == datetime(2026, 8, 30, 0, 0, tzinfo=JST)  # 直近の日曜

    def test_naive_input_is_treated_as_utc(self) -> None:
        got = next_occurrence("0 9 * * *", after=datetime(2026, 8, 19, 3, 0))
        assert got == _utc(2026, 8, 20, 0, 0)

    def test_impossible_expression_raises(self) -> None:
        with pytest.raises(CronExpressionError):
            next_occurrence("0 0 30 2 *", after=_utc(2026, 8, 19, 0, 0))


class TestDescribeJa:
    @pytest.mark.parametrize(
        ("expr", "label"),
        [
            ("0 9 * * *", "毎日 09:00"),
            ("30 22 * * *", "毎日 22:30"),
            ("0 9 * * 1", "毎週月曜 09:00"),
            ("0 9 * * 1-5", "平日 09:00"),
            ("15 * * * *", "毎時 15 分"),
        ],
    )
    def test_known_patterns(self, expr: str, label: str) -> None:
        assert describe_ja(expr) == label

    def test_unknown_pattern_returns_expression_verbatim(self) -> None:
        """日本語化できない式を無理に言い換えない (嘘をつかない)。"""
        assert describe_ja("0 9 1,15 * *") == "0 9 1,15 * *"

    def test_invalid_expression_returns_verbatim(self) -> None:
        assert describe_ja("nonsense") == "nonsense"
