"""Mock CRUD + バージョン管理 ルータ (T-A-33)。

/mocks, /mocks/{id}, /mocks/{id}/versions。認証は get_current_user (401)、
可視性/権限は RLS (T-D-17) + 404/403。
"""

from __future__ import annotations

import uuid
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import HTMLResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.db.session import create_engine, create_session_factory
from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.mocks import (
    MockCreate,
    MockGenerateRequest,
    MockResponse,
    MockReviseRequest,
    MockUpdate,
    MockVersionCreate,
)
from src.schemas.storage import ContentUrlResponse
from src.services import mocks as svc
from src.services.mocks.artifacts import (
    MOCKDB_PREFIX,
    build_content_url,
    fetch_mock_content,
    verify_content_token,
)
from src.storage_signing import StorageSigningError, create_signed_download_url

router = APIRouter(tags=["mocks"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@lru_cache(maxsize=1)
def _content_session_factory() -> async_sessionmaker[AsyncSession]:
    """GAP-137: mockdb コンテンツ配信用の service session。

    /mocks/{id}/content は iframe から Authorization ヘッダ無しで届くため
    JWT 依存の RLS session は使えない — 代わりに自己署名トークン
    (content-url 取得時に RLS で可視性を確認済み) を検証して配信する。
    """
    return create_session_factory(create_engine())


@router.get("/mocks", summary="モック一覧")
async def list_mocks(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
    screen_name: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, list[MockResponse]]:
    return {
        "data": await svc.list_mocks(
            session, project_id=project_id, screen_name=screen_name, limit=limit
        )
    }


@router.post("/mocks", status_code=status.HTTP_201_CREATED, summary="モック作成")
async def create_mock(
    body: MockCreate, session: SessionDep, user: UserDep
) -> dict[str, MockResponse]:
    return {"data": await svc.create_mock(session, actor_id=user.id, data=body)}


@router.get("/mocks/{mock_id}", summary="モック詳細")
async def get_mock(mock_id: str, session: SessionDep, _user: UserDep) -> dict[str, MockResponse]:
    mock = await svc.get_mock(session, mock_id)
    if mock is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mock not found")
    return {"data": mock}


@router.get(
    "/mocks/{mock_id}/content-url",
    summary="モック HTML の署名付き閲覧 URL",
    responses={503: {"description": "storage backend が未設定"}},
)
async def get_mock_content_url(
    mock_id: str, session: SessionDep, _user: UserDep, request: Request
) -> dict[str, ContentUrlResponse]:
    """RLS で可視な mock の html_storage_path に対する署名付き閲覧 URL を返す。

    GAP-137: mockdb:// (DB 内蔵 HTML — チャット成果物の取り込み等) は
    Supabase Storage を使わず、自己署名の期限付き URL (/mocks/{id}/content)
    を返す。従来の '{bucket}/{object}' は Supabase 署名 URL のまま。
    """
    mock = await svc.get_mock(session, mock_id)
    if mock is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mock not found")
    if mock.html_storage_path.startswith(MOCKDB_PREFIX):
        return {
            "data": ContentUrlResponse(url=build_content_url(str(request.base_url), mock_id))
        }
    try:
        url = await create_signed_download_url(mock.html_storage_path)
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    return {"data": ContentUrlResponse(url=url)}


@router.get(
    "/mocks/{mock_id}/content",
    summary="mockdb モック HTML の配信 (自己署名トークン / GAP-137)",
    response_class=HTMLResponse,
)
async def get_mock_content(
    mock_id: str,
    exp: Annotated[int, Query(ge=0)],
    sig: Annotated[str, Query(min_length=32, max_length=128)],
) -> HTMLResponse:
    """content-url が発行した期限付きトークンで mockdb HTML を返す。

    iframe から Authorization 無しで届くため JWT は使わない — 可視性は
    content-url 発行時に RLS で確認済みで、その証明が sig (HMAC)。
    """
    if not verify_content_token(mock_id, exp, sig):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "invalid or expired token")
    try:
        uuid.UUID(mock_id)
    except ValueError:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mock content not found") from None
    factory = _content_session_factory()
    async with factory() as session:
        row = (
            await session.execute(
                text(
                    "select html_storage_path from public.mocks "
                    "where id = cast(:i as uuid) and deleted_at is null"
                ),
                {"i": mock_id},
            )
        ).first()
        if row is None or not str(row.html_storage_path).startswith(MOCKDB_PREFIX):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "mock content not found")
        html = await fetch_mock_content(
            session, content_id=str(row.html_storage_path)[len(MOCKDB_PREFIX) :]
        )
    if html is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mock content not found")
    return HTMLResponse(
        content=html,
        headers={"Cache-Control": "private, max-age=60", "X-Robots-Tag": "noindex"},
    )


