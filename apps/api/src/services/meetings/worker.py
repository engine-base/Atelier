"""議事録 transcription worker — queued キューの消費者 (GAP-016 解消)。

queue_transcribe が external_uploads に置く `transcripts/queued/{id}.json`
(parse_result_path) を実際に消費するバックエンドジョブ。T-A-38 は API 層のみを
scope しており消費者が全リポジトリに不在だった (通し検証 GAP-016 で確定)。

フロー (1 件ごと):
  1. storage から音声/動画を署名付き URL でダウンロード
  2. OpenAI Whisper API (selected-stack#stt) で文字起こし
  3. 結果 JSON を storage `transcripts/results/{id}.json` へアップロード
  4. external_uploads.parse_result_path を結果 path に差替え + parsed_at 打刻
  5. audit_logs へ meeting.transcribe.complete (actor_type=system)

失敗時は parse_error に記録し (queue から除外)、meeting.transcribe.error を
audit する。force 再キュー (queue_transcribe force=True) が parse_error を
クリアするので再試行はユーザー操作起点で成立する。

起動経路は 2 つ (どちらも本モジュールの run_once を呼ぶ):
  - Inngest cron `transcribe-queue` (毎分, src/cron/scheduler.py)
  - 単独プロセス: `python -m src.services.meetings.worker` (dev / Inngest 無し環境)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from typing import Any

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.storage_signing import create_signed_download_url

logger = logging.getLogger(__name__)

# Whisper API 呼出設定 (selected-stack#stt = OpenAI Whisper API)。
WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions"
WHISPER_MODEL = os.environ.get("ATELIER_WHISPER_MODEL", "whisper-1")

# 1 回の run_once で処理する最大件数 (長時間ロックを避ける)。
BATCH_LIMIT = 5

# parse_error への保存上限 (カラムを無限に太らせない)。
_ERROR_MAX_LEN = 500

_QUEUED_PREFIX = "transcripts/queued/"
_RESULT_PREFIX = "transcripts/results/"


class TranscribeWorkerError(Exception):
    """worker 内の分類済みエラー。code で audit / parse_error に残す。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise TranscribeWorkerError("env_unconfigured", f"{name} is not configured")
    return value


async def _download_media(storage_path: str) -> bytes:
    """storage から対象メディアをダウンロードする。"""
    url = await create_signed_download_url(storage_path)
    async with httpx.AsyncClient(timeout=120.0) as client:
        r = await client.get(url)
    if r.status_code >= 400:
        raise TranscribeWorkerError(
            "storage_download_failed", f"download failed: {r.status_code} {r.text[:200]}"
        )
    return r.content


async def _call_whisper(*, media: bytes, file_name: str, mime_type: str) -> dict[str, Any]:
    """OpenAI Whisper API で文字起こしする (response_format=verbose_json)。"""
    api_key = _require_env("ATELIER_OPENAI_API_KEY")
    async with httpx.AsyncClient(timeout=600.0) as client:
        r = await client.post(
            WHISPER_API_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            files={"file": (file_name, media, mime_type)},
            data={"model": WHISPER_MODEL, "response_format": "verbose_json"},
        )
    if r.status_code >= 400:
        raise TranscribeWorkerError(
            "whisper_failed", f"whisper api failed: {r.status_code} {r.text[:200]}"
        )
    body: dict[str, Any] = r.json()
    return body


async def _upload_result(result_path: str, payload: dict[str, Any]) -> None:
    """結果 JSON を storage へアップロードする (`{bucket}/{object}` 規約)。"""
    api_url = _require_env("ATELIER_SUPABASE_ADMIN_API_URL").rstrip("/")
    service_key = _require_env("ATELIER_SUPABASE_SERVICE_ROLE_KEY")
    bucket, obj = result_path.split("/", 1)
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(
            f"{api_url}/storage/v1/object/{bucket}/{obj}",
            headers={
                "Authorization": f"Bearer {service_key}",
                "apikey": service_key,
                "Content-Type": "application/json",
                # 再実行 (force 再キュー) で同 path に上書きできるようにする。
                "x-upsert": "true",
            },
            content=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        )
    if r.status_code >= 400:
        raise TranscribeWorkerError(
            "storage_upload_failed", f"result upload failed: {r.status_code} {r.text[:200]}"
        )


