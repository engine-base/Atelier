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
#
# GAP-179: 日次ダイジェスト / 週次バーンダウンの固定 cron はここから外した。
# プラットフォーム側が 22:00 UTC 等の固定時刻で先に配信してしまうと、利用者が
# 画面で指定した時刻 (cron_schedules.cron_expression) が無視される。配信は
# user-schedules (毎分) が各プロジェクトの指定時刻で行う。
CRON_SCHEDULES: tuple[CronSchedule, ...] = (
    CronSchedule(
        name="user-schedules",
        # 毎分: 利用者が画面で作った自動実行を「利用者が指定した時刻」に発火させる。
        # これが無かったため cron_expression は保存されるだけで使われていなかった (GAP-179)。
        cron="* * * * *",
        description="利用者スケジュール発火: next_run_at を過ぎた cron_schedules を実行",
    ),
    CronSchedule(
        name="transcribe-queue",
        # 毎分: queue_transcribe が積んだ議事録を Whisper で処理 (GAP-016 消費者)
        cron="* * * * *",
        description="議事録 transcription キュー消費: storage DL → Whisper → 結果書込",
    ),
    CronSchedule(
        name="purge-deleted-accounts",
        # 15:00 UTC = 00:00 JST。法令対応 (個人情報保護法) のため無効化不可 (GAP-014)
        cron="0 15 * * *",
        description="退会データ 30 日後完全削除: T-A-05 soft-delete の物理削除実体",
    ),
    CronSchedule(
        name="integrity-check",
        # 20:00 UTC = 05:00 JST。SQL のみのデータ整合性チェック (GAP-014)
        cron="0 20 * * *",
        description="データ整合性チェック: 依存/AC/モック/工程担当の矛盾検出 → 承認待ち通知",
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
