"""WS メンバー管理 ルータ (T-A-07)。

/workspaces/{workspace_id}/members[/{user_id}]。認証 (401) + RLS (T-D-14) + 404/403。
招待は email→user 解決 (未登録 422 / 既メンバー 409 / 非owner 403)。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.workspace_members import (
    InvitationAcceptResponse,
    InvitationPreviewResponse,
    MemberInvite,
    MemberResponse,
    MemberRoleUpdate,
    WorkspaceInvitationResponse,
)
from src.services import workspace_invitations as inv_svc
from src.services import workspace_members as svc
from src.user_messages import user_detail

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
    workspace_id: str, body: MemberInvite, session: SessionDep, user: UserDep, response: Response
) -> dict[str, MemberResponse | WorkspaceInvitationResponse]:
    result, member = await svc.invite_member(
        session, actor_id=user.id, workspace_id=workspace_id, email=body.email, role=body.role
    )
    if result == "invited":
        # GAP-315: 未登録の宛先には期限つきの招待リンクを送った (メンバーはまだ増えていない)
        response.status_code = status.HTTP_202_ACCEPTED
        pending = await inv_svc.list_invitations(session, workspace_id)
        latest = next((i for i in pending if i.email.lower() == body.email.lower()), None)
        if latest is None:  # pragma: no cover - 直前に作成済
            raise HTTPException(
                status.HTTP_500_INTERNAL_SERVER_ERROR,
                "招待を発行しましたが、いま一覧に反映できませんでした。少し待って開き直してください。",
            )
        return {"data": _to_invitation_response(latest)}
    if result == "not_registered":  # pragma: no cover - invited に置き換わった
        raise HTTPException(422, "このメールアドレスのアカウントは登録されていません。")
    if result == "forbidden":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "メンバーを招待できるのはワークスペースのオーナーだけです。"
        )
    if result == "already_member":
        raise HTTPException(status.HTTP_409_CONFLICT, "この方は、すでにメンバーです。")
    if member is None:  # pragma: no cover
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "メンバーを追加しましたが、いま一覧に反映できませんでした。少し待って開き直してください。",
        )
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
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "対象が見つからないか、役割を変更する権限がありません。"
        )
    return {"data": updated}


@router.delete(
    "/workspaces/{workspace_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="WS メンバー削除",
)
async def remove_member(
    workspace_id: str, user_id: str, session: SessionDep, user: UserDep
) -> None:
    try:
        removed = await svc.remove_member(
            session, actor_id=user.id, workspace_id=workspace_id, user_id=user_id
        )
    except svc.LastOwnerError:
        # GAP-272: LAST_OWNER — 先に別のメンバーを owner にしてから外す
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "最後の owner は外せません。先に別のメンバーを owner にしてください。",
        ) from None
    if not removed:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "対象が見つからないか、メンバーを外す権限がありません。"
        )


# --------------------------------------------------------------------------- #
# GAP-315: 招待リンク (未登録の宛先向け・既定 7 日)
# --------------------------------------------------------------------------- #
def _to_invitation_response(s: inv_svc.InvitationSummary) -> WorkspaceInvitationResponse:
    return WorkspaceInvitationResponse(
        id=s.id,
        workspace_id=s.workspace_id,
        workspace_name=s.workspace_name,
        email=s.email,
        role=s.role,  # pyright: ignore[reportArgumentType]
        expires_at=s.expires_at,
        invited_by_name=s.invited_by_name,
    )


@router.get("/workspaces/{workspace_id}/invitations", summary="未受領の招待一覧")
async def list_invitations(
    workspace_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[WorkspaceInvitationResponse]]:
    items = await inv_svc.list_invitations(session, workspace_id)
    return {"data": [_to_invitation_response(i) for i in items]}


@router.post(
    "/workspaces/{workspace_id}/invitations/{invitation_id}/revoke",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="招待の取り消し",
)
async def revoke_invitation(
    workspace_id: str, invitation_id: str, session: SessionDep, user: UserDep
) -> None:
    ok = await inv_svc.revoke_invitation(
        session, actor_id=user.id, workspace_id=workspace_id, invitation_id=invitation_id
    )
    if not ok:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "この招待は見つからないか、すでに使われています。"
        )


@router.get("/invitations/{token}", summary="招待リンクの内容 (未サインインでも可)")
async def preview_invitation(token: str) -> dict[str, InvitationPreviewResponse]:
    try:
        s = await inv_svc.preview_invitation(token)
    except inv_svc.InvitationError as exc:
        # 期限切れ / 失効 / 使用済みは 410 (「無い」ではなく「もう使えない」)
        code = status.HTTP_404_NOT_FOUND if exc.code == "not_found" else status.HTTP_410_GONE
        # 文言は user_messages の表から引く (route の中だけに日本語を置くと足し忘れが検出できない)
        raise HTTPException(code, user_detail(exc)) from exc
    return {
        "data": InvitationPreviewResponse(
            workspace_name=s.workspace_name,
            email=s.email,
            role=s.role,  # pyright: ignore[reportArgumentType]
            expires_at=s.expires_at,
            invited_by_name=s.invited_by_name,
        )
    }


@router.post("/invitations/{token}/accept", summary="招待を受け取って参加する")
async def accept_invitation(token: str, user: UserDep) -> dict[str, InvitationAcceptResponse]:
    try:
        s = await inv_svc.accept_invitation(raw_token=token, user_id=user.id)
    except inv_svc.InvitationError as exc:
        code = {
            "not_found": status.HTTP_404_NOT_FOUND,
            "email_mismatch": status.HTTP_403_FORBIDDEN,
        }.get(exc.code, status.HTTP_410_GONE)
        raise HTTPException(code, user_detail(exc)) from exc
    return {
        "data": InvitationAcceptResponse(
            workspace_id=s.workspace_id,
            workspace_name=s.workspace_name,
            role=s.role,  # pyright: ignore[reportArgumentType]
        )
    }
