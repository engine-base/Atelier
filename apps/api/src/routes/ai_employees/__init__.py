"""AI 社員 一覧・詳細・編集 + テンプレ閲覧 ルータ (T-A-14 / T-A-15)。

/ai-employees, /ai-employees/{id}。認証は get_current_user (401)、
可視性/権限は RLS (T-D-21) + 404/403。固定 10 名のため作成/削除は無い。
T-A-15: /ai-employees/templates[/{id}] は運営側固定テンプレの read-only 閲覧。
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.ai_employees import (
    AiEmployeeResponse,
    AiEmployeeTemplateResponse,
    AiEmployeeUpdate,
    EmployeeActivityResponse,
    EmployeeIconUploadUrlRequest,
    EmployeeIconUploadUrlResponse,
    EmployeeIconUrlResponse,
)
from src.services import ai_employees as svc
from src.storage_signing import StorageSigningError, create_signed_download_url

router = APIRouter(tags=["ai-employees"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/ai-employees", summary="AI 社員一覧")
async def list_ai_employees(
    session: SessionDep,
    _user: UserDep,
    workspace_id: Annotated[str | None, Query()] = None,
) -> dict[str, list[AiEmployeeResponse]]:
    return {"data": await svc.list_ai_employees(session, workspace_id=workspace_id)}


# NOTE: /ai-employees/templates は /ai-employees/{employee_id} より前に宣言する
# (後だと employee_id="templates" として捕捉されてしまうため)。
@router.get("/ai-employees/templates", summary="AI 社員テンプレ一覧（運営側固定）")
async def list_templates(
    session: SessionDep,
    _user: UserDep,
    department: Annotated[str | None, Query()] = None,
    active_only: Annotated[bool, Query()] = True,
) -> dict[str, list[AiEmployeeTemplateResponse]]:
    return {
        "data": await svc.list_templates(session, department=department, active_only=active_only)
    }


@router.get("/ai-employees/templates/{template_id}", summary="AI 社員テンプレ詳細")
async def get_template(
    template_id: str, session: SessionDep, _user: UserDep
) -> dict[str, AiEmployeeTemplateResponse]:
    tpl = await svc.get_template(session, template_id)
    if tpl is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ai employee template not found")
    return {"data": tpl}


def _require_uuid(employee_id: str) -> None:
    """path param が UUID 形式でなければ 404 (cast エラーの 500 化を防ぐ)。"""
    try:
        uuid.UUID(employee_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ai employee not found") from exc


@router.get(
    "/ai-employees/{employee_id}/activities",
    summary="AI 社員別 活動フィード (GAP-008 / S-C02 活動履歴)",
)
async def list_employee_activities(
    employee_id: str,
    session: SessionDep,
    _user: UserDep,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> dict[str, list[EmployeeActivityResponse]]:
    if await svc.get_ai_employee(session, employee_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "employee not found")
    return {"data": await svc.list_activities(session, employee_id=employee_id, limit=limit)}


@router.post(
    "/ai-employees/{employee_id}/icon-upload-url",
    summary="アイコン画像アップロード用 署名付き URL 発行 (GAP-009 / S-C02)",
    responses={503: {"description": "storage backend が未設定"}},
)
async def create_employee_icon_upload_url(
    employee_id: str,
    body: EmployeeIconUploadUrlRequest,
    session: SessionDep,
    _user: UserDep,
) -> dict[str, EmployeeIconUploadUrlResponse]:
    """実ファイル PUT 用の署名付き URL を発行する (2 段階アップロードの 1 段目)。

    社員の可視性は RLS で強制 (不可視は 404)。確定は PATCH icon で行う。
    """
    _require_uuid(employee_id)
    if await svc.get_ai_employee(session, employee_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ai employee not found")
    try:
        result = await svc.create_icon_upload(
            employee_id=employee_id,
            file_name=body.file_name,
            mime_type=body.mime_type,
            file_size_bytes=body.file_size_bytes,
        )
    except svc.EmployeeIconError as exc:
        if exc.code == "unsupported_media_type":
            raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, exc.message) from exc
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, exc.message) from exc
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    return {"data": result}


@router.get(
    "/ai-employees/{employee_id}/icon-url",
    summary="アイコン画像の署名付き閲覧 URL (GAP-009 / S-C02)",
    responses={503: {"description": "storage backend が未設定"}},
)
async def get_employee_icon_url(
    employee_id: str, session: SessionDep, _user: UserDep
) -> dict[str, EmployeeIconUrlResponse]:
    """icon が storage path (画像) の社員の署名付き閲覧 URL を返す。

    icon が lucide 名/未設定 (path でない) は 409 — 画像は存在しない。
    """
    _require_uuid(employee_id)
    emp = await svc.get_ai_employee(session, employee_id)
    if emp is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ai employee not found")
    if not emp.icon or "/" not in emp.icon:
        raise HTTPException(status.HTTP_409_CONFLICT, "employee icon is not an uploaded image")
    try:
        url = await create_signed_download_url(emp.icon)
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    return {"data": EmployeeIconUrlResponse(url=url)}


@router.get("/ai-employees/{employee_id}", summary="AI 社員詳細")
async def get_ai_employee(
    employee_id: str, session: SessionDep, _user: UserDep
) -> dict[str, AiEmployeeResponse]:
    _require_uuid(employee_id)
    emp = await svc.get_ai_employee(session, employee_id)
    if emp is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ai employee not found")
    return {"data": emp}


@router.patch("/ai-employees/{employee_id}", summary="AI 社員編集")
async def update_ai_employee(
    employee_id: str, body: AiEmployeeUpdate, session: SessionDep, user: UserDep
) -> dict[str, AiEmployeeResponse]:
    _require_uuid(employee_id)
    if await svc.get_ai_employee(session, employee_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "ai employee not found")
    updated = await svc.update_ai_employee(
        session, actor_id=user.id, employee_id=employee_id, data=body
    )
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update ai employee")
    return {"data": updated}
