"""GAP-156: 既存プロジェクトの途中取り込み — 既存資料をツール形式へ変換投入。

経営者すり合わせ: 「既存プロジェクトのアップロードで途中からでも。既存資料を
ツールの形式に当てはめられる状態に」

設計:
  - Bridge のチャット成果物取り込み (GAP-137/139/145) と同じ変換機構を、
    Web からの一括アップロードに開放する。HTML はモック/成果物へ自動仕分け、
    画像/PPTX/PDF/Excel 等のバイナリは filedb 成果物へ、Markdown/テキストは
    HTML に包んで成果物へ (すべて active フェーズにスタンプ — GAP-152)。
  - 取り込めた資料の種類 (stage) から「もう終わっている工程」を導出して提案
    (suggested_stage_keys)。**フローへの反映はユーザー確定** — UI が既存の
    flow complete API を叩く (勝手に完了へ倒さない)。
  - 一括 UX のため 1 ファイルの失敗で全体を落とさない — per-file の honest
    エラーを返す (形式非対応・サイズ超過など)。
"""

from __future__ import annotations

import base64
import html as html_mod

from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter

MAX_IMPORT_FILES = 30

_TEXT_EXTS = ("md", "markdown", "txt")
_HTML_EXTS = ("html", "htm")


class ImportFile(BaseModel):
    file_name: str = Field(min_length=1, max_length=300)
    content_b64: str = Field(min_length=1)


class ImportRequest(BaseModel):
    files: list[ImportFile] = Field(min_length=1, max_length=MAX_IMPORT_FILES)
    note: str = Field(default="", max_length=500)


class ImportItemResult(BaseModel):
    file_name: str
    # ok 時: type = mock / output / file、失敗時: error に honest な理由
    type: str | None = None
    title: str | None = None
    stage: str | None = None
    version: int | None = None
    target_id: str | None = None
    error: str | None = None


class ImportResult(BaseModel):
    results: list[ImportItemResult]
    imported: int
    failed: int
    # 取り込めた資料から導出した「完了済みでは？」の工程 (ユーザー確定用)
    suggested_stage_keys: list[str]


def _ext(file_name: str) -> str:
    base = file_name.rsplit("/", 1)[-1]
    return base.rsplit(".", 1)[-1].lower() if "." in base else ""


def _wrap_text_as_html(file_name: str, text_body: str) -> str:
    """Markdown/テキストを閲覧可能な HTML に包む (内容は変えない — 変換偽装なし)。"""
    base = file_name.rsplit("/", 1)[-1]
    title = html_mod.escape(base.rsplit(".", 1)[0][:120] or base)
    body = html_mod.escape(text_body)
    return (
        '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
        f"<title>{title}</title></head><body>"
        f'<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;'
        f'line-height:1.7;max-width:860px;margin:24px auto;padding:0 16px;">{body}</pre>'
        "</body></html>"
    )


