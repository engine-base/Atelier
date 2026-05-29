"""実行ログ SSE 配信 サービス層 (T-A-31)。

E-013 task_executions の status / logs_storage_path / error_summary を
polling-based に SSE 配信する。可視性は RLS (T-D-16) で tasks 経由に
scope されるため、cross-workspace は session.execute が 0 行 → "error"
event で 404 同等の意味で終端する。

実 worker stdout の tail は F-BRIDGE01 backend job が logs_storage_path
に書き込み済の前提。本層は process との直接通信は持たない。
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.schemas.exec_logs import ExecLogMeta

_SELECT_COLS = (
    "te.id, te.task_id, te.status, te.started_at, te.completed_at, "
    "te.logs_storage_path, te.error_summary, te.retry_count"
)


def _row_to_meta(row: Any) -> ExecLogMeta:
    return ExecLogMeta(
        execution_id=str(row.id),
        task_id=str(row.task_id),
        status=str(row.status),
        started_at=row.started_at,
        completed_at=row.completed_at,
        logs_storage_path=(None if row.logs_storage_path is None else str(row.logs_storage_path)),
        error_summary=(None if row.error_summary is None else str(row.error_summary)),
        retry_count=int(row.retry_count),
    )


async def get_meta(session: AsyncSession, execution_id: str) -> ExecLogMeta | None:
    res = await session.execute(
        text(
            f"select {_SELECT_COLS} from public.task_executions te "
            "join public.tasks t on t.id = te.task_id "
            "where te.id = cast(:eid as uuid) and t.deleted_at is null"
        ),
        {"eid": execution_id},
    )
    row = res.first()
    return None if row is None else _row_to_meta(row)


_TERMINAL_STATUSES = ("succeeded", "failed", "cancelled", "timeout")


def _sse_event(payload: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n".encode()


async def stream_logs(
    session: AsyncSession,
    *,
    execution_id: str,
    poll_interval_seconds: float,
    max_duration_seconds: float,
) -> AsyncIterator[bytes]:
    """task_execution の status / logs を polling 配信。

    1. 初回: snapshot event で現在の meta を送る (404 なら error → end)
    2. status が terminal でなければ poll_interval ごとに meta 再取得
       - status / completed_at / error_summary / logs_storage_path に変化が
         あれば status_change event 送出
       - terminal に到達したら end event + 終了
    3. max_duration_seconds を超えたら end event + 終了 (タイムアウト)
    """
    initial = await get_meta(session, execution_id)
    now = datetime.now(UTC)
    if initial is None:
        yield _sse_event(
            {
                "type": "error",
                "execution_id": execution_id,
                "status": None,
                "error_summary": "execution not found",
                "timestamp": now.isoformat(),
            }
        )
        return

    last_status = initial.status
    last_completed_at = initial.completed_at
    last_error = initial.error_summary
    last_logs_path = initial.logs_storage_path

    yield _sse_event(
        {
            "type": "snapshot",
            "execution_id": execution_id,
            "status": last_status,
            "completed_at": (None if last_completed_at is None else last_completed_at.isoformat()),
            "error_summary": last_error,
            "logs_storage_path": last_logs_path,
            "timestamp": now.isoformat(),
        }
    )

    if last_status in _TERMINAL_STATUSES:
        yield _sse_event(
            {
                "type": "end",
                "execution_id": execution_id,
                "status": last_status,
                "timestamp": now.isoformat(),
            }
        )
        return

    loop_started = datetime.now(UTC)
    while True:
        # max_duration をチェック
        elapsed = (datetime.now(UTC) - loop_started).total_seconds()
        if elapsed >= max_duration_seconds:
            yield _sse_event(
                {
                    "type": "end",
                    "execution_id": execution_id,
                    "status": last_status,
                    "error_summary": "max_duration reached",
                    "timestamp": datetime.now(UTC).isoformat(),
                }
            )
            return

        await asyncio.sleep(poll_interval_seconds)

        meta = await get_meta(session, execution_id)
        if meta is None:
            yield _sse_event(
                {
                    "type": "error",
                    "execution_id": execution_id,
                    "status": last_status,
                    "error_summary": "execution disappeared",
                    "timestamp": datetime.now(UTC).isoformat(),
                }
            )
            return

        changed = (
            meta.status != last_status
            or meta.completed_at != last_completed_at
            or meta.error_summary != last_error
            or meta.logs_storage_path != last_logs_path
        )
        if changed:
            yield _sse_event(
                {
                    "type": "status_change",
                    "execution_id": execution_id,
                    "status": meta.status,
                    "completed_at": (
                        None if meta.completed_at is None else meta.completed_at.isoformat()
                    ),
                    "error_summary": meta.error_summary,
                    "logs_storage_path": meta.logs_storage_path,
                    "timestamp": datetime.now(UTC).isoformat(),
                }
            )
            last_status = meta.status
            last_completed_at = meta.completed_at
            last_error = meta.error_summary
            last_logs_path = meta.logs_storage_path

        if last_status in _TERMINAL_STATUSES:
            yield _sse_event(
                {
                    "type": "end",
                    "execution_id": execution_id,
                    "status": last_status,
                    "timestamp": datetime.now(UTC).isoformat(),
                }
            )
            return
