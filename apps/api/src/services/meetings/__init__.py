"""議事録 (meetings) サービス層 (T-A-38)。

E-024 external_uploads を audio/video/document の議事録として扱い、
Whisper transcription をキュー登録する。実 Whisper API 呼出はバックエンド
ジョブが parse_result_path に解析結果を書込む (本層では schedule のみ)。

可視性/権限は RLS (T-D-19)。状態変更 (create / transcribe / delete) は
audit_logs に必ず記録。
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.meetings import (
    MeetingCreate,
    MeetingResponse,
    MeetingTranscribeResponse,
    MeetingUploadType,
)

_COLS = (
    "id, project_id, uploaded_by_user_id, type, storage_path, file_name, "
    "file_size_bytes, mime_type, parsed_at, parse_result_path, parse_error, "
    "deleted_at, created_at"
)


def _row_to_response(row: Any) -> MeetingResponse:
    return MeetingResponse(
        id=str(row.id),
        project_id=str(row.project_id),
        uploaded_by_user_id=str(row.uploaded_by_user_id),
        type=str(row.type),  # type: ignore[arg-type]
        storage_path=str(row.storage_path),
        file_name=str(row.file_name),
        file_size_bytes=int(row.file_size_bytes),
        mime_type=str(row.mime_type),
        parsed_at=row.parsed_at,
        parse_result_path=(None if row.parse_result_path is None else str(row.parse_result_path)),
        parse_error=(None if row.parse_error is None else str(row.parse_error)),
        deleted_at=row.deleted_at,
        created_at=row.created_at,
    )


async def list_meetings(
    session: AsyncSession,
    *,
    project_id: str | None = None,
    upload_type: MeetingUploadType | None = None,
) -> list[MeetingResponse]:
    where = ["deleted_at is null"]
    params: dict[str, object] = {}
    if project_id is not None:
        where.append("project_id = cast(:pid as uuid)")
        params["pid"] = project_id
    if upload_type is not None:
        where.append("type = cast(:tp as external_upload_type_enum)")
        params["tp"] = upload_type
    res = await session.execute(
        text(
            f"select {_COLS} from public.external_uploads "
            f"where {' and '.join(where)} order by created_at desc"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_meeting(session: AsyncSession, meeting_id: str) -> MeetingResponse | None:
    res = await session.execute(
        text(
            f"select {_COLS} from public.external_uploads "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": meeting_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_meeting(
    session: AsyncSession, *, actor_id: str, data: MeetingCreate
) -> MeetingResponse | None:
    new_id = str(uuid.uuid4())
    res = await session.execute(
        text(
            "insert into public.external_uploads "
            "(id, project_id, uploaded_by_user_id, type, storage_path, file_name, "
            "file_size_bytes, mime_type) "
            "values (cast(:id as uuid), cast(:pid as uuid), cast(:uid as uuid), "
            "cast(:tp as external_upload_type_enum), :sp, :fn, :fs, :mt) "
            "returning id"
        ),
        {
            "id": new_id,
            "pid": data.project_id,
            "uid": actor_id,
            "tp": data.type,
            "sp": data.storage_path,
            "fn": data.file_name,
            "fs": data.file_size_bytes,
            "mt": data.mime_type,
        },
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="meeting.create",
            target_type="external_upload",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={
                "project_id": data.project_id,
                "type": data.type,
                "file_name": data.file_name,
            },
        )
    )
    return await get_meeting(session, new_id)


async def queue_transcribe(
    session: AsyncSession, *, actor_id: str, meeting_id: str, force: bool
) -> MeetingTranscribeResponse | None:
    """Whisper transcription をキュー登録。

    実 Whisper API 呼出は外部バックエンドジョブが処理する (本層では
    parse_result_path を仮の予約 path に置く / parse_error をクリアする
    のみ)。force=False かつ既に parsed なら 'already_parsed' を返す。
    """
    cur = await session.execute(
        text(
            "select parsed_at, parse_result_path from public.external_uploads "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": meeting_id},
    )
    row = cur.first()
    if row is None:
        return None
    now = datetime.now(UTC)
    if row.parsed_at is not None and not force:
        return MeetingTranscribeResponse(id=meeting_id, status="already_parsed", queued_at=now)
    # キュー登録: parse_error クリア + parse_result_path を予約 path に置換
    queued_path = f"transcripts/queued/{meeting_id}.json"
    upd = await session.execute(
        text(
            "update public.external_uploads "
            "set parse_error = null, parse_result_path = :pp, parsed_at = null "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        {"id": meeting_id, "pp": queued_path},
    )
    if upd.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="meeting.transcribe.queue",
            target_type="external_upload",
            actor_type="user",
            actor_id=actor_id,
            target_id=meeting_id,
            after={"force": force, "queued_path": queued_path},
        )
    )
    return MeetingTranscribeResponse(id=meeting_id, status="queued", queued_at=now)


async def delete_meeting(session: AsyncSession, *, actor_id: str, meeting_id: str) -> bool:
    res = await session.execute(
        text(
            "update public.external_uploads set deleted_at = now() "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        {"id": meeting_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="meeting.delete",
            target_type="external_upload",
            actor_type="user",
            actor_id=actor_id,
            target_id=meeting_id,
        )
    )
    return True
