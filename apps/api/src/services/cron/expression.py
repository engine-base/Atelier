"""GAP-179: 利用者が入力した cron 式を実際の発火時刻へ変換する。

**これまでの実態**: `cron_schedules.cron_expression` は保存されるだけで、次回
実行時刻を計算するコードが存在しなかった。画面の「次回」は常に空欄で、実際の
発火はプラットフォーム固定 cron (毎日 22:00 UTC 等) に依存していた。つまり
利用者が画面で指定した時刻は**一度も使われていなかった**。本モジュールがその
欠落を埋める。

仕様:
- 5 フィールド (分 時 日 月 曜日)。`*` / `*/n` / `a-b` / `a-b/n` / `a,b,c` に対応。
- 曜日は 0=日曜。7 も日曜として受ける。
- 日 (DOM) と曜日 (DOW) の両方が制限されている場合は **どちらか一致で発火**
  (Vixie cron 互換)。片方が `*` の場合はもう片方だけで判定する。
- 利用者の入力は **日本時間 (Asia/Tokyo)** として解釈し、返す値は UTC。
  画面に「毎朝 9 時」と書いた人が JST 9 時に発火することを保証する。

外部依存は入れない (croniter 非採用): 発火判定はプロダクトの中核挙動であり、
テストで挙動を固定したいため自前実装にしている。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

#: 利用者の cron 式を解釈するタイムゾーン (画面表記も JST)。
USER_TZ = ZoneInfo("Asia/Tokyo")
UTC = ZoneInfo("UTC")

#: 探索の上限。これを超えて一致しない式 (例: 2/30) は不正として扱う。
_MAX_SEARCH_DAYS = 366 * 4

_FIELD_RANGES: tuple[tuple[str, int, int], ...] = (
    ("分", 0, 59),
    ("時", 0, 23),
    ("日", 1, 31),
    ("月", 1, 12),
    ("曜日", 0, 7),
)


class CronExpressionError(ValueError):
    """cron 式が解釈できない。利用者に見せる日本語メッセージを持つ。"""


@dataclass(frozen=True)
class ParsedCron:
    """解釈済み cron 式。各フィールドは「一致する値の集合」。"""

    minutes: frozenset[int]
    hours: frozenset[int]
    days_of_month: frozenset[int]
    months: frozenset[int]
    days_of_week: frozenset[int]
    dom_restricted: bool
    dow_restricted: bool

    def matches_date(self, value: datetime) -> bool:
        """日付部 (月/日/曜日) が一致するか。"""
        if value.month not in self.months:
            return False
        # Python: Monday=0..Sunday=6 → cron: Sunday=0..Saturday=6
        dow = (value.weekday() + 1) % 7
        dom_ok = value.day in self.days_of_month
        dow_ok = dow in self.days_of_week
        if self.dom_restricted and self.dow_restricted:
            return dom_ok or dow_ok
        return dom_ok and dow_ok


def _parse_field(raw: str, *, label: str, low: int, high: int) -> frozenset[int]:
    values: set[int] = set()
    for part in raw.split(","):
        token = part.strip()
        if not token:
            raise CronExpressionError(f"{label}の指定が空です: '{raw}'")
        step = 1
        if "/" in token:
            token, _, step_raw = token.partition("/")
            if not step_raw.isdigit() or int(step_raw) < 1:
                raise CronExpressionError(f"{label}の間隔指定が不正です: '{part.strip()}'")
            step = int(step_raw)
            token = token.strip() or "*"
        if token == "*":
            start, end = low, high
        elif "-" in token.lstrip("-"):
            start_raw, _, end_raw = token.partition("-")
            start, end = _to_int(start_raw, label=label), _to_int(end_raw, label=label)
        else:
            start = end = _to_int(token, label=label)
        if start > end:
            raise CronExpressionError(f"{label}の範囲が逆転しています: '{part.strip()}'")
        if start < low or end > high:
            raise CronExpressionError(
                f"{label}は {low}〜{high} で指定してください: '{part.strip()}'"
            )
        values.update(range(start, end + 1, step))
    if not values:
        raise CronExpressionError(f"{label}に一致する値がありません: '{raw}'")
    return frozenset(values)


def _to_int(raw: str, *, label: str) -> int:
    token = raw.strip()
    if not token.isdigit():
        raise CronExpressionError(f"{label}に数字以外が入っています: '{token}'")
    return int(token)


def parse_cron(expression: str) -> ParsedCron:
    """5 フィールドの cron 式を解釈する。不正なら CronExpressionError。"""
    fields = expression.split()
    if len(fields) != 5:
        raise CronExpressionError(
            f"cron 式は「分 時 日 月 曜日」の 5 項目で指定してください (受け取り: '{expression}')"
        )
    parsed: list[frozenset[int]] = []
    for raw, (label, low, high) in zip(fields, _FIELD_RANGES, strict=True):
        parsed.append(_parse_field(raw, label=label, low=low, high=high))
    minutes, hours, dom, months, dow_raw = parsed
    # 7 は日曜 (0) の別名
    dow = frozenset({0 if v == 7 else v for v in dow_raw})
    return ParsedCron(
        minutes=minutes,
        hours=hours,
        days_of_month=dom,
        months=months,
        days_of_week=dow,
        dom_restricted=fields[2].strip() != "*",
        dow_restricted=fields[4].strip() != "*",
    )


def next_occurrence(
    expression: str,
    *,
    after: datetime,
    tz: ZoneInfo = USER_TZ,
) -> datetime:
    """`after` より後で最初に発火する時刻を UTC で返す。

    `after` が naive なら UTC とみなす (DB から来る値は UTC aware が前提)。
    """
    parsed = parse_cron(expression)
    base = after if after.tzinfo is not None else after.replace(tzinfo=UTC)
    local = base.astimezone(tz)
    # 「after より後」= 分未満を切り捨てて 1 分進める
    cursor = local.replace(second=0, microsecond=0) + timedelta(minutes=1)

    day = cursor.date()
    for offset in range(_MAX_SEARCH_DAYS):
        current = day + timedelta(days=offset)
        probe = datetime.combine(current, time(0, 0), tzinfo=tz)
        if not parsed.matches_date(probe):
            continue
        lower_bound = cursor if offset == 0 else datetime.combine(current, time(0, 0), tzinfo=tz)
        for hour in sorted(parsed.hours):
            for minute in sorted(parsed.minutes):
                candidate = datetime.combine(current, time(hour, minute), tzinfo=tz)
                if candidate >= lower_bound:
                    return candidate.astimezone(UTC)
    raise CronExpressionError(f"この cron 式は今後 4 年間発火しません: '{expression}'")


def describe_ja(expression: str) -> str:
    """cron 式を日本語ラベルにする (画面と API で同じ文言を使うため)。

    定型パターンのみ日本語化し、それ以外は式をそのまま返す (嘘をつかない)。
    """
    try:
        fields = expression.split()
        parse_cron(expression)
    except CronExpressionError:
        return expression
    minute, hour, dom, month, dow = fields
    if month != "*" or dom != "*":
        return expression
    if not minute.isdigit():
        return expression
    if hour == "*":
        return f"毎時 {int(minute)} 分"
    if not hour.isdigit():
        return expression
    clock = f"{int(hour):02d}:{int(minute):02d}"
    if dow == "*":
        return f"毎日 {clock}"
    names = {"0": "日", "1": "月", "2": "火", "3": "水", "4": "木", "5": "金", "6": "土", "7": "日"}
    if dow in names:
        return f"毎週{names[dow]}曜 {clock}"
    if dow == "1-5":
        return f"平日 {clock}"
    return expression


__all__ = [
    "USER_TZ",
    "CronExpressionError",
    "ParsedCron",
    "describe_ja",
    "next_occurrence",
    "parse_cron",
]
