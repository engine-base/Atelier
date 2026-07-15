# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportArgumentType=false, reportUnknownParameterType=false, reportMissingTypeArgument=false
"""Inngest cron handler — 各 cron schedule に対応する関数。

Phase 0 では skeleton (logger 出力のみ) で型と契約を確立する。
実体 (日次ダイジェスト生成 / バーンダウン PDF 化 / 通知送信) は別 task で実装する。

NOTE: file-level pyright directive で Inngest SDK 由来の Unknown 型を許容。
"""

from __future__ import annotations

import logging
import os
from typing import Any

import inngest

from .scheduler import CronSchedule

logger = logging.getLogger(__name__)


async def _daily_digest_body(ctx: Any, step: Any) -> dict[str, str]:
    """日次ダイジェスト生成本体 (T-A-53 実体)。

    services/cron/digest.run_daily_digest を呼び、enabled な daily_digest
    schedule の全 project にダイジェストを配信する。
    """
    del ctx, step
    from src.db import create_engine, create_session_factory
    from src.services.cron.digest import run_daily_digest

    factory = create_session_factory(create_engine())
    async with factory() as session:
        result = await run_daily_digest(session)
    logger.info("daily-digest cron done: %s", result)
    return {
        "status": "ok",
        "name": "daily-digest",
        "generated": str(result["generated"]),
        "skipped": str(result["skipped"]),
    }


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
    """schedule.name に対応する handler を Inngest function として登録する。

    ATELIER_CRON_OVERRIDE (例 '* * * * *') は QA の実発火検証専用の上書き。
    本番では設定しない (既定は schedule.cron)。
    """
    handler = _HANDLER_MAP.get(schedule.name)
    if handler is None:
        raise ValueError(f"unknown cron name: {schedule.name}")
    cron_expr = os.environ.get("ATELIER_CRON_OVERRIDE") or schedule.cron

    @client.create_function(
        fn_id=schedule.name,
        trigger=inngest.TriggerCron(cron=cron_expr),
    )
    async def _fn(ctx: Any) -> dict[str, str]:
        # SDK は handler を ctx 1 引数で呼ぶ (step は ctx.step)。
        # 2 引数シグネチャは serve 実行時に TypeError 500 になる
        # (潜在バグ #22 — 2026-07-15 実発火検証で検出)。
        return await handler(ctx, getattr(ctx, "step", None))

    return _fn


__all__ = ["build_cron_function"]
