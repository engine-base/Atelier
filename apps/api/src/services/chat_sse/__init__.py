"""チャット SSE + F-CTX01 文脈構築 サービス層 (T-A-18)。

F-CTX01: thread の過去 message N 件 + ナレッジ RAG (voyage 検索 top-k) を
system prompt に組み立てる。LLM 呼出は AnthropicClient (T-F-15)。

ANTHROPIC_API_KEY 未設定 / SDK 不在の dev/test 環境では fake stream
generator にフォールバックし、user_message を echo する短い deterministic
チャンク列を yield する (SSE 配信 + audit + DB persist を実 path で覆う)。

state-changing 操作 (user/assistant message の chat_messages 挿入) は
audit_logs に必ず記録 (3-tier AC: state-changing audit)。
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.chat_sse import ChatContextPreviewResponse


async def _load_recent_messages(
    session: AsyncSession, *, thread_id: str, limit: int
) -> list[tuple[str, str]]:
    """thread の過去 message を (role, content) の組で新しい順 → 古い順で返す。"""
    if limit <= 0:
        return []
    res = await session.execute(
        text(
            "select role, content from public.chat_messages "
            "where thread_id = cast(:tid as uuid) "
            "order by created_at desc limit :lim"
        ),
        {"tid": thread_id, "lim": limit},
    )
    rows = list(res.all())
    rows.reverse()
    return [(str(r.role), str(r.content)) for r in rows]


async def _build_rag_context(
    session: AsyncSession, *, query: str, account_id: str | None
) -> tuple[str, list[str]]:
    """ナレッジ RAG 結果を system prompt 用テキストに整形して返す。

    Voyage embedding 統合は T-A-36 / T-F-14 に集約されており、本ルータでは
    RLS が効く query を直接発行して title / content_md の ilike 検索で
    候補上位を取り出す軽量パスを実装する (chat の dev/test 経路を独立に
    動かすため)。account_id 指定時は account_id でも絞り込む。
    """
    where = ["deleted_at is null", "(title ilike :pat or content_md ilike :pat)"]
    params: dict[str, object] = {"pat": f"%{query}%"}
    if account_id is not None:
        where.append("account_id = cast(:aid as uuid)")
        params["aid"] = account_id
    res = await session.execute(
        text(
            "select id, title, content_md from public.knowledge_nodes "
            f"where {' and '.join(where)} order by usage_count desc limit 3"
        ),
        params,
    )
    rows = list(res.all())
    if not rows:
        return "", []
    lines = ["以下は関連ナレッジ (RAG 検索結果):"]
    ids: list[str] = []
    for r in rows:
        lines.append(f"- [{r.title}] {str(r.content_md)[:300]}")
        ids.append(str(r.id))
    return "\n".join(lines), ids


async def build_context(
    session: AsyncSession,
    *,
    thread_id: str,
    user_message: str,
    include_history: int,
    rag_account_id: str | None,
    use_rag: bool = True,
) -> tuple[str, list[tuple[str, str]], list[str]]:
    """(system_prompt, history, rag_hit_ids) を返す F-CTX01 構築。"""
    history = await _load_recent_messages(session, thread_id=thread_id, limit=include_history)
    rag_block = ""
    rag_ids: list[str] = []
    if use_rag:
        rag_block, rag_ids = await _build_rag_context(
            session, query=user_message, account_id=rag_account_id
        )
    base = "あなたは Atelier の AI アシスタントです。日本語で簡潔に回答してください。"
    parts = [base]
    if rag_block:
        parts.append(rag_block)
    return "\n\n".join(parts), history, rag_ids


async def preview_context(
    session: AsyncSession,
    *,
    thread_id: str,
    user_message: str,
    include_history: int,
    rag_account_id: str | None,
) -> ChatContextPreviewResponse:
    system_prompt, history, rag_ids = await build_context(
        session,
        thread_id=thread_id,
        user_message=user_message,
        include_history=include_history,
        rag_account_id=rag_account_id,
        use_rag=True,
    )
    return ChatContextPreviewResponse(
        system_prompt=system_prompt,
        history_count=len(history),
        rag_hit_ids=rag_ids,
    )


async def _insert_message(
    session: AsyncSession,
    *,
    thread_id: str,
    role: str,
    content: str,
) -> str:
    new_id = str(uuid.uuid4())
    await session.execute(
        text(
            "insert into public.chat_messages "
            "(id, thread_id, role, content) "
            "values (cast(:i as uuid), cast(:t as uuid), "
            "cast(:r as chat_message_role_enum), :c)"
        ),
        {"i": new_id, "t": thread_id, "r": role, "c": content},
    )
    return new_id


def _sse_event(payload: dict[str, Any]) -> bytes:
    """data: <json>\\n\\n の SSE event をエンコード。"""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


async def _fake_stream_chunks(prompt: str) -> AsyncIterator[str]:
    """ANTHROPIC_API_KEY 不在時の fallback。

    user_message を echo する deterministic な短い応答を 1 文字ずつ
    yield する (テスト容易性 + SSE 配信パス検証用)。
    """
    fake_text = f"echo: {prompt[:200]}"
    for ch in fake_text:
        yield ch


async def _real_stream_chunks(
    *,
    system_prompt: str,
    history: list[tuple[str, str]],
    user_message: str,
) -> AsyncIterator[str]:
    """Anthropic SDK で実 stream。chunk text delta を yield する。"""
    from anthropic import AsyncAnthropic  # type: ignore[import-not-found]

    client = AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
    msgs: list[dict[str, str]] = []
    for role, content in history:
        if role in ("user", "assistant"):
            msgs.append({"role": role, "content": content})
    msgs.append({"role": "user", "content": user_message})

    async with client.messages.stream(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        system=system_prompt,
        messages=msgs,  # type: ignore[arg-type]
    ) as stream:
        async for delta in stream.text_stream:  # type: ignore[union-attr]
            if delta:
                yield delta


async def stream_chat(
    session: AsyncSession,
    *,
    actor_id: str,
    thread_id: str,
    user_message: str,
    use_rag: bool,
    include_history: int,
    rag_account_id: str | None,
) -> AsyncIterator[bytes]:
    """SSE byte stream を yield する generator。

    1. F-CTX01: system prompt + history + RAG を構築
    2. chat_messages に user message を insert (audit)
    3. LLM stream → SSE 'delta' を chunk 配信
    4. 完了時に assistant message を chat_messages に insert (audit)
    5. 'end' event で usage / message_ids を返す
    """
    system_prompt, history, rag_ids = await build_context(
        session,
        thread_id=thread_id,
        user_message=user_message,
        include_history=include_history,
        rag_account_id=rag_account_id,
        use_rag=use_rag,
    )

    user_msg_id = await _insert_message(
        session, thread_id=thread_id, role="user", content=user_message
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="chat.message.create",
            target_type="chat_message",
            actor_type="user",
            actor_id=actor_id,
            target_id=user_msg_id,
            after={"thread_id": thread_id, "role": "user"},
        )
    )

    yield _sse_event(
        {
            "type": "context",
            "metadata": {
                "history_count": len(history),
                "rag_hit_ids": rag_ids,
                "user_message_id": user_msg_id,
            },
        }
    )
    yield _sse_event({"type": "start"})

    use_real = bool(os.environ.get("ANTHROPIC_API_KEY"))
    accumulated: list[str] = []
    try:
        if use_real:
            chunks = _real_stream_chunks(
                system_prompt=system_prompt,
                history=history,
                user_message=user_message,
            )
        else:
            chunks = _fake_stream_chunks(user_message)
        async for chunk in chunks:
            accumulated.append(chunk)
            yield _sse_event({"type": "delta", "content": chunk})
    except Exception as exc:  # pragma: no cover  - 実 LLM 障害は別レイヤ
        yield _sse_event({"type": "error", "content": str(exc)[:300]})
        return

    final_text = "".join(accumulated)
    assistant_msg_id = await _insert_message(
        session, thread_id=thread_id, role="assistant", content=final_text
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="chat.message.create",
            target_type="chat_message",
            actor_type="user",
            actor_id=actor_id,
            target_id=assistant_msg_id,
            after={"thread_id": thread_id, "role": "assistant"},
        )
    )

    yield _sse_event(
        {
            "type": "end",
            "metadata": {
                "assistant_message_id": assistant_msg_id,
                "user_message_id": user_msg_id,
                "total_chars": len(final_text),
            },
        }
    )
