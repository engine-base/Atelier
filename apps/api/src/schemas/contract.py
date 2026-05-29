"""API 契約凍結スキーマ (T-A-45 / API 契約凍結)。

T-A-45 は Wave 2 終了の集大成: openapi.yaml を凍結し、screen-API coverage
100% を強制する verification endpoint。admin が freeze をトリガすると
audit_logs.action='contract.freeze' を記録する。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class ScreenCoverageEntry(BaseModel):
    """単一画面のカバレッジ。

    screen_id: 04_functional_breakdown/screens.json の id (例: S-A01)
    endpoint_count: 当該 screen を x-screen-ids に含む endpoint 数
    endpoints: 該当 endpoint (method + path)
    """

    screen_id: str
    endpoint_count: int
    endpoints: list[str]


class ScreenCoverageReport(BaseModel):
    """全 screen カバレッジ集計。

    coverage_pct = covered_screens / total_screens * 100。
    100% でなければ未カバー screen を uncovered に列挙。
    """

    total_screens: int
    covered_screens: int
    uncovered_screens: list[str]
    coverage_pct: float
    entries: list[ScreenCoverageEntry]
    evaluated_at: datetime


class FreezeRequest(BaseModel):
    """API 契約凍結リクエスト。

    note: 凍結時のメモ (release タグ等)。audit_logs.after に格納する。
    """

    note: str | None = None


class FreezeStatus(BaseModel):
    """API 契約凍結状態。

    frozen: 直近 contract.freeze 以降 contract.unfreeze が無い場合 True。
    frozen_at: 最後の凍結時刻。
    frozen_by_user_id: 凍結を行った admin の user id。
    total_paths: openapi.yaml 上の path 数。
    total_methods: 同 operation (method+path) 数。
    """

    frozen: bool
    frozen_at: datetime | None
    frozen_by_user_id: str | None
    last_note: str | None
    total_paths: int
    total_methods: int
    evaluated_at: datetime
