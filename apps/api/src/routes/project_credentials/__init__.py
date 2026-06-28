"""プロジェクト・シークレットルータ (T-A-46)。

/projects/{project_id}/credentials[/{credential_id}]。
認証 (401) + RLS (project の workspace member のみ、越境=0) + 404。
plaintext は登録時にしか受け取らず、一覧/詳細応答に含めない。reveal endpoint
でのみ復号して返し、必ず audit_logs に記録する。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.project_credentials import (
    CredentialCreate,
    CredentialResponse,
    CredentialReveal,
    CredentialUpdate,
)
from src.services import project_credentials as svc

router = APIRouter(tags=["project-credentials"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get(
    "/projects/{project_id}/credentials",
    summary="シークレット一覧（値マスク。member のみ）",
)
async def list_credentials(
    project_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[CredentialResponse]]:
    return {"data": await svc.list_credentials(session, project_id=project_id)}


@router.post(
    "/projects/{project_id}/credentials",
    status_code=status.HTTP_201_CREATED,
    summary="シークレットに登録（plaintext を暗号化保存、応答に含めない）",
)
async def create_credential(
    project_id: str, body: CredentialCreate, session: SessionDep, user: UserDep
) -> dict[str, CredentialResponse]:
    created = await svc.create_credential(
        session, actor_id=user.id, project_id=project_id, data=body
    )
    if created is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to create credential")
    return {"data": created}


@router.patch(
    "/projects/{project_id}/credentials/{credential_id}",
    summary="シークレットの name / kind 更新（value は変えない）",
)
async def update_credential(
    project_id: str,
    credential_id: str,
    body: CredentialUpdate,
    session: SessionDep,
    user: UserDep,
) -> dict[str, CredentialResponse]:
    updated = await svc.update_credential(
        session,
        actor_id=user.id,
        project_id=project_id,
        credential_id=credential_id,
        data=body,
    )
    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "credential not found")
    return {"data": updated}


@router.delete(
    "/projects/{project_id}/credentials/{credential_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="シークレットから削除（soft delete。owner のみ）",
)
async def delete_credential(
    project_id: str, credential_id: str, session: SessionDep, user: UserDep
) -> None:
    ok = await svc.delete_credential(
        session, actor_id=user.id, project_id=project_id, credential_id=credential_id
    )
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "credential not found")


@router.post(
    "/projects/{project_id}/credentials/{credential_id}/reveal",
    summary="シークレットの値を復号して 1 度返す（権限者のみ・監査記録）",
)
async def reveal_credential(
    project_id: str, credential_id: str, session: SessionDep, user: UserDep
) -> dict[str, CredentialReveal]:
    revealed = await svc.reveal_credential(
        session, actor_id=user.id, project_id=project_id, credential_id=credential_id
    )
    if revealed is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "credential not found")
    return {"data": revealed}
