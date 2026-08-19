"""GAP-179: 週次バーンダウンの実体。

**これまでの実態**: `_weekly_burndown_body` は `logger.info("...(skeleton)")` を
出して `{"status": "ok"}` を返すだけだった。画面には「週次バーンダウンを集計
します」と書いてあるのに、集計は一度も行われていなかった。

設計は日次ダイジェスト (T-A-53) と同じ方針:
- 集計は決定論 (DB-as-truth)。LLM を使わないので**費用ゼロ・PC 接続も不要**。
- 出力先は project の「週次バーンダウン」thread への assistant message。
- 同一週に 2 回投稿しない (冪等)。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter

from .output import (
    find_or_create_thread,
    has_assistant_message_within_hours,
    post_assistant_message,
)

logger = logging.getLogger(__name__)

BURNDOWN_THREAD_TITLE = "週次バーンダウン"

#: 週次の冪等ガード。6 日以内に投稿済みならスキップする。
_DEDUPE_HOURS = 24 * 6


async def build_project_burndown(session: AsyncSession, *, project_id: str) -> str:
    """project の週次バーンダウン markdown を決定論で組み立てる。"""
    proj = (
        await session.execute(
            text("select name from public.projects where id = cast(:p as uuid)"),
            {"p": project_id},
        )
    ).first()
    name = str(proj.name) if proj else project_id

    stage_rows = (
        await session.execute(
            text(
                "select lifecycle_stage, count(*) as n from public.tasks "
                "where project_id = cast(:p as uuid) and deleted_at is null "
                "group by lifecycle_stage"
            ),
            {"p": project_id},
        )
    ).all()
    counts = {str(r.lifecycle_stage): int(r.n) for r in stage_rows}
    total = sum(counts.values())
    done = counts.get("done", 0)
    remaining = total - done

    daily_rows = (
        await session.execute(
            text(
                "select (te.completed_at at time zone 'Asia/Tokyo')::date as d, "
                "count(*) as n from public.task_executions te "
                "join public.tasks t on t.id = te.task_id "
                "where t.project_id = cast(:p as uuid) and te.status = 'succeeded' "
                "and te.completed_at >= now() - interval '7 days' "
                "group by 1 order by 1"
            ),
            {"p": project_id},
        )
    ).all()
    completed_this_week = sum(int(r.n) for r in daily_rows)

    lines: list[str] = [f"# 週次バーンダウン — {name}", ""]
    lines.append("## 残り")
    if total == 0:
        lines.append("- タスクなし")
    else:
        pct = round(done * 100 / total)
        lines.append(f"- 完了 {done} / 全 {total} 件 ({pct}%)")
        lines.append(f"- 残り {remaining} 件")
        for stage in ("triage", "ready", "in_progress", "blocked", "awaiting"):
            if counts.get(stage):
                lines.append(f"  - {stage}: {counts[stage]} 件")
    lines.append("")
    lines.append("## 直近 7 日の消化 (実行成功ベース)")
    if daily_rows:
        lines.extend(f"- {r.d}: {r.n} 件" for r in daily_rows)
        lines.append(f"- 合計: {completed_this_week} 件")
    else:
        lines.append("- 消化なし")
    lines.append("")
    lines.append("## 完了見込み")
    if remaining <= 0:
        lines.append("- 残タスクなし")
    elif completed_this_week <= 0:
        lines.append("- 直近 7 日の消化が 0 件のため、このデータからは見込みを出せません")
    else:
        weeks = remaining / completed_this_week
        lines.append(
            f"- 直近 7 日と同じペース ({completed_this_week} 件/週) が続けば "
            f"およそ {weeks:.1f} 週間"
        )
    return "\n".join(lines)


async def run_project_burndown(session: AsyncSession, *, project_id: str) -> dict[str, Any]:
    """1 project 分の週次バーンダウンを生成して投稿する。

    Returns: {"generated": 0|1, "reason": ...}。例外は投げない (無人実行のため)。
    """
    thread_id = await find_or_create_thread(
        session, project_id=project_id, title=BURNDOWN_THREAD_TITLE
    )
    if thread_id is None:
        return {"generated": 0, "reason": "no_ai_employee"}
    if await has_assistant_message_within_hours(session, thread_id=thread_id, hours=_DEDUPE_HOURS):
        return {"generated": 0, "reason": "already_posted_this_week"}
    body = await build_project_burndown(session, project_id=project_id)
    msg_id = await post_assistant_message(session, thread_id=thread_id, body=body)
    await AuditWriter(session).write(
        AuditEvent(
            action="cron.weekly_burndown.generate",
            target_type="chat_message",
            actor_type="system",
            actor_id="system",
            target_id=msg_id,
            after={"project_id": project_id},
        )
    )
    return {"generated": 1, "reason": None}


__all__ = [
    "BURNDOWN_THREAD_TITLE",
    "build_project_burndown",
    "run_project_burndown",
]
