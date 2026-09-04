"""コメントを担当 AI 社員に届ける (GAP-299 / 通し J46-03・J45-09・J48-05)。

成果物・モック・タスクにコメントを書いても、**担当 AI 社員には何も届かなかった**。
正本は「担当 AI 社員に通知」を期待しているのに、通知処理も送信ログもキューも
存在せず、コメントは書いた本人しか知らない状態で止まっていた。

## 届け方 (設計の確定 — GAP-299 の「設計を決めて実装」)

**その社員のプロジェクトチャットに system メッセージを積む。** 別建ての通知箱を
新設しない。理由:

- 担当社員に次の仕事をさせる導線は「その社員とのスレッド」ただ 1 つ。別の箱に
  積むと、人が箱を見に行かない限り何も起きない (= 通知として成立しない)。
- system ロールなので、次にその社員へ話しかけたときの文脈に**そのまま乗る**
  (F-CTX01 の履歴に入る)。人が転記しなくてよい。
- 画面側の実装が要らない — 既存のスレッド一覧・未読プレビューにそのまま出る。

## 宛先の決め方 (対象ごと)

| 対象 | 宛先 |
|---|---|
| task | `tasks.assigned_employee_id`。未割当なら dev_qa 部門 → COO |
| mock | design 部門 (モックの作り手) → COO |
| workflow_output / acceptance_criteria | COO (工程のハブ) |

いずれも見つからなければ、そのワークスペースの既定社員 (is_default) → 最初の 1 人。
1 人もいなければ通知しない (0 を返す)。

RLS: コメントの投稿者はクライアント (招待) のこともあるため、宛先解決と書き込みは
**service 経路**で行う。可視性はコメント作成時に判定済み (client_can_access /
user_can_see_comment_target)。best-effort — 失敗してもコメントの保存は落とさない。
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.audit.writer import ActorType
from src.db.session import shared_session_factory

logger = logging.getLogger(__name__)

# audit_logs.action は「<対象>.<出来事>」形式 (DB の CHECK 制約)
AUDIT_ACTION = "comment.assignee_notified"
_EXCERPT_CHARS = 300

#: 対象ごとの「本文が無いときに使う宛先の部門」。task は assigned_employee_id が最優先。
_DEPARTMENT_FOR_TARGET = {
    "task": "dev_qa",
    "mock": "design",
    "workflow_output": "executive",
    "acceptance_criteria": "dev_qa",
}


def _excerpt(content: str) -> str:
    body = content.strip()
    return body if len(body) <= _EXCERPT_CHARS else body[:_EXCERPT_CHARS] + "…"


_TARGET_SQL = {
    "task": (
        "select t.project_id, t.title as label, t.assigned_employee_id "
        "from public.tasks t where t.id = cast(:tid as uuid) and t.deleted_at is null"
    ),
    "mock": (
        "select m.project_id, m.screen_name as label, null::uuid as assigned_employee_id "
        "from public.mocks m where m.id = cast(:tid as uuid) and m.deleted_at is null"
    ),
    "workflow_output": (
        "select o.project_id, coalesce(o.summary, o.stage::text) as label, "
        "       null::uuid as assigned_employee_id "
        "from public.workflow_outputs o "
        "where o.id = cast(:tid as uuid) and o.deleted_at is null"
    ),
    "acceptance_criteria": (
        "select t.project_id, t.title as label, t.assigned_employee_id "
        "from public.acceptance_criteria ac "
        "join public.tasks t on t.id = ac.task_id and t.deleted_at is null "
        "where ac.id = cast(:tid as uuid)"
    ),
}


async def notify_assignee_of_comment(
    *,
    comment_id: str,
    target_type: str,
    target_id: str,
    content: str,
    author_label: str,
    actor_id: str,
    actor_type: ActorType = "user",
) -> str | None:
    """担当 AI 社員のスレッドに system メッセージを積む。返り値 = 積んだ message id。

    宛先が決まらない / 対象が消えている場合は None (通知しない)。例外は握りつぶす
    (通知の失敗でコメントの保存を落とさない)。
    """
    sql = _TARGET_SQL.get(target_type)
    if sql is None:  # pragma: no cover - enum 外は API に届かない
        return None
    try:
        factory = shared_session_factory()
        async with factory() as session:
            row = (await session.execute(text(sql), {"tid": target_id})).first()
            if row is None:
                return None
            project_id = str(row.project_id)
            label = str(row.label or "").strip()
            employee_id = (
                str(row.assigned_employee_id) if row.assigned_employee_id is not None else None
            )
            if employee_id is None:
                employee_id = await _fallback_employee(
                    session, project_id=project_id, target_type=target_type
                )
            if employee_id is None:
                return None
            thread_id = await _ensure_thread(
                session, project_id=project_id, employee_id=employee_id
            )
            message_id = str(uuid.uuid4())
            await session.execute(
                text(
                    "insert into public.chat_messages (id, thread_id, role, content) "
                    "values (cast(:id as uuid), cast(:tid as uuid), "
                    "        cast('system' as chat_message_role_enum), :content)"
                ),
                {
                    "id": message_id,
                    "tid": thread_id,
                    "content": _notice_text(
                        target_type=target_type,
                        label=label,
                        author_label=author_label,
                        content=content,
                    ),
                },
            )
            await session.execute(
                text(
                    "update public.chat_threads set updated_at = now() where id = cast(:t as uuid)"
                ),
                {"t": thread_id},
            )
            await AuditWriter(session).write(
                AuditEvent(
                    action=AUDIT_ACTION,
                    target_type="comment",
                    actor_type=actor_type,
                    actor_id=actor_id,
                    target_id=comment_id,
                    after={
                        "project_id": project_id,
                        "ai_employee_id": employee_id,
                        "thread_id": thread_id,
                        "message_id": message_id,
                    },
                )
            )
            await session.commit()
            return message_id
    except Exception:  # pragma: no cover - best-effort
        logger.exception("assignee notify failed for comment %s", comment_id)
        return None


def _notice_text(*, target_type: str, label: str, author_label: str, content: str) -> str:
    kind = {
        "task": "タスク",
        "mock": "モック",
        "workflow_output": "成果物",
        "acceptance_criteria": "受入条件",
    }.get(target_type, "対象")
    where = f"「{label}」" if label else ""
    return (
        f"【コメントが届きました】{kind}{where} に {author_label} さんから"
        f"コメントがありました。\n\n{_excerpt(content)}\n\n"
        "次の依頼としてこの内容を扱ってください (返信は画面のコメント欄に書かれます)。"
    )


async def _fallback_employee(
    session: AsyncSession, *, project_id: str, target_type: str
) -> str | None:
    """担当が決まっていない対象の宛先を、部門 → COO → 既定 → 先頭 の順で決める。"""
    department = _DEPARTMENT_FOR_TARGET.get(target_type, "executive")
    row = (
        await session.execute(
            text(
                "select e.id from public.ai_employees e "
                "join public.projects p on p.workspace_id = e.workspace_id "
                "where p.id = cast(:pid as uuid) and e.archived = false "
                "order by (e.department = cast(:dept as ai_employee_department_enum)) desc, "
                "         (e.role = 'coo') desc, e.is_default desc, e.created_at "
                "limit 1"
            ),
            {"pid": project_id, "dept": department},
        )
    ).first()
    return None if row is None else str(row.id)


async def _ensure_thread(session: AsyncSession, *, project_id: str, employee_id: str) -> str:
    """その社員のスレッドを 1 本に保つ (無ければ作る)。通知ごとに新規スレッドを
    作ると会話が散らばり、文脈にも乗らない。"""
    row = (
        await session.execute(
            text(
                "select id from public.chat_threads "
                "where project_id = cast(:pid as uuid) and ai_employee_id = cast(:eid as uuid) "
                "  and deleted_at is null and archived = false "
                "order by updated_at desc limit 1"
            ),
            {"pid": project_id, "eid": employee_id},
        )
    ).first()
    if row is not None:
        return str(row.id)
    thread_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.chat_threads (id, project_id, ai_employee_id, title) "
            "values (cast(:id as uuid), cast(:pid as uuid), cast(:eid as uuid), :title)"
        ),
        {"id": thread_id, "pid": project_id, "eid": employee_id, "title": "コメント"},
    )
    return thread_id
