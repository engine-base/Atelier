"""議事録 transcription worker — queued キューの消費者 (GAP-016 解消)。

queue_transcribe が external_uploads に置く `transcripts/queued/{id}.json`
(parse_result_path) を実際に消費するバックエンドジョブ。T-A-38 は API 層のみを
scope しており消費者が全リポジトリに不在だった (通し検証 GAP-016 で確定)。

フロー (1 件ごと):
  1. storage から音声/動画を署名付き URL でダウンロード
  2. 文字起こし (GAP-181: 既定は OSS ローカルの faster-whisper。OpenAI Whisper API は
     ATELIER_ALLOW_WHISPER_API=1 を明示したときだけ)
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
    """文字起こしする (GAP-181: 既定は OSS ローカルの faster-whisper)。

    経路の判断は services/meetings/stt.py に一本化してある。使えないときは
    偽の成功を作らず TranscribeWorkerError にして parse_error に残す。
    """
    from src.services.meetings import stt

    try:
        return await stt.transcribe(media, file_name=file_name, mime_type=mime_type)
    except stt.STTUnavailable as exc:
        raise TranscribeWorkerError(exc.code, exc.message) from exc


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
            "select id, storage_path, file_name, mime_type, parse_result_path, "
            "uploaded_by_user_id "
            "from public.external_uploads "
            "where parsed_at is null and parse_error is null and deleted_at is null "
            "and parse_result_path like :prefix "
            "order by created_at asc limit :lim"
        ),
        {"prefix": f"{_QUEUED_PREFIX}%", "lim": limit},
    )
    return list(res.all())


async def _analyze_result(result: dict[str, Any], *, actor_id: str = "") -> dict[str, Any]:
    """GAP-015: 文字起こしに構造化解析を追記する。

    解析は additive — 失敗しても transcription 自体は成功のまま、
    analysis_error に分類コードを残す (UI は誠実に「解析未実行」を出す)。

    GAP-177: 解析はアップロードした本人の Claude サブスク (Bridge) で走る。
    バッチが回った時に本人の PC が落ちていることは普通にあるので、その場合は
    `analysis_error` に再試行可能なコードを残し、呼び出し側が行を保留にして
    後で解析だけやり直す。**解析が永久に欠ける状態を作らない。**
    """
    from src.services.meetings.analysis import AnalysisError, analyze_transcript

    transcript = str(result.get("text") or "")
    if not transcript.strip():
        return {**result, "analysis_error": "empty_transcript"}
    try:
        analysis = await analyze_transcript(transcript, actor_id=actor_id)
    except AnalysisError as e:
        logger.info("transcript analysis skipped: %s", e.code)
        return {**result, "analysis_error": e.code}
    except Exception:
        logger.exception("transcript analysis failed unexpectedly")
        return {**result, "analysis_error": "unexpected"}
    return {**result, "analysis": analysis}


def _analysis_retryable(result: dict[str, Any]) -> bool:
    """この結果は「後でやり直せば解析できる」状態か (GAP-177)。"""
    from src.services.meetings.analysis import RETRYABLE_CODES

    return str(result.get("analysis_error") or "") in RETRYABLE_CODES


async def _download_result(result_path: str) -> dict[str, Any]:
    """保存済みの結果 JSON を取り出す (解析だけの再実行に使う — GAP-177)。"""
    api_url = _require_env("ATELIER_SUPABASE_ADMIN_API_URL").rstrip("/")
    service_key = _require_env("ATELIER_SUPABASE_SERVICE_ROLE_KEY")
    bucket, obj = result_path.split("/", 1)
    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.get(
            f"{api_url}/storage/v1/object/{bucket}/{obj}",
            headers={"Authorization": f"Bearer {service_key}", "apikey": service_key},
        )
    if r.status_code >= 400:
        raise TranscribeWorkerError(
            "storage_download_failed", f"result download failed: {r.status_code}"
        )
    parsed: dict[str, Any] = json.loads(r.content.decode("utf-8"))
    return parsed


async def list_analysis_pending(session: AsyncSession, *, limit: int = BATCH_LIMIT) -> list[Any]:
    """解析だけ保留になっている行 (GAP-177)。文字起こしは終わっている。"""
    res = await session.execute(
        text(
            "select id, parse_result_path, uploaded_by_user_id "
            "from public.external_uploads "
            "where analysis_pending_since is not null and deleted_at is null "
            "order by analysis_pending_since asc limit :lim"
        ),
        {"lim": limit},
    )
    return list(res.all())


async def retry_analysis_one(session: AsyncSession, row: Any) -> bool:
    """保留中の 1 件について**解析だけ**やり直す (文字起こしは再実行しない)。

    成功したら保留を解除する。まだ Bridge が繋がっていなければ保留のまま残す。
    """
    meeting_id = str(row.id)
    result_path = str(row.parse_result_path)
    result = await _download_result(result_path)
    result.pop("analysis_error", None)
    actor_id = "" if row.uploaded_by_user_id is None else str(row.uploaded_by_user_id)
    result = await _analyze_result(result, actor_id=actor_id)
    await _upload_result(result_path, result)
    if _analysis_retryable(result):
        return False  # まだ繋がっていない — 保留のまま次回へ
    await session.execute(
        text(
            "update public.external_uploads set analysis_pending_since = null "
            "where id = cast(:id as uuid)"
        ),
        {"id": meeting_id},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="meeting.analysis.retry_complete",
            target_type="external_upload",
            actor_type="system",
            actor_id="transcribe-worker",
            target_id=meeting_id,
            after={"analysis": "analysis" in result},
        )
    )
    return True


async def transcribe_one(session: AsyncSession, row: Any) -> str:
    """キュー 1 件を処理して結果 path を返す。失敗時は例外を投げる。"""
    meeting_id = str(row.id)
    media = await _download_media(str(row.storage_path))
    result = await _call_whisper(
        media=media, file_name=str(row.file_name), mime_type=str(row.mime_type)
    )
    actor_id = (
        "" if getattr(row, "uploaded_by_user_id", None) is None else str(row.uploaded_by_user_id)
    )
    result = await _analyze_result(result, actor_id=actor_id)
    result_path = f"{_RESULT_PREFIX}{meeting_id}.json"
    await _upload_result(result_path, result)
    # GAP-177: 解析だけが「今は無理」なら保留として記録し、後で解析のみ再実行する
    # (文字起こしは完了しているので parsed_at は入れる = 二重課金・二重実行を防ぐ)。
    pending = _analysis_retryable(result)
    await session.execute(
        text(
            "update public.external_uploads "
            "set parse_result_path = :pp, parsed_at = now(), parse_error = null, "
            "analysis_pending_since = case when :pending then now() else null end "
            "where id = cast(:id as uuid)"
        ),
        {"id": meeting_id, "pp": result_path, "pending": pending},
    )
    await AuditWriter(session).write(
        AuditEvent(
            action="meeting.transcribe.complete",
            target_type="external_upload",
            actor_type="system",
            actor_id="transcribe-worker",
            target_id=meeting_id,
            after={
                "result_path": result_path,
                "model": str(result.get("model") or ""),
                "stt_provider": str(result.get("provider") or ""),
                "analysis": "analysis" in result,
            },
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

    # GAP-177: 解析だけ保留になっている行を拾って、解析のみやり直す。
    # 本人の PC が後から繋がったときに自動で埋まる (永久に欠けない)。
    retried = 0
    still_pending = 0
    for prow in await list_analysis_pending(session, limit=limit):
        try:
            if await retry_analysis_one(session, prow):
                retried += 1
            else:
                still_pending += 1
        except Exception:
            logger.exception("analysis retry failed for %s", prow.id)
            still_pending += 1
        await session.commit()

    return {
        "queued": len(rows),
        "processed": processed,
        "failed": failed,
        "analysis_retried": retried,
        "analysis_pending": still_pending,
    }


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
