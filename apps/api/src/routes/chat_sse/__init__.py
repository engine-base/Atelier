"""チャット SSE ストリーミング + F-CTX01 文脈構築 ルータ (T-A-18)。

S-E01 チャット画面用。POST /chat/threads/{thread_id}/stream で
user_message を受け、F-CTX01 (過去 message + ナレッジ RAG) を構築した
system prompt で LLM 応答を SSE (text/event-stream) で配信する。

認証 (401) + RLS (T-D-17 chat_threads) + 404。stream 中の各イベントは
JSON で encode、Content-Type: text/event-stream で配信。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.chat_sse import (
    ChatContextPreviewRequest,
    ChatContextPreviewResponse,
    ChatStreamRequest,
)
from src.services import chat_sse as svc

router = APIRouter(tags=["chat-sse"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


async def _thread_visible(session: AsyncSession, thread_id: str) -> bool:
    res = await session.execute(
        text(
            "select 1 from public.chat_threads where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": thread_id},
    )
    return res.first() is not None


@router.post(
    "/chat/threads/{thread_id}/stream",
    summary="チャット SSE ストリーミング (F-CTX01 文脈構築 + LLM)",
)
async def stream_chat_thread(
    thread_id: str,
    body: ChatStreamRequest,
    session: SessionDep,
    user: UserDep,
) -> StreamingResponse:
    if not await _thread_visible(session, thread_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "chat thread not found")
    gen = svc.stream_chat(
        session,
        actor_id=user.id,
        thread_id=thread_id,
        user_message=body.user_message,
        use_rag=body.use_knowledge_rag,
        include_history=body.include_history,
        rag_account_id=body.rag_account_id,
    )
    return StreamingResponse(
        gen,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.post(
    "/chat/threads/{thread_id}/context-preview",
    summary="チャット F-CTX01 文脈構築プレビュー (LLM 呼出無し)",
)
async def preview_chat_context(
    thread_id: str,
    body: ChatContextPreviewRequest,
    session: SessionDep,
    _user: UserDep,
) -> dict[str, ChatContextPreviewResponse]:
    if not await _thread_visible(session, thread_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "chat thread not found")
    return {
        "data": await svc.preview_context(
            session,
            thread_id=thread_id,
            user_message=body.user_message,
            include_history=body.include_history,
            rag_account_id=body.rag_account_id,
        )
    }
