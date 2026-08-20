# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false, reportArgumentType=false, reportUnknownParameterType=false, reportMissingTypeArgument=false
"""Inngest cron handler — 各 cron schedule に対応する関数。

GAP-179 で全 handler が実体を持つ状態になった (skeleton は残っていない)。

NOTE: file-level pyright directive で Inngest SDK 由来の Unknown 型を許容。
"""

from __future__ import annotations

import logging
import os
from typing import Any

import inngest

from .scheduler import CronSchedule

logger = logging.getLogger(__name__)


async def _user_schedules_body(ctx: Any, step: Any) -> dict[str, str]:
    """利用者スケジュール発火 (GAP-179 実体)。

    利用者が画面で作った cron_schedules のうち next_run_at を過ぎたものを実行し、
    次回時刻を再計算する。実行できない (PC 未接続) ものは deferred として記録し、
    短い間隔で再試行する。
    """
    del ctx, step
    from src.db import shared_session_factory
    from src.services.cron.dispatcher import run_due_schedules

    factory = shared_session_factory()
    async with factory() as session:
        result = await run_due_schedules(session)
    if result["due"] or result["scheduled"]:
        logger.info("user-schedules cron done: %s", result)
    return {
        "status": "ok",
        "name": "user-schedules",
        "due": str(result["due"]),
        "ran": str(result["ran"]),
        "deferred": str(result["deferred"]),
        "failed": str(result["failed"]),
    }


async def _transcribe_queue_body(ctx: Any, step: Any) -> dict[str, str]:
    """議事録 transcription キュー消費 (GAP-016 解消の実体)。

    services/meetings/worker.run_once を呼び、queued 行を Whisper で処理する。
    """
    del ctx, step
    from src.db import shared_session_factory
    from src.services.meetings.worker import run_once

    factory = shared_session_factory()
    async with factory() as session:
        result = await run_once(session)
    if result["queued"]:
        logger.info("transcribe-queue cron done: %s", result)
    return {
        "status": "ok",
        "name": "transcribe-queue",
        "queued": str(result["queued"]),
        "processed": str(result["processed"]),
        "failed": str(result["failed"]),
    }


async def _error_alerts_body(ctx: Any, step: Any) -> dict[str, str]:
    """エラー通知 (GAP-194 — GAP-182 の記録が誰にも届かなかった問題の解消)。

    冷却つきで「新種のエラー」「増え続けているエラー」を運営へ送る。送信先が
    未設定なら送ったふりをせず skipped として記録する。
    """
    del ctx, step
    from src.db import shared_session_factory
    from src.observability.alerts import run_error_alerts

    factory = shared_session_factory()
    async with factory() as session:
        result = await run_error_alerts(session)
    if result.get("candidates", "0") != "0":
        logger.info("error-alerts cron done: %s", result)
    return result


async def _purge_deleted_accounts_body(ctx: Any, step: Any) -> dict[str, str]:
    """退会データ 30 日後完全削除 (GAP-014 — T-A-05 の worker 実体)。"""
    del ctx, step
    from src.db import shared_session_factory
    from src.services.platform_jobs import purge_deleted_accounts

    factory = shared_session_factory()
    async with factory() as session:
        result = await purge_deleted_accounts(session)
        await session.commit()
    if result["purged_users"] != "0":
        logger.info("purge-deleted-accounts cron done: %s", result)
    return result


async def _integrity_check_body(ctx: Any, step: Any) -> dict[str, str]:
    """データ整合性チェック (GAP-014)。検知時は approval_inbox へ通知。"""
    del ctx, step
    from src.db import shared_session_factory
    from src.services.platform_jobs import run_integrity_check

    factory = shared_session_factory()
    async with factory() as session:
        result = await run_integrity_check(session)
        await session.commit()
    logger.info("integrity-check cron done: %s", result)
    return result


_HANDLER_MAP: dict[str, Any] = {
    "user-schedules": _user_schedules_body,
    "error-alerts": _error_alerts_body,
    "transcribe-queue": _transcribe_queue_body,
    "purge-deleted-accounts": _purge_deleted_accounts_body,
    "integrity-check": _integrity_check_body,
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
        # GAP-013: 実行履歴 (cron_run_history) を running→success/error で記録。
        from src.services.cron.history import record_run

        return await record_run(schedule.name, lambda: handler(ctx, getattr(ctx, "step", None)))

    return _fn


__all__ = ["build_cron_function"]
