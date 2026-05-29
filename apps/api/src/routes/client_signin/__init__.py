"""クライアント別 JWT signin + project view ルータ (T-A-35 / R-T08 致命級)。

POST /client/auth/signin      — 招待トークン → client_portal JWT 発行
GET  /client/projects/{id}    — client JWT で限定 project ビュー (越境 403)

R-T08 (経営者承認済として実装): client JWT は project_id claim に限定され、
他 project へのアクセスは 403。越境試験を必須 PASS とする。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request, status

from src.schemas.client_signin import (
    ClientProjectView,
    ClientSigninRequest,
    ClientSigninResponse,
)
from src.services import client_signin as svc

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
        )
    except svc.ClientSigninError as exc:
        if exc.code == "invalid_token":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, exc.message) from exc
        if exc.code == "expired":
            raise HTTPException(status.HTTP_410_GONE, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
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
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, exc.message) from exc
    try:
        result = await svc.get_client_project(claims=claims, requested_project_id=project_id)
    except svc.ClientSigninError as exc:
        if exc.code == "cross_project":
            raise HTTPException(status.HTTP_403_FORBIDDEN, exc.message) from exc
        if exc.code == "project_not_found":
            raise HTTPException(status.HTTP_404_NOT_FOUND, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    return {"data": result}