async def list_queued(session: AsyncSession, *, limit: int = BATCH_LIMIT) -> list[Any]:
    """未処理キュー行を古い順に取得する。

    queue の定義 = parse_result_path が queued/ 配下 かつ parsed_at が null かつ
    parse_error が null (エラー行は force 再キューまで再試行しない)。
    """
    res = await session.execute(
        text(
            "select id, storage_path, file_name, mime_type, parse_result_path "
            "from public.external_uploads "
            "where parsed_at is null and parse_error is null and deleted_at is null "
            "and parse_result_path like :prefix "
            "order by created_at asc limit :lim"
        ),
        {"prefix": f"{_QUEUED_PREFIX}%", "lim": limit},
    )
    return list(res.all())


async def transcribe_one(session: AsyncSession, row: Any) -> str:
    """キュー 1 件を処理して結果 path を返す。失敗時は例外を投げる。"""
    meeting_id = str(row.id)
    media = await _download_media(str(row.storage_path))
    result = await _call_whisper(
        media=media, file_name=str(row.file_name), mime_type=str(row.mime_type)
    )
    result_path = f"{_RESULT_PREFIX}{meeting_id}.json"
    await _upload_result(result_path, result)
    await session.execute(
        text(
            "update public.external_uploads "
            "set parse_result_path = :pp, parsed_at = now(), parse_error = null "
            "where id = cast(:id as uuid)"
        ),
        {"id": meeting_id, "pp": result_path},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="meeting.transcribe.complete",
            target_type="external_upload",
            actor_type="system",
            actor_id="transcribe-worker",
            target_id=meeting_id,
            after={"result_path": result_path, "model": WHISPER_MODEL},
        )
    )
    return result_path


async def _mark_failed(session: AsyncSession, meeting_id: str, error: Exception) -> None:
    code = error.code if isinstance(error, TranscribeWorkerError) else "unexpected"
    message = f"{code}: {error}"[:_ERROR_MAX_LEN]
    await session.execute(
        text("update public.external_uploads set parse_error = :err where id = cast(:id as uuid)"),
        {"id": meeting_id, "err": message},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="meeting.transcribe.error",
            target_type="external_upload",
            actor_type="system",
            actor_id="transcribe-worker",
            target_id=meeting_id,
            after={"error": message},
        )
    )


async def run_once(session: AsyncSession, *, limit: int = BATCH_LIMIT) -> dict[str, int]:
    """キューを 1 巡処理する。Inngest handler / 単独ループ共通の本体。"""
    rows = await list_queued(session, limit=limit)
    processed = 0
    failed = 0
    for row in rows:
        try:
            await transcribe_one(session, row)
            processed += 1
        except Exception as exc:
            logger.exception("transcribe failed for %s", row.id)
            await _mark_failed(session, str(row.id), exc)
            failed += 1
        await session.commit()
    return {"queued": len(rows), "processed": processed, "failed": failed}


async def run_loop(*, poll_interval_s: float, once: bool) -> None:
    """単独プロセス実行 (dev / Inngest 無し環境用のポーリングループ)。"""
    from src.db import create_engine, create_session_factory

    factory = create_session_factory(create_engine())
    while True:
        async with factory() as session:
            result = await run_once(session)
        if result["queued"]:
            logger.info("transcribe-queue: %s", result)
        if once:
            return
        await asyncio.sleep(poll_interval_s)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="Atelier transcribe queue worker")
    parser.add_argument("--once", action="store_true", help="1 巡だけ処理して終了する")
    parser.add_argument(
        "--interval",
        type=float,
        default=float(os.environ.get("ATELIER_TRANSCRIBE_POLL_S", "15")),
        help="ポーリング間隔秒 (default: 15 / env ATELIER_TRANSCRIBE_POLL_S)",
    )
    args = parser.parse_args()
    asyncio.run(run_loop(poll_interval_s=args.interval, once=args.once))


if __name__ == "__main__":
    main()
