"""議事録 (meeting uploads) API スキーマ (T-A-38)。

E-024 external_uploads (type='audio' / 'video' / 'document') を議事録専用に
扱う。Whisper transcription はサービス層でキューイング (parse_result_path に
書込) するが本層では非同期 job として scheduling のみ。
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

MeetingUploadType = Literal["audio", "video", "document"]


class MeetingCreate(BaseModel):
    """議事録アップロードを登録する。

    storage_path は Supabase Storage 上の path (uploads/.../foo.m4a)。
    本 API は実バイト受信ではなく、メタデータ登録のみを担当する。
    """

    project_id: str
    type: MeetingUploadType
    storage_path: str = Field(min_length=1, max_length=500)
    file_name: str = Field(min_length=1, max_length=255)
    file_size_bytes: int = Field(ge=0)
    mime_type: str = Field(min_length=1, max_length=200)


class MeetingResponse(BaseModel):
    id: str
    project_id: str
    uploaded_by_user_id: str
    type: MeetingUploadType
    storage_path: str
    file_name: str
    file_size_bytes: int
    mime_type: str
    parsed_at: datetime | None
    parse_result_path: str | None
    parse_error: str | None
    deleted_at: datetime | None
    created_at: datetime


class MeetingTranscribeRequest(BaseModel):
    """transcription トリガ。force=True なら既に解析済でも再実行をキュー。"""

    force: bool = False


class MeetingTranscribeResponse(BaseModel):
    """transcription キュー登録結果。

    actual Whisper API 呼出はバックエンドジョブが担当 (本 API では schedule のみ)。
    status: queued / already_parsed (再解析しない場合)。
    """

    id: str
    status: Literal["queued", "already_parsed"]
    queued_at: datetime
