"""チャットの Atelier ツール群（agentic tool-use）。

チャットの AI 社員が「しゃべる」だけでなく、実際にアプリ操作（成果物の保存等）を
行えるようにするための client-side tool 定義と実行器。web_search（Anthropic
server-side tool）とは別に、ここで定義したツールは chat_sse の agentic ループが
`tool_use` を受けてサーバ側で実行し、`tool_result` を返して継続する。

第1弾は `save_deliverable`（AI が作った成果物をナレッジとして永続化し、ナレッジ画面で
参照できるようにする）。以後、工程遷移・タスク作成・成果物HTML生成 等を同じ枠組みで追加する。
同じ実行器を MCP 経路からも再利用できるよう、LLM 非依存の純粋な関数として実装する。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any, cast

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.schemas.knowledge import KnowledgeCreate
from src.services import knowledge as knowledge_svc


@dataclass(frozen=True)
class ToolContext:
    """ツール実行に必要な実行文脈（RLS セッション + 実行者 + 対象）。"""

    session: AsyncSession
    actor_id: str
    project_id: str | None
    workspace_id: str | None
    # 承認ゲート (GAP-031①) が approval_inbox の target に使うスレッド
    thread_id: str | None = None


def atelier_tool_defs() -> list[dict[str, Any]]:
    """Anthropic Messages API 形式の tool 定義一覧。"""
    return [
        {
            "name": "save_deliverable",
            "description": (
                "作成した成果物(要件定義・提案書・議事メモ 等)をナレッジとして保存し、"
                "後からナレッジ画面で参照できるようにする。ユーザーが『保存して』"
                "『ナレッジに残して』等と言った時や、重要な成果物を作り終えた時に使う。"
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "成果物のタイトル"},
                    "category": {
                        "type": "string",
                        "description": "分類(例: 要件定義 / 提案 / 見積 / メモ)",
                    },
                    "content_md": {
                        "type": "string",
                        "description": "Markdown 本文(成果物の中身そのもの)",
                    },
                },
                "required": ["title", "category", "content_md"],
            },
        },
    ]


ATELIER_TOOL_NAMES: frozenset[str] = frozenset(d["name"] for d in atelier_tool_defs())


async def _save_deliverable(ctx: ToolContext, tool_input: dict[str, Any]) -> str:
    if not ctx.workspace_id:
        return "エラー: ワークスペースを特定できないため保存できませんでした。"
    title = str(tool_input.get("title") or "無題").strip()[:200] or "無題"
    category = str(tool_input.get("category") or "成果物").strip()[:100] or "成果物"
    content = str(tool_input.get("content_md") or "").strip() or "(本文なし)"
    created = await knowledge_svc.create_knowledge(
        ctx.session,
        actor_id=ctx.actor_id,
        data=KnowledgeCreate(
            account_id=ctx.workspace_id,
            account_type="workspace",
            scope="common",
            category=category,
            title=title,
            content_md=content,
        ),
    )
    if created is None:
        return "保存に失敗しました(権限または可視性の制約)。"
    return (
        f"成果物「{created.title}」をナレッジに保存しました(id={created.id})。"
        "ナレッジ画面の『共通』タブから参照できます。"
    )


async def execute_atelier_tool(ctx: ToolContext, name: str, tool_input: dict[str, Any]) -> str:
    """name に対応する Atelier ツールを実行し、tool_result 用の文字列を返す。

    未知/失敗はエラー文字列を返し、会話は継続できるようにする(例外で stream を落とさない)。
    """
    try:
        if name == "save_deliverable":
            return await _save_deliverable(ctx, tool_input)
        return f"未対応のツールです: {name}"
    except Exception as exc:  # pragma: no cover - 実行時例外は tool_result で AI に返す
        return f"ツール実行中にエラーが発生しました: {type(exc).__name__}: {exc}"


# --------------------------------------------------------------------------- #
# GAP-031①: ツール実行の人間承認ゲート (S-E01 「承認して実行」)
# --------------------------------------------------------------------------- #
# 書込系ツールは自動実行しない。approval_inbox (type='tool_execution') に登録し、
# 人間が「承認して実行」した時に初めて execute_atelier_tool を呼ぶ。
APPROVAL_REQUIRED_TOOLS: frozenset[str] = frozenset({"save_deliverable"})


async def request_tool_approval(
    ctx: ToolContext, *, thread_id: str, name: str, tool_input: dict[str, Any]
) -> str:
    """ツール実行を承認待ちに登録し、LLM へ返す tool_result 文言を返す。

    approval_inbox_insert_self (user_id = 本人) を満たす RLS セッションで呼ぶ。
    """
    import json as _json

    from src.audit import AuditEvent, AuditWriter

    approval_id = str(uuid.uuid4())
    title = str(tool_input.get("title") or name)[:80]
    await ctx.session.execute(
        text(
            "insert into public.approval_inbox "
            "(id, user_id, type, target_type, target_id, title, payload) "
            "values (cast(:i as uuid), cast(:u as uuid), 'tool_execution', "
            "'chat_thread', cast(:t as uuid), :ttl, cast(:pl as jsonb))"
        ),
        {
            "i": approval_id,
            "u": ctx.actor_id,
            "t": thread_id,
            "ttl": f"ツール実行の承認: {name}（{title}）",
            "pl": _json.dumps(
                {"tool": name, "tool_input": tool_input, "thread_id": thread_id},
                ensure_ascii=False,
            ),
        },
    )
    await AuditWriter(ctx.session).write(
        AuditEvent(
            action="chat_tool.approval_requested",
            target_type="approval_inbox",
            actor_type="user",
            actor_id=ctx.actor_id,
            target_id=approval_id,
            after={"tool": name, "thread_id": thread_id},
        )
    )
    return (
        f"ツール「{name}」の実行には人間の承認が必要です。承認待ち"
        f"(approval_id={approval_id}) に登録しました。ユーザーが画面の"
        "「承認して実行」を押すと実行されます。実行済みの体で回答しないでください。"
    )


async def _load_tool_approval(session: AsyncSession, *, approval_id: str) -> dict[str, Any] | None:
    res = await session.execute(
        text(
            "select id, status, payload from public.approval_inbox "
            "where id = cast(:i as uuid) and type = 'tool_execution'"
        ),
        {"i": approval_id},
    )
    row = res.first()
    if row is None:
        return None
    import json as _json

    raw: Any = row.payload
    payload: dict[str, Any] = _json.loads(raw) if isinstance(raw, str) else (raw or {})
    return {"id": str(row.id), "status": str(row.status), "payload": payload}


async def _thread_ctx(session: AsyncSession, *, actor_id: str, thread_id: str) -> ToolContext:
    res = await session.execute(
        text(
            "select t.project_id, p.workspace_id from public.chat_threads t "
            "left join public.projects p on p.id = t.project_id "
            "where t.id = cast(:t as uuid)"
        ),
        {"t": thread_id},
    )
    row = res.first()
    return ToolContext(
        session=session,
        actor_id=actor_id,
        project_id=None if row is None or row.project_id is None else str(row.project_id),
        workspace_id=None if row is None or row.workspace_id is None else str(row.workspace_id),
    )


async def _insert_thread_message(
    session: AsyncSession, *, thread_id: str, role: str, content: str
) -> None:
    await session.execute(
        text(
            "insert into public.chat_messages (thread_id, role, content, created_at) "
            "values (cast(:t as uuid), cast(:r as chat_message_role_enum), :c, "
            "clock_timestamp())"
        ),
        {"t": thread_id, "r": role, "c": content},
    )


async def execute_approved_tool(
    session: AsyncSession, *, actor_id: str, approval_id: str
) -> tuple[str, str]:
    """「承認して実行」— pending の tool_execution 承認を実行する。

    Returns (code, result): code は ok / not_found / already_resolved。
    実行結果はスレッドへ tool メッセージとして記録し、inbox は approved +
    resolution_note に結果を残す。
    """
    import json as _json

    from src.audit import AuditEvent, AuditWriter

    approval = await _load_tool_approval(session, approval_id=approval_id)
    if approval is None:
        return "not_found", ""
    if approval["status"] != "pending":
        return "already_resolved", ""
    payload = approval["payload"]
    name = str(payload.get("tool") or "")
    thread_id = str(payload.get("thread_id") or "")
    raw_input = payload.get("tool_input")
    tool_input: dict[str, Any] = (
        cast("dict[str, Any]", raw_input) if isinstance(raw_input, dict) else {}
    )

    ctx = await _thread_ctx(session, actor_id=actor_id, thread_id=thread_id)
    result = await execute_atelier_tool(ctx, name, tool_input)

    await session.execute(
        text(
            "update public.approval_inbox set status = 'approved', resolved_at = now(), "
            "resolution_note = :note where id = cast(:i as uuid) and status = 'pending'"
        ),
        {"note": result[:500], "i": approval_id},
    )
    await _insert_thread_message(
        session,
        thread_id=thread_id,
        role="tool",
        content=_json.dumps({"tool": name, "result": result}, ensure_ascii=False),
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="chat_tool.executed",
            target_type="approval_inbox",
            actor_type="user",
            actor_id=actor_id,
            target_id=approval_id,
            after={"tool": name, "thread_id": thread_id},
        )
    )
    return "ok", result


async def reject_tool_approval(
    session: AsyncSession, *, actor_id: str, approval_id: str, note: str | None = None
) -> str:
    """「差戻」— pending の tool_execution 承認を却下する。code を返す。"""
    from src.audit import AuditEvent, AuditWriter

    approval = await _load_tool_approval(session, approval_id=approval_id)
    if approval is None:
        return "not_found"
    if approval["status"] != "pending":
        return "already_resolved"
    payload = approval["payload"]
    name = str(payload.get("tool") or "")
    thread_id = str(payload.get("thread_id") or "")
    await session.execute(
        text(
            "update public.approval_inbox set status = 'rejected', resolved_at = now(), "
            "resolution_note = :note where id = cast(:i as uuid) and status = 'pending'"
        ),
        {"note": note, "i": approval_id},
    )
    await _insert_thread_message(
        session,
        thread_id=thread_id,
        role="system",
        content=f"ツール実行「{name}」は差し戻されました。",
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="chat_tool.rejected",
            target_type="approval_inbox",
            actor_type="user",
            actor_id=actor_id,
            target_id=approval_id,
            after={"tool": name, "thread_id": thread_id, "note": note},
        )
    )
    return "ok"


async def list_tool_approvals(
    session: AsyncSession, *, thread_id: str, status: str | None = "pending"
) -> list[dict[str, Any]]:
    """スレッドの tool_execution 承認一覧 (RLS: 本人の inbox のみ可視)。"""
    import json as _json

    where = ["type = 'tool_execution'", "target_id = cast(:t as uuid)"]
    params: dict[str, object] = {"t": thread_id}
    if status is not None:
        where.append("status = :st")
        params["st"] = status
    res = await session.execute(
        text(
            "select id, status, title, payload, created_at, resolution_note "
            f"from public.approval_inbox where {' and '.join(where)} "
            "order by created_at asc"
        ),
        params,
    )
    out: list[dict[str, Any]] = []
    for row in res.all():
        raw: Any = row.payload
        payload: dict[str, Any] = _json.loads(raw) if isinstance(raw, str) else (raw or {})
        out.append(
            {
                "id": str(row.id),
                "status": str(row.status),
                "title": str(row.title),
                "tool": str(payload.get("tool") or ""),
                "tool_input": payload.get("tool_input") or {},
                "created_at": row.created_at,
                "resolution_note": (
                    None if row.resolution_note is None else str(row.resolution_note)
                ),
            }
        )
    return out
