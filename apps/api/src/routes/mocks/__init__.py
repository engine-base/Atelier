"""Mock CRUD + バージョン管理 ルータ (T-A-33)。

/mocks, /mocks/{id}, /mocks/{id}/versions。認証は get_current_user (401)、
可視性/権限は RLS (T-D-17) + 404/403。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.mocks import (
    MockCreate,
    MockResponse,
    MockUpdate,
    MockVersionCreate,
)
from src.schemas.storage import ContentUrlResponse
from src.services import mocks as svc
from src.storage_signing import StorageSigningError, create_signed_download_url

router = APIRouter(tags=["mocks"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


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
    mock_id: str, session: SessionDep, _user: UserDep
) -> dict[str, ContentUrlResponse]:
    """RLS で可視な mock の html_storage_path に対する署名付き閲覧 URL を返す。"""
    mock = await svc.get_mock(session, mock_id)
    if mock is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "mock not found")
    try:
        url = await create_signed_download_url(mock.html_storage_path)
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    return {"data": ContentUrlResponse(url=url)}


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
