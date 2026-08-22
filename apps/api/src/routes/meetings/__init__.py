"""議事録 (meetings) ルータ (T-A-38)。

S-M01 議事録 / 商談アップロード画面用。E-024 external_uploads を audio /
video / document として扱い、Whisper transcription をキュー登録する。
認証 (401) + RLS (T-D-19) + 404/403。
"""

from __future__ import annotations

from typing import Annotated, NoReturn

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.errors import service_unavailable
from src.schemas.meetings import (
    MeetingAdoptableItem,
    MeetingAdoptedRef,
    MeetingAdoptRequest,
    MeetingAdoptResponse,
    MeetingCreate,
    MeetingResponse,
    MeetingTranscribeRequest,
    MeetingTranscribeResponse,
    MeetingUploadType,
    MeetingUploadUrlRequest,
    MeetingUploadUrlResponse,
)
from src.schemas.storage import ContentUrlResponse
from src.schemas.workflow import PhaseProposalResponse
from src.services import meetings as svc
from src.services.meetings import adopt as adopt_svc
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
            raise service_unavailable(exc.code, exc.message) from exc
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
            raise service_unavailable(exc.code, exc.message) from exc
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


@router.post(
    "/meetings/{meeting_id}/resume-analysis",
    summary="保留中の解析を今すぐ再開 (GAP-185)",
)
async def resume_meeting_analysis(
    meeting_id: str, session: SessionDep, user: UserDep
) -> dict[str, dict[str, str]]:
    """PC 未接続・プラン枠の上限で保留になった解析を、人の操作で再開する。

    自動では再開しない (勝手に利用者のプラン枠を使わない)。文字起こしは
    やり直さないので、二重に PC を使わせることもない。
    """
    del user  # 認証済みであることだけが要件 (RLS で可視性は担保)
    from src.services.meetings.resume import resume_analysis

    if await svc.get_meeting(session, meeting_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "meeting not found")
    result = await resume_analysis(session, meeting_id=meeting_id)
    if result.status == "not_found":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "meeting not found")
    return {"data": {"status": result.status, "message": result.message}}


# ── GAP-186: 議事録の抽出項目を「確認して採用」→ 要件・タスク・決定へ ─────
#
# 経営者指示「1,2 だね」の ①。**自動反映はしない** — AI の抽出をそのまま正に
# すると、聞き間違い・言い過ぎがプロジェクトの要件として固定されてしまう。


def _raise_adopt_error(exc: adopt_svc.AdoptError) -> NoReturn:
    code = {
        "not_found": status.HTTP_404_NOT_FOUND,
        "invalid_state": status.HTTP_409_CONFLICT,
        "too_many": status.HTTP_409_CONFLICT,
    }.get(exc.code, status.HTTP_400_BAD_REQUEST)
    raise HTTPException(code, exc.message)


@router.get(
    "/meetings/{meeting_id}/adoptable",
    summary="議事録から採用できる項目 (GAP-186)",
)
async def list_adoptable_items(
    meeting_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[MeetingAdoptableItem]]:
    """要件・アクション・決定事項・未決事項を、採用済みの印つきで返す。

    リスク・数値・議題は「読むためのもの」なので反映先を持たない
    (無理にタスク化すると台帳がノイズで埋まる)。
    """
    if await svc.get_meeting(session, meeting_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "meeting not found")
    try:
        items = await adopt_svc.list_adoptable(session, meeting_id=meeting_id)
    except adopt_svc.AdoptError as exc:
        _raise_adopt_error(exc)
    return {
        "data": [
            MeetingAdoptableItem(
                kind=i.kind,  # pyright: ignore[reportArgumentType]
                key=i.key,
                title=i.title,
                detail=i.detail,
                quote=i.quote,
                meta=i.meta,
                adopted=i.adopted,
                target_type=i.target_type,  # pyright: ignore[reportArgumentType]
                target_id=i.target_id,
            )
            for i in items
        ]
    }


@router.post(
    "/meetings/{meeting_id}/adopt",
    summary="選んだ項目を要件・タスク・決定に反映 (GAP-186)",
)
async def adopt_items(
    meeting_id: str,
    body: MeetingAdoptRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, MeetingAdoptResponse]:
    """人がチェックした項目だけを実データに落とす。

    すでに採用済みのものは作り直さない (二重に増やさない)。1 件の失敗で
    全部を落とさず、できたものは残して結果を正直に返す。
    """
    if await svc.get_meeting(session, meeting_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "meeting not found")
    try:
        result = await adopt_svc.adopt(
            session, meeting_id=meeting_id, actor_id=user.id, keys=list(body.keys)
        )
    except adopt_svc.AdoptError as exc:
        await session.rollback()
        _raise_adopt_error(exc)
    await session.commit()
    return {
        "data": MeetingAdoptResponse(
            created=[MeetingAdoptedRef(**c) for c in result.created],
            already=result.already,
            missing=result.missing,
            message=result.message,
        )
    }


@router.post(
    "/meetings/{meeting_id}/propose-phase",
    summary="この打合せを根拠に次フェーズを提案 (GAP-187)",
)
async def propose_phase_from_meeting(
    meeting_id: str, session: SessionDep, user: UserDep
) -> dict[str, PhaseProposalResponse]:
    """議事録の決定・要件・未決事項を根拠に、次に確定すべきフェーズを 1 つ提案する。

    **提案するだけで確定はしない** — 承認は既存のフェーズ提案フロー (GAP-150)
    と同じで、人が承認して初めてフェーズになる。

    AI 実行は利用者の PC の Claude (Bridge) で走る。経路が無いときは嘘の提案を
    作らず、そのまま誠実にエラーを返す。
    """
    from src.services.workflow import proposals as proposal_svc

    if await svc.get_meeting(session, meeting_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "meeting not found")
    try:
        created = await proposal_svc.propose_from_meeting(
            session, actor_id=user.id, meeting_id=meeting_id
        )
    except ValueError:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "このプロジェクトには未処理のフェーズ提案があります。先に承認か却下をしてください。",
        ) from None
    except proposal_svc.PhaseProposalError as exc:
        if exc.code == "analysis_missing":
            raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
        # GAP-206: 503 は理由つきで返す (bridge_offline / llm_unconfigured 等)。
        raise service_unavailable(exc.code, exc.message) from exc
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "meeting not found")
    await session.commit()
    return {"data": created}


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
