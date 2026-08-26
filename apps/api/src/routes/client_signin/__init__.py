"""クライアント別 JWT signin + project view ルータ (T-A-35 / R-T08 致命級)。

POST /client/auth/preview     — 招待トークンの署名前プレビュー (GAP-028)
POST /client/auth/signin      — 招待トークン → client_portal JWT 発行
GET  /client/projects/{id}    — client JWT で限定 project ビュー (越境 403)
GET  /client/projects/{id}/overview | /outputs | /mocks | /comments
POST /client/projects/{id}/comments — GAP-029 実コンテンツ (経営者承認済)

R-T08 (経営者承認済として実装): client JWT は project_id claim に限定され、
他 project へのアクセスは 403。越境試験を必須 PASS とする。
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status

from src.rate_limit import rate_limit_ip
from src.schemas.client_signin import (
    ClientCommentCreate,
    ClientCommentItem,
    ClientInvitationPreview,
    ClientInvitationPreviewRequest,
    ClientMocksResponse,
    ClientOutputItem,
    ClientProjectOverview,
    ClientProjectView,
    ClientSigninRequest,
    ClientSigninResponse,
)
from src.services import client_signin as svc
from src.services.client_signin import content as content_svc
from src.user_messages import user_detail

router = APIRouter(tags=["client-portal"])


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def _extract_bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "missing client bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return authorization[len("bearer ") :].strip()


@router.post(
    "/client/auth/preview",
    summary="招待トークンの署名前プレビュー (メタ限定・レート制限付 / GAP-028)",
    dependencies=[Depends(rate_limit_ip(10))],
)
async def client_invitation_preview(
    body: ClientInvitationPreviewRequest,
) -> dict[str, ClientInvitationPreview]:
    try:
        result = await svc.preview_invitation(invitation_token=body.invitation_token)
    except svc.ClientSigninError as exc:
        if exc.code == "invalid_token":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, user_detail(exc)) from exc
        if exc.code == "expired":
            raise HTTPException(status.HTTP_410_GONE, user_detail(exc)) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, user_detail(exc)) from exc
    return {"data": result}


@router.post(
    "/client/auth/signin",
    summary="クライアントサインイン (招待トークン → client_portal JWT)",
)
async def client_signin(
    body: ClientSigninRequest, request: Request
) -> dict[str, ClientSigninResponse]:
    try:
        result = await svc.client_signin(
            invitation_token=body.invitation_token,
            display_name=body.display_name,
            ip_address=_client_ip(request),
            agree_legal=body.agree_legal,
            agree_confidential=body.agree_confidential,
        )
    except svc.ClientSigninError as exc:
        if exc.code == "invalid_token":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, user_detail(exc)) from exc
        if exc.code == "expired":
            raise HTTPException(status.HTTP_410_GONE, user_detail(exc)) from exc
        if exc.code == "consent_required":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, user_detail(exc)) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, user_detail(exc)) from exc
    return {"data": result}


@router.get(
    "/client/projects/{project_id}",
    summary="クライアント限定 project ビュー (R-T08 越境拒否)",
)
async def client_project_view(
    project_id: str,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, ClientProjectView]:
    token = _extract_bearer(authorization)
    try:
        claims = svc.decode_client_token(token)
    except svc.ClientSigninError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, user_detail(exc)) from exc
    try:
        result = await svc.get_client_project(claims=claims, requested_project_id=project_id)
    except svc.ClientSigninError as exc:
        if exc.code == "cross_project":
            raise HTTPException(status.HTTP_403_FORBIDDEN, user_detail(exc)) from exc
        if exc.code == "project_not_found":
            raise HTTPException(status.HTTP_404_NOT_FOUND, user_detail(exc)) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, user_detail(exc)) from exc
    return {"data": result}


# --------------------------------------------------------------------------- #
# GAP-029: S-L03 実コンテンツ (R-T08 経営者承認済)。全て client JWT 必須 +
# project_id claim 一致 (越境 403)。read は view / 投稿は comment スコープ。
# --------------------------------------------------------------------------- #
def _client_claims(authorization: str | None) -> dict[str, Any]:
    token = _extract_bearer(authorization)
    try:
        return svc.decode_client_token(token)
    except svc.ClientSigninError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, user_detail(exc)) from exc


def _raise_content_error(exc: svc.ClientSigninError) -> None:
    if exc.code in ("cross_project", "forbidden_scope"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, user_detail(exc)) from exc
    if exc.code in ("project_not_found", "target_not_found"):
        raise HTTPException(status.HTTP_404_NOT_FOUND, user_detail(exc)) from exc
    if exc.code == "invalid_client_token":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, user_detail(exc)) from exc
    raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, user_detail(exc)) from exc


@router.get(
    "/client/projects/{project_id}/overview",
    summary="クライアント: 工程進捗 + 運営 + リンク有効期限 (GAP-029 / R-T08 越境拒否)",
)
async def client_project_overview(
    project_id: str,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, ClientProjectOverview]:
    claims = _client_claims(authorization)
    try:
        result = await content_svc.get_overview(claims=claims, requested_project_id=project_id)
    except svc.ClientSigninError as exc:
        _raise_content_error(exc)
        raise
    return {"data": result}


@router.get(
    "/client/projects/{project_id}/outputs",
    summary="クライアント: 成果物一覧 — stage 毎の最新版 (GAP-029 / R-T08 越境拒否)",
)
async def client_project_outputs(
    project_id: str,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, list[ClientOutputItem]]:
    claims = _client_claims(authorization)
    try:
        result = await content_svc.list_outputs(claims=claims, requested_project_id=project_id)
    except svc.ClientSigninError as exc:
        _raise_content_error(exc)
        raise
    return {"data": result}


@router.get(
    "/client/projects/{project_id}/mocks",
    summary="クライアント: モック一覧 — 画面毎の最新版 (GAP-029 / R-T08 越境拒否)",
)
async def client_project_mocks(
    project_id: str,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, ClientMocksResponse]:
    claims = _client_claims(authorization)
    try:
        result = await content_svc.list_mocks(claims=claims, requested_project_id=project_id)
    except svc.ClientSigninError as exc:
        _raise_content_error(exc)
        raise
    return {"data": result}


@router.get(
    "/client/projects/{project_id}/comments",
    summary="クライアント: 自分のコメント + 運営返信 (GAP-029 / R-T08 越境拒否)",
)
async def client_project_comments(
    project_id: str,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, list[ClientCommentItem]]:
    claims = _client_claims(authorization)
    try:
        result = await content_svc.list_comments(claims=claims, requested_project_id=project_id)
    except svc.ClientSigninError as exc:
        _raise_content_error(exc)
        raise
    return {"data": result}


@router.post(
    "/client/projects/{project_id}/comments",
    status_code=status.HTTP_201_CREATED,
    summary="クライアント: コメント投稿 — comment スコープ必須 (GAP-029 / R-T08 越境拒否)",
    dependencies=[Depends(rate_limit_ip(30))],
)
async def client_project_comment_create(
    project_id: str,
    body: ClientCommentCreate,
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, ClientCommentItem]:
    claims = _client_claims(authorization)
    try:
        result = await content_svc.create_comment(
            claims=claims, requested_project_id=project_id, data=body
        )
    except svc.ClientSigninError as exc:
        _raise_content_error(exc)
        raise
    return {"data": result}
