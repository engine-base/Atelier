"""成果物 (workflow_outputs) ルータ (T-A-21)。

/outputs[/{id}]。認証 (401) + RLS (T-D-21) + 404。read のみ。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.outputs import OutputResponse
from src.schemas.storage import ContentUrlResponse
from src.services import outputs as svc
from src.storage_signing import StorageSigningError, create_signed_download_url

router = APIRouter(tags=["outputs"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/outputs", summary="成果物一覧")
async def list_outputs(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
    phase_id: Annotated[str | None, Query()] = None,
    stage: Annotated[str | None, Query()] = None,
) -> dict[str, list[OutputResponse]]:
    return {
        "data": await svc.list_outputs(
            session, project_id=project_id, phase_id=phase_id, stage=stage
        )
    }


@router.get("/outputs/{output_id}", summary="成果物取得")
async def get_output(
    output_id: str, session: SessionDep, _user: UserDep
) -> dict[str, OutputResponse]:
    out = await svc.get_output(session, output_id)
    if out is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    return {"data": out}


@router.get(
    "/outputs/{output_id}/content-url",
    summary="成果物 HTML の署名付き閲覧 URL",
    responses={503: {"description": "storage backend が未設定"}},
)
async def get_output_content_url(
    output_id: str, session: SessionDep, _user: UserDep
) -> dict[str, ContentUrlResponse]:
    """RLS で可視な output の html_path に対する署名付き閲覧 URL を返す。"""
    out = await svc.get_output(session, output_id)
    if out is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    if out.html_path is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "output has no rendered HTML yet")
    try:
        url = await create_signed_download_url(out.html_path)
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    return {"data": ContentUrlResponse(url=url)}
