# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportMissingTypeArgument=false
"""Cron スケジューラ起点 (Inngest)。

Atelier の全 cron / scheduled job を Inngest client に登録する単一エントリ。
個別 handler は inngest_handlers.py に書く。

NOTE: file-level pyright directive で Inngest SDK 由来の Unknown 型を narrow 抑制。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import inngest


@dataclass(frozen=True)
class CronSchedule:
    """1 件の cron 定義。

    name: Inngest function id (kebab-case 推奨)
    cron: 標準 cron 式 (5 fields, UTC)
    description: 何のための cron か (ログ・ダッシュボード用)
    """

    name: str
    cron: str
    description: str


# Atelier の cron schedule 定義。実 handler は inngest_handlers.py で実装。
CRON_SCHEDULES: tuple[CronSchedule, ...] = (
    CronSchedule(
        name="daily-digest",
        # 22:00 UTC = 07:00 JST 翌日
        cron="0 22 * * *",
        description="日次ダイジェスト: 当日の進捗を AI 社員ごとに集約してメール送付",
    ),
    CronSchedule(
        name="weekly-burndown",
        # 00:00 UTC 月曜 = 09:00 JST 月曜
        cron="0 0 * * 1",
        description="週次バーンダウン: Sprint 進捗をクライアントに送付",
    ),
)


def register_cron_jobs(client: inngest.Inngest) -> list[inngest.Function[Any]]:
    """全 cron function を client に登録して返す。

    起動時に 1 回だけ呼ぶ。register は冪等 (同じ id を 2 回登録しても
    Inngest 側で deduplicate される)。
    """
    from . import inngest_handlers

    functions: list[inngest.Function[Any]] = []
    for schedule in CRON_SCHEDULES:
        fn = inngest_handlers.build_cron_function(client, schedule)
        functions.append(fn)
    return functions


__all__ = ["CRON_SCHEDULES", "CronSchedule", "register_cron_jobs"]
