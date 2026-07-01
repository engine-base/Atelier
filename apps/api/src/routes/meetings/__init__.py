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
    MeetingUploadUrlRequest,
    MeetingUploadUrlResponse,
)
from src.schemas.storage import ContentUrlResponse
from src.services import meetings as svc
from src.storage_signing import StorageSigningError, create_signed_download_url

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


@router.post(
    "/meetings/upload-url",
    summary="議事録アップロード用 署名付き URL 発行",
    responses={503: {"description": "storage backend が未設定"}},
)
async def create_meeting_upload_url(
    body: MeetingUploadUrlRequest, _user: UserDep
) -> dict[str, MeetingUploadUrlResponse]:
    """実ファイル PUT 用の署名付き URL を発行する（2 段階アップロードの 1 段目）。

    プロジェクトへのアクセス権は後続 POST /meetings の RLS で最終的に強制される。
    storage 未設定環境では 503 を返す。
    """
    try:
        result = await svc.create_signed_upload(
            project_id=body.project_id, file_name=body.file_name, mime_type=body.mime_type
        )
    except svc.MeetingUploadError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    return {"data": result}


@router.get("/meetings/{meeting_id}", summary="議事録取得")
async def get_meeting(
    meeting_id: str, session: SessionDep, _user: UserDep
) -> dict[str, MeetingResponse]:
    meeting = await svc.get_meeting(session, meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "meeting not found")
    return {"data": meeting}


@router.get(
    "/meetings/{meeting_id}/transcript-url",
    summary="議事録 文字起こし結果の署名付き閲覧 URL",
    responses={503: {"description": "storage backend が未設定"}},
)
async def get_meeting_transcript_url(
    meeting_id: str, session: SessionDep, _user: UserDep
) -> dict[str, ContentUrlResponse]:
    """RLS で可視な meeting の parse_result_path に対する署名付き閲覧 URL を返す。"""
    meeting = await svc.get_meeting(session, meeting_id)
    if meeting is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "meeting not found")
    if meeting.parse_result_path is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "transcription result is not ready yet")
    try:
        url = await create_signed_download_url(meeting.parse_result_path)
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    return {"data": ContentUrlResponse(url=url)}


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
