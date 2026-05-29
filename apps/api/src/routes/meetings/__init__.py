"""議事録 (meetings) ルータ (T-A-38)。

S-M01 議事録 / 商談アップロード画面用。E-024 external_uploads を audio /
video / document として扱い、Whisper transcription をキュー登録する。
認証 (401) + RLS (T-D-19) + 404/403。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.meetings import (
    MeetingCreate,
    MeetingResponse,
    MeetingTranscribeRequest,
    MeetingTranscribeResponse,
    MeetingUploadType,
)
from src.services import meetings as svc

router = APIRouter(tags=["meetings"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/meetings", summary="議事録アップロード一覧")
async def list_meetings(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
    type: Annotated[MeetingUploadType | None, Query()] = None,
) -> dict[str, list[MeetingResponse]]:
    return {"data": await svc.list_meetings(session, project_id=project_id, upload_type=type)}


@router.post("/meetings", status_code=status.HTTP_201_CREATED, summary="議事録アップロード登録")
async def create_meeting(
    body: MeetingCreate, session: SessionDep, user: UserDep
) -> dict[str, MeetingResponse]:
    created = await svc.create_meeting(session, actor_id=user.id, data=body)
    if created is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to create meeting upload")
    return {"data": created}


@router.get("/meetings/{meeting_id}", summary="議事録取得")
async def get_meeting(
    meeting_id: str, session: SessionDep, _user: UserDep
) -> dict[str, MeetingResponse]:
    meeting = await svc.get_meeting(session, meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "meeting not found")
    return {"data": meeting}


@router.post(
    "/meetings/{meeting_id}/transcribe",
    status_code=status.HTTP_202_ACCEPTED,
    summary="議事録 Whisper transcription キュー登録",
)
async def transcribe_meeting(
    meeting_id: str,
    body: MeetingTranscribeRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, MeetingTranscribeResponse]:
    if await svc.get_meeting(session, meeting_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "meeting not found")
    result = await svc.queue_transcribe(
        session, actor_id=user.id, meeting_id=meeting_id, force=body.force
    )
    if result is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to transcribe meeting")
    return {"data": result}


@router.delete(
    "/meetings/{meeting_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="議事録削除（論理）",
)
async def delete_meeting(meeting_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_meeting(session, meeting_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "meeting not found")
    if not await svc.delete_meeting(session, actor_id=user.id, meeting_id=meeting_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to delete meeting")
