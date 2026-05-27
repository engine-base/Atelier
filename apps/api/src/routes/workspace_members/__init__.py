"""WS メンバー管理 ルータ (T-A-07)。

/workspaces/{workspace_id}/members[/{user_id}]。認証 (401) + RLS (T-D-14) + 404/403。
招待は email→user 解決 (未登録 422 / 既メンバー 409 / 非owner 403)。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.workspace_members import MemberInvite, MemberResponse, MemberRoleUpdate
from src.services import workspace_members as svc

router = APIRouter(tags=["workspace-members"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/workspaces/{workspace_id}/members", summary="WS メンバー一覧")
async def list_members(
    workspace_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[MemberResponse]]:
    return {"data": await svc.list_members(session, workspace_id)}


@router.post(
    "/workspaces/{workspace_id}/members",
    status_code=status.HTTP_201_CREATED,
    summary="WS メンバー招待",
)
async def invite_member(
    workspace_id: str, body: MemberInvite, session: SessionDep, user: UserDep
) -> dict[str, MemberResponse]:
    result, member = await svc.invite_member(
        session, actor_id=user.id, workspace_id=workspace_id, email=body.email, role=body.role
    )
    if result == "not_registered":
        raise HTTPException(422, "user with this email is not registered")
    if result == "forbidden":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "only workspace owner can invite members")
    if result == "already_member":
        raise HTTPException(status.HTTP_409_CONFLICT, "user is already a member")
    if member is None:  # pragma: no cover
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, "member created but not visible")
    return {"data": member}


@router.patch("/workspaces/{workspace_id}/members/{user_id}", summary="WS メンバーのロール変更")
async def update_role(
    workspace_id: str,
    user_id: str,
    body: MemberRoleUpdate,
    session: SessionDep,
    user: UserDep,
) -> dict[str, MemberResponse]:
    updated = await svc.update_role(
        session, actor_id=user.id, workspace_id=workspace_id, user_id=user_id, role=body.role
    )
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "not found or no permission to change role")
    return {"data": updated}


@router.delete(
    "/workspaces/{workspace_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="WS メンバー削除",
)
async def remove_member(
    workspace_id: str, user_id: str, session: SessionDep, user: UserDep
) -> None:
    if not await svc.remove_member(
        session, actor_id=user.id, workspace_id=workspace_id, user_id=user_id
    ):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "not found or no permission to remove member"
        )
