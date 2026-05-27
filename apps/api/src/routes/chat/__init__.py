"""Chat スレッド CRUD + メッセージ送信 ルータ (T-A-16 / T-A-17)。

/chat/threads, /chat/threads/{id}, /chat/threads/{id}/messages。
認証 (401) + RLS (T-D-17) + 404/403。メッセージ送信はユーザー発話の即時永続化。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.chat import (
    MessageCreate,
    MessageResponse,
    ThreadCreate,
    ThreadResponse,
    ThreadUpdate,
)
from src.services import chat as svc

router = APIRouter(tags=["chat"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/chat/threads", summary="チャットスレッド一覧")
async def list_threads(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
    include_archived: Annotated[bool, Query()] = False,
) -> dict[str, list[ThreadResponse]]:
    return {
        "data": await svc.list_threads(
            session, project_id=project_id, include_archived=include_archived
        )
    }


@router.post("/chat/threads", status_code=status.HTTP_201_CREATED, summary="チャットスレッド作成")
async def create_thread(
    body: ThreadCreate, session: SessionDep, user: UserDep
) -> dict[str, ThreadResponse]:
    return {"data": await svc.create_thread(session, actor_id=user.id, data=body)}


@router.get("/chat/threads/{thread_id}", summary="チャットスレッド詳細")
async def get_thread(
    thread_id: str, session: SessionDep, _user: UserDep
) -> dict[str, ThreadResponse]:
    th = await svc.get_thread(session, thread_id)
    if th is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "thread not found")
    return {"data": th}


@router.patch("/chat/threads/{thread_id}", summary="チャットスレッド更新")
async def update_thread(
    thread_id: str, body: ThreadUpdate, session: SessionDep, user: UserDep
) -> dict[str, ThreadResponse]:
    if await svc.get_thread(session, thread_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "thread not found")
    updated = await svc.update_thread(session, actor_id=user.id, thread_id=thread_id, data=body)
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update thread")
    return {"data": updated}


@router.delete(
    "/chat/threads/{thread_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="チャットスレッド削除",
)
async def delete_thread(thread_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_thread(session, thread_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "thread not found")
    if not await svc.delete_thread(session, actor_id=user.id, thread_id=thread_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to delete thread")


@router.get("/chat/threads/{thread_id}/messages", summary="チャットメッセージ一覧")
async def list_messages(
    thread_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[MessageResponse]]:
    if await svc.get_thread(session, thread_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "thread not found")
    return {"data": await svc.list_messages(session, thread_id=thread_id)}


@router.post(
    "/chat/threads/{thread_id}/messages",
    status_code=status.HTTP_201_CREATED,
    summary="チャットメッセージ送信（即時 / ユーザー発話）",
)
async def create_message(
    thread_id: str, body: MessageCreate, session: SessionDep, user: UserDep
) -> dict[str, MessageResponse]:
    if await svc.get_thread(session, thread_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "thread not found")
    if not await svc.can_post_to_thread(session, thread_id=thread_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to post to thread")
    created = await svc.create_message(session, actor_id=user.id, thread_id=thread_id, data=body)
    return {"data": created}
