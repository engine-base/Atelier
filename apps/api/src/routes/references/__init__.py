"""参考資料アップロード ルータ — GAP-161。

経営者指摘「デザインモックも、このテンプレもだけど画像や PDF やファイルや
エクセルをアップロードしてそれを参考にすることがチャットでできていない」。

チャット添付 (thread 紐づき) と同じ storage・同じ制限 (形式/サイズ) を使い、
スタジオからの参考資料に署名付きアップロード URL を発行する。
発行された storage_path を改訂/生成リクエストに添えると、サーバー側で
テキスト抽出して AI の prompt に入る (services/attachments)。
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status

from src.dependencies import CurrentUser, get_current_user
from src.errors import service_unavailable
from src.schemas.references import ReferenceUploadRequest, ReferenceUploadResponse
from src.services.chat import ATTACHMENT_ALLOWED_MIME, ATTACHMENT_MAX_BYTES
from src.storage_signing import (
    StorageSigningError,
    create_signed_upload_url,
    sanitize_object_filename,
)
from src.user_messages import user_detail

router = APIRouter(tags=["references"])

UserDep = Annotated[CurrentUser, Depends(get_current_user)]

REFERENCE_BUCKET = "reference-uploads"


@router.post(
    "/reference-uploads",
    summary="参考資料の署名付きアップロード URL (GAP-161 — スタジオの資料参照)",
    responses={
        413: {"description": "サイズ超過"},
        415: {"description": "未対応の形式"},
        503: {"description": "storage 未設定"},
    },
)
async def create_reference_upload_url(
    body: ReferenceUploadRequest, user: UserDep
) -> dict[str, ReferenceUploadResponse]:
    if body.mime_type not in ATTACHMENT_ALLOWED_MIME:
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            f"未対応の形式です: {body.mime_type}",
        )
    if body.file_size_bytes > ATTACHMENT_MAX_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"1 ファイル {ATTACHMENT_MAX_BYTES // (1024 * 1024)}MB 以下にしてください",
        )
    object_path = f"{user.id}/{uuid.uuid4()}/{sanitize_object_filename(body.file_name)}"
    storage_path = f"{REFERENCE_BUCKET}/{object_path}"
    try:
        upload_url = await create_signed_upload_url(storage_path)
    except StorageSigningError as exc:
        # GAP-206: 保存先の未設定を「パソコン未接続」と誤読させないため理由を載せる。
        raise service_unavailable(exc.code, user_detail(exc)) from exc
    return {"data": ReferenceUploadResponse(upload_url=upload_url, storage_path=storage_path)}
