"""Supabase Storage 署名付きダウンロード URL 発行（共有ヘルパー）。

storage_path は `{bucket}/{object_path}` 形式（先頭セグメントが bucket）。
これは meetings の署名付きアップロード（services/meetings::create_signed_upload）や
実データ（例: "outputs/estimate-v2.html" / "mocks/login-v1.html" /
"transcripts/queued/{id}.json"）の規約と一致する。

service_role key で `POST /storage/v1/object/sign/{bucket}/{object}` を叩き、
一時的に閲覧可能な署名付き URL を返す。storage 未設定（dev/test 等）では
StorageSigningError("storage_unconfigured") を投げる。
"""

from __future__ import annotations

import os
from typing import Any

import httpx

# 署名付き URL の有効期限（秒）。
SIGNED_URL_TTL_S = 60 * 60


class StorageSigningError(Exception):
    """署名付き URL 発行時のエラー。code で分岐する。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _split_bucket(storage_path: str) -> tuple[str, str]:
    """`{bucket}/{object}` を (bucket, object) に分割する。"""
    parts = storage_path.split("/", 1)
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise StorageSigningError(
            "invalid_storage_path", f"storage_path must be '<bucket>/<object>': {storage_path!r}"
        )
    return parts[0], parts[1]


async def create_signed_download_url(storage_path: str) -> str:
    """storage_path に対する署名付きダウンロード URL を発行する。"""
    api_url = os.environ.get("ATELIER_SUPABASE_ADMIN_API_URL")
    service_key = os.environ.get("ATELIER_SUPABASE_SERVICE_ROLE_KEY")
    if not api_url or not service_key:
        raise StorageSigningError("storage_unconfigured", "storage backend is not configured")

    bucket, obj = _split_bucket(storage_path)
    base = api_url.rstrip("/")
    async with httpx.AsyncClient(timeout=20.0) as client:
        r = await client.post(
            f"{base}/storage/v1/object/sign/{bucket}/{obj}",
            headers={
                "Authorization": f"Bearer {service_key}",
                "apikey": service_key,
                "Content-Type": "application/json",
            },
            json={"expiresIn": SIGNED_URL_TTL_S},
        )
    if r.status_code >= 400:
        raise StorageSigningError(
            "storage_sign_failed", f"failed to sign download url: {r.status_code} {r.text[:200]}"
        )
    body: dict[str, Any] = r.json()
    signed = body.get("signedURL") or body.get("signedUrl")
    if not isinstance(signed, str) or not signed:
        raise StorageSigningError("storage_sign_failed", "missing signedURL in storage response")
    return f"{base}/storage/v1{signed if signed.startswith('/') else '/' + signed}"
