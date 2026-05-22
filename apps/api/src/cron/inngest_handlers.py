# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportArgumentType=false, reportUnknownParameterType=false, reportMissingTypeArgument=false
"""Inngest cron handler — 各 cron schedule に対応する関数。

Phase 0 では skeleton (logger 出力のみ) で型と契約を確立する。
実体 (日次ダイジェスト生成 / バーンダウン PDF 化 / 通知送信) は別 task で実装する。

NOTE: file-level pyright directive で Inngest SDK 由来の Unknown 型を許容。
"""

from __future__ import annotations

import logging
from typing import Any

import inngest

from .scheduler import CronSchedule

logger = logging.getLogger(__name__)


async def _daily_digest_body(ctx: Any, step: Any) -> dict[str, str]:
    """日次ダイジェスト生成本体 (skeleton)。

    実装方針 (別 task):
      1. step.run('fetch') で対象 user / project を取得
      2. step.run('summarize') で LangGraph workflow を起動
      3. step.run('notify') で Resend 経由でメール送付
    """
    del ctx, step  # 引数未使用 (skeleton)
    logger.info("daily-digest cron triggered (skeleton)")
    return {"status": "ok", "name": "daily-digest"}


async def _weekly_burndown_body(ctx: Any, step: Any) -> dict[str, str]:
    """週次バーンダウン本体 (skeleton)。

    実装方針 (別 task):
      1. step.run('aggregate') で Sprint 完了タスク数集計
      2. step.run('render') で SVG/PDF 生成
      3. step.run('notify') でクライアント slack/email へ
    """
    del ctx, step
    logger.info("weekly-burndown cron triggered (skeleton)")
    return {"status": "ok", "name": "weekly-burndown"}


_HANDLER_MAP: dict[str, Any] = {
    "daily-digest": _daily_digest_body,
    "weekly-burndown": _weekly_burndown_body,
}


def build_cron_function(
    client: inngest.Inngest,
    schedule: CronSchedule,
) -> inngest.Function:
    """schedule.name に対応する handler を Inngest function として登録する。"""
    handler = _HANDLER_MAP.get(schedule.name)
    if handler is None:
        raise ValueError(f"unknown cron name: {schedule.name}")

    @client.create_function(
        fn_id=schedule.name,
        trigger=inngest.TriggerCron(cron=schedule.cron),
    )
    async def _fn(ctx: Any, step: Any) -> dict[str, str]:
        return await handler(ctx, step)

    return _fn


__all__ = ["build_cron_function"]
