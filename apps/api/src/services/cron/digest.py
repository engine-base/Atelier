"""T-A-53: daily_digest 実体 — cron 発火でプロジェクト日次ダイジェストを生成・保存する。

T-F-20 の skeleton handler が予告していた「実体は別 task」の本体。

設計:
- 集約は決定論 (DB-as-truth): lifecycle_stage 別タスク件数 + phase 状況 + 直近 24h 実行結果。
  LLM は使わない (cron の無人実行で fake/実キーの分岐や課金を持ち込まない v1 判断。T-A-53 AC md 参照)。
- 出力先は project の「日次ダイジェスト」chat thread (無ければ作成) への assistant message。
  スキーマ変更なしで DB 反映 + S-E01 で可視という AC を満たす。
- 同一日付 (JST) の digest が既にある project はスキップ (冪等)。
- state-changing は audit_logs へ記録 (3-tier AC: state-changing audit)。
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter

logger = logging.getLogger(__name__)

DIGEST_THREAD_TITLE = "日次ダイジェスト"


async def build_project_digest(session: AsyncSession, *, project_id: str) -> str:
    """project の当日ダイジェスト markdown を決定論で組み立てる。"""
    proj = (
        await session.execute(
            text("select name, status from public.projects where id = cast(:p as uuid)"),
            {"p": project_id},
        )
    ).first()
    name = str(proj.name) if proj else project_id

    task_rows = (
        await session.execute(
            text(
                "select lifecycle_stage, count(*) as n from public.tasks "
                "where project_id = cast(:p as uuid) and deleted_at is null "
                "group by lifecycle_stage order by lifecycle_stage"
            ),
            {"p": project_id},
        )
    ).all()
    phase_rows = (
        await session.execute(
            text(
                "select name, status from public.phases "
                'where project_id = cast(:p as uuid) order by "order"'
            ),
            {"p": project_id},
        )
    ).all()
    exec_rows = (
        await session.execute(
            text(
                "select te.status, count(*) as n from public.task_executions te "
                "join public.tasks t on t.id = te.task_id "
                "where t.project_id = cast(:p as uuid) "
                "and te.started_at >= now() - interval '24 hours' "
                "group by te.status"
            ),
            {"p": project_id},
        )
    ).all()

    lines: list[str] = [f"# 日次ダイジェスト — {name}", ""]
    lines.append("## タスク状況")
    if task_rows:
        lines.extend(f"- {r.lifecycle_stage}: {r.n} 件" for r in task_rows)
    else:
        lines.append("- タスクなし")
    lines.append("")
    lines.append("## フェーズ")
    if phase_rows:
        lines.extend(f"- {r.name}: {r.status}" for r in phase_rows)
    else:
        lines.append("- フェーズ未定義")
    lines.append("")
    lines.append("## 直近 24h の実行")
    if exec_rows:
        lines.extend(f"- {r.status}: {r.n} 件" for r in exec_rows)
    else:
        lines.append("- 実行なし")
    return "\n".join(lines)


async def _find_or_create_digest_thread(session: AsyncSession, *, project_id: str) -> str | None:
    """digest 用 thread を返す。workspace に AI 社員が 1 人もいない場合は None (skip)。"""
    row = (
        await session.execute(
            text(
                "select id from public.chat_threads "
                "where project_id = cast(:p as uuid) and title = :t and archived = false "
                "order by created_at limit 1"
            ),
            {"p": project_id, "t": DIGEST_THREAD_TITLE},
        )
    ).first()
    if row is not None:
        return str(row.id)
    # chat_threads.ai_employee_id は NOT NULL — 発信者として workspace の先頭 AI 社員を使う
    emp = (
        await session.execute(
            text(
                "select e.id from public.ai_employees e "
                "join public.projects p on p.workspace_id = e.workspace_id "
                "where p.id = cast(:p as uuid) "
                "order by e.created_at limit 1"
            ),
            {"p": project_id},
        )
    ).first()
    if emp is None:
        logger.warning("daily digest skip: no ai_employee in workspace (project=%s)", project_id)
        return None
    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.chat_threads (id, project_id, ai_employee_id, title) "
            "values (cast(:i as uuid), cast(:p as uuid), cast(:e as uuid), :t)"
        ),
        {"i": new_id, "p": project_id, "e": str(emp.id), "t": DIGEST_THREAD_TITLE},
    )
    return new_id


async def _has_digest_today(session: AsyncSession, *, thread_id: str) -> bool:
    """当日 (JST) 分の digest message が既にあるか。"""
    row = (
        await session.execute(
            text(
                "select 1 from public.chat_messages "
                "where thread_id = cast(:t as uuid) and role = 'assistant' "
                "and (created_at at time zone 'Asia/Tokyo')::date = "
                "(now() at time zone 'Asia/Tokyo')::date limit 1"
            ),
            {"t": thread_id},
        )
    ).first()
    return row is not None


async def run_daily_digest(session: AsyncSession) -> dict[str, Any]:
    """enabled な daily_digest schedule の全 project に digest を配信する。

    Returns: {"generated": n, "skipped": n} (0 件でも例外にしない — UNWANTED AC)。
    """
    schedules = (
        await session.execute(
            text(
                "select id, project_id from public.cron_schedules "
                "where enabled = true and target_action = 'daily_digest'"
            )
        )
    ).all()
    generated = 0
    skipped = 0
    for sched in schedules:
        project_id = str(sched.project_id)
        thread_id = await _find_or_create_digest_thread(session, project_id=project_id)
        if thread_id is None:
            skipped += 1
            continue
        if await _has_digest_today(session, thread_id=thread_id):
            skipped += 1
            continue
        digest_md = await build_project_digest(session, project_id=project_id)
        msg_id = str(uuid.uuid4())
        await session.execute(
            text(
                "insert into public.chat_messages (id, thread_id, role, content) "
                "values (cast(:i as uuid), cast(:t as uuid), "
                "cast('assistant' as chat_message_role_enum), :c)"
            ),
            {"i": msg_id, "t": thread_id, "c": digest_md},
        )
        await AuditWriter(session).write(
            AuditEvent(
                action="cron.daily_digest.generate",
                target_type="chat_message",
                actor_type="system",
                actor_id="system",
                target_id=msg_id,
                after={"project_id": project_id, "schedule_id": str(sched.id)},
            )
        )
        generated += 1
    await session.commit()
    logger.info("daily digest done: generated=%d skipped=%d", generated, skipped)
    return {"generated": generated, "skipped": skipped}