@router.patch("/mocks/{mock_id}", summary="モック更新")
async def update_mock(
    mock_id: str, body: MockUpdate, session: SessionDep, user: UserDep
) -> dict[str, MockResponse]:
    if await svc.get_mock(session, mock_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mock not found")
    updated = await svc.update_mock(session, actor_id=user.id, mock_id=mock_id, data=body)
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update mock")
    return {"data": updated}


@router.delete(
    "/mocks/{mock_id}", status_code=status.HTTP_204_NO_CONTENT, summary="モック削除（論理）"
)
async def delete_mock(mock_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_mock(session, mock_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mock not found")
    if not await svc.delete_mock(session, actor_id=user.id, mock_id=mock_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to delete mock")


@router.get("/mocks/{mock_id}/versions", summary="モックのバージョン履歴")
async def list_versions(
    mock_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[MockResponse]]:
    if await svc.get_mock(session, mock_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mock not found")
    return {"data": await svc.list_versions(session, mock_id)}


@router.post(
    "/mocks/{mock_id}/versions",
    status_code=status.HTTP_201_CREATED,
    summary="モックの新バージョン作成",
)
async def create_version(
    mock_id: str, body: MockVersionCreate, session: SessionDep, user: UserDep
) -> dict[str, MockResponse]:
    created = await svc.create_version(session, actor_id=user.id, mock_id=mock_id, data=body)
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mock not found")
    return {"data": created}


@router.post(
    "/mocks/generate",
    status_code=status.HTTP_201_CREATED,
    summary="新規モック生成 = ワンダ (AI) による新規作成 (GAP-138)",
    responses={503: {"description": "LLM 実行経路が使えない (Bridge オフライン等)"}},
)
async def generate_mock(
    body: MockGenerateRequest, session: SessionDep, user: UserDep
) -> dict[str, MockResponse]:
    """指示文から 1 画面のモックを新規生成する (mockdb 保存・同名画面は版連鎖)。

    LLM は relay (本人の Claude サブスク) → agent_sdk → API → fake の
    費用順チェーン (GAP-138 — 確定アーキテクチャに整合)。
    """
    from src.services.mocks import generate as generate_svc
    from src.services.mocks import revise as revise_svc

    try:
        created = await generate_svc.generate_mock(
            session,
            actor_id=user.id,
            project_id=body.project_id,
            instruction=body.instruction,
            screen_name=body.screen_name,
        )
    except revise_svc.MockReviseError as exc:
        if exc.code in ("llm_unconfigured", "bridge_offline"):
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    return {"data": created}


@router.post(
    "/mocks/{mock_id}/revise",
    status_code=status.HTTP_201_CREATED,
    summary="編集 = ワンダ (AI) への修正依頼 → 新バージョン生成 (GAP-024 / Open Design パターン)",
    responses={503: {"description": "LLM または storage が未設定"}},
)
async def revise_mock(
    mock_id: str, body: MockReviseRequest, session: SessionDep, user: UserDep
) -> dict[str, MockResponse]:
    from src.services.mocks import revise as revise_svc

    try:
        created = await revise_svc.revise_mock(
            session, actor_id=user.id, mock_id=mock_id, instruction=body.instruction
        )
    except revise_svc.MockReviseError as exc:
        if exc.code in ("llm_unconfigured", "bridge_offline"):
            # GAP-138: Bridge オフラインも「実行経路が無い」— 黙って API 課金に落とさない
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        if exc.code == "too_large":
            raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mock not found")
    return {"data": created}


@router.post(
    "/mocks/{mock_id}/duplicate",
    status_code=status.HTTP_201_CREATED,
    summary="バージョン複製 (GAP-024 — 「…」メニュー)",
)
async def duplicate_mock_version(
    mock_id: str, session: SessionDep, user: UserDep
) -> dict[str, MockResponse]:
    created = await svc.duplicate_version(session, actor_id=user.id, mock_id=mock_id)
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mock not found")
    return {"data": created}


@router.post(
    "/mocks/{mock_id}/discard",
    summary="バージョン破棄 (GAP-024 — 唯一の生存バージョンは 409)",
)
async def discard_mock_version(
    mock_id: str, session: SessionDep, user: UserDep
) -> dict[str, dict[str, str]]:
    try:
        ok = await svc.discard_version(session, actor_id=user.id, mock_id=mock_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mock not found")
    return {"data": {"mock_id": mock_id, "status": "discarded"}}