async def import_files(
    session: AsyncSession,
    *,
    actor_id: str,
    project_id: str,
    data: ImportRequest,
) -> ImportResult:
    """既存資料の一括取り込み (service session — mockdb/filedb 書込を含むため)。

    呼び出し側 (route) が RLS でプロジェクト可視性を確認してから渡す契約。
    """
    from src.services.mocks.artifacts import (
        ARTIFACT_KIND_MOCK,
        ArtifactIngestError,
        classify_artifact,
        classify_file_stage,
        ingest_file_artifact,
        ingest_html_artifact,
        ingest_html_output,
    )

    instruction = f"既存プロジェクト資料の取り込み。{data.note}".strip()
    results: list[ImportItemResult] = []
    stages_seen: set[str] = set()
    any_mock = False
    for f in data.files:
        try:
            raw = base64.b64decode(f.content_b64, validate=True)
        except Exception:
            results.append(ImportItemResult(file_name=f.file_name, error="content_b64 が不正です"))
            continue
        ext = _ext(f.file_name)
        try:
            if ext in _HTML_EXTS:
                html = raw.decode("utf-8", errors="replace")
                kind = classify_artifact(file_name=f.file_name, html=html, instruction=instruction)
                if kind == ARTIFACT_KIND_MOCK:
                    ingested = await ingest_html_artifact(
                        session,
                        project_id=project_id,
                        file_name=f.file_name,
                        html=html,
                        source="import",
                        actor_label=actor_id,
                    )
                    any_mock = True
                    results.append(
                        ImportItemResult(
                            file_name=f.file_name,
                            type="mock",
                            title=ingested["screen_name"],
                            stage="design",
                            version=int(ingested["version"]),
                            target_id=ingested["mock_id"],
                        )
                    )
                else:
                    ingested = await ingest_html_output(
                        session,
                        project_id=project_id,
                        file_name=f.file_name,
                        html=html,
                        stage=kind,
                        source="import",
                        actor_label=actor_id,
                    )
                    stages_seen.add(kind)
                    results.append(
                        ImportItemResult(
                            file_name=f.file_name,
                            type="output",
                            title=str(ingested.get("title")),
                            stage=kind,
                            version=int(str(ingested.get("version") or 1)),
                            target_id=str(ingested.get("output_id")),
                        )
                    )
            elif ext in _TEXT_EXTS:
                text_body = raw.decode("utf-8", errors="replace")
                stage = classify_file_stage(
                    file_name=f.file_name, instruction=instruction, file_kind="doc"
                )
                ingested = await ingest_html_output(
                    session,
                    project_id=project_id,
                    file_name=f.file_name,
                    html=_wrap_text_as_html(f.file_name, text_body),
                    stage=stage,
                    source="import",
                    actor_label=actor_id,
                )
                stages_seen.add(stage)
                results.append(
                    ImportItemResult(
                        file_name=f.file_name,
                        type="output",
                        title=str(ingested.get("title")),
                        stage=stage,
                        version=int(str(ingested.get("version") or 1)),
                        target_id=str(ingested.get("output_id")),
                    )
                )
            else:
                ingested = await ingest_file_artifact(
                    session,
                    project_id=project_id,
                    file_name=f.file_name,
                    data=raw,
                    source="import",
                    actor_label=actor_id,
                    instruction=instruction,
                )
                stage = str(ingested.get("stage"))
                stages_seen.add(stage)
                results.append(
                    ImportItemResult(
                        file_name=f.file_name,
                        type="file",
                        title=str(ingested.get("title")),
                        stage=stage,
                        version=int(str(ingested.get("version") or 1)),
                        target_id=str(ingested.get("output_id")),
                    )
                )
        except ArtifactIngestError as exc:
            # 1 ファイルの失敗で全体を落とさない — per-file の honest エラー
            results.append(ImportItemResult(file_name=f.file_name, error=exc.message))

    suggested = await _suggest_stage_keys(
        session,
        project_id=project_id,
        stages_seen=stages_seen,
        any_mock=any_mock,
    )
    imported = sum(1 for r in results if r.error is None)
    await AuditWriter(session).write(
        AuditEvent(
            action="project.import",
            target_type="project",
            actor_type="user",
            actor_id=actor_id,
            target_id=project_id,
            after={
                "files": len(data.files),
                "imported": imported,
                "failed": len(results) - imported,
                "suggested_stages": suggested,
            },
        )
    )
    return ImportResult(
        results=results,
        imported=imported,
        failed=len(results) - imported,
        suggested_stage_keys=suggested,
    )


async def _suggest_stage_keys(
    session: AsyncSession, *, project_id: str, stages_seen: set[str], any_mock: bool
) -> list[str]:
    """取り込めた資料の種類 → 「完了済みでは？」の工程候補 (現在フェーズの pending のみ)。

    提案止まり — 完了への反映はユーザーが確定する (UI が flow complete を叩く)。
    """
    seen = set(stages_seen)
    if any_mock:
        seen.add("design")
    if not seen:
        return []
    rows = (
        await session.execute(
            text(
                "select fs.stage_key from public.project_flow_stages fs "
                "join public.delivery_phases dp on dp.id = fs.delivery_phase_id "
                "where fs.project_id = cast(:p as uuid) and dp.status = 'active' "
                "and fs.status = 'pending' order by fs.seq"
            ),
            {"p": project_id},
        )
    ).all()
    return [str(r.stage_key) for r in rows if str(r.stage_key) in seen]
