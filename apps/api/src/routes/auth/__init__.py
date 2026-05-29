"""認証 API ルータ (T-A-01)。

POST /auth/signup — F-001 ユーザー登録 + F-LEGAL-004 同意取得。
無認証 endpoint (signup なので JWT はまだ無い)。Supabase Auth admin API
または DB direct insert で auth.users を作成し、public.users と consents
を atomic に書込む。

T-A-02 (signin)、T-A-03 (Magic Link / OAuth)、T-A-04 (パスワードリセット)、
T-A-05 (退会) は別タスク。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, status

from src.schemas.auth import SigninRequest, SigninResponse, SignupRequest, SignupResponse
from src.services import auth as svc

router = APIRouter(tags=["auth"])


@router.post(
    "/auth/signup",
    status_code=status.HTTP_201_CREATED,
    summary="ユーザー登録 + 同意取得 (F-001 / F-LEGAL-004)",
)
async def signup(body: SignupRequest, request: Request) -> dict[str, SignupResponse]:
    ip = request.client.host if request.client else None
    ua: Annotated[str | None, "User-Agent"] = request.headers.get("user-agent")
    try:
        result = await svc.signup(data=body, ip_address=ip, user_agent=ua)
    except svc.SignupError as exc:
        if exc.code == "consent_missing":
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, exc.message) from exc
        if exc.code == "email_taken":
            raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    return {"data": result}


@router.post(
    "/auth/signin",
    summary="ログイン + 5 回失敗ロック (F-001)",
)
async def signin(body: SigninRequest, request: Request) -> dict[str, SigninResponse]:
    ip = request.client.host if request.client else None
    ua = request.headers.get("user-agent")
    try:
        result = await svc.signin(
            email=str(body.email),
            password=body.password,
            ip_address=ip,
            user_agent=ua,
        )
    except svc.SigninError as exc:
        if exc.code == "invalid_credentials":
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, exc.message) from exc
        if exc.code == "locked":
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, exc.message) from exc
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, exc.message) from exc
    return {"data": result}
