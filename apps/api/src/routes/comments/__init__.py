"""コメント (comments) ルータ (T-A-22)。

/comments[/{id}]。認証 (401) + RLS (comments_*_member) + 404/403。
成果物 / モック / タスク / 受入条件に対するスレッド型コメント。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.comments import CommentCreate, CommentResponse, CommentTargetType, CommentUpdate
from src.services import comments as svc

router = APIRouter(tags=["comments"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/comments", summary="コメント一覧（対象指定）")
async def list_comments(
    session: SessionDep,
    _user: UserDep,
    target_type: Annotated[CommentTargetType, Query()],
    target_id: Annotated[str, Query()],
) -> dict[str, list[CommentResponse]]:
    return {"data": await svc.list_comments(session, target_type=target_type, target_id=target_id)}


@router.post("/comments", status_code=status.HTTP_201_CREATED, summary="コメント作成")
async def create_comment(
    body: CommentCreate, session: SessionDep, user: UserDep
) -> dict[str, CommentResponse]:
    created = await svc.create_comment(session, actor_id=user.id, data=body)
    if created is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to comment on target")
    return {"data": created}


@router.get("/comments/{comment_id}", summary="コメント詳細")
async def get_comment(
    comment_id: str, session: SessionDep, _user: UserDep
) -> dict[str, CommentResponse]:
    c = await svc.get_comment(session, comment_id)
    if c is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "comment not found")
    return {"data": c}


@router.patch("/comments/{comment_id}", summary="コメント編集・解決")
async def update_comment(
    comment_id: str, body: CommentUpdate, session: SessionDep, user: UserDep
) -> dict[str, CommentResponse]:
    if await svc.get_comment(session, comment_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "comment not found")
    updated = await svc.update_comment(session, actor_id=user.id, comment_id=comment_id, data=body)
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update comment")
    return {"data": updated}


@router.delete(
    "/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT, summary="コメント削除"
)
async def delete_comment(comment_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_comment(session, comment_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "comment not found")
    if not await svc.delete_comment(session, actor_id=user.id, comment_id=comment_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to delete comment")
