"""GAP-137: agent_sdk (サーバー内実行) 経路の PC 操作成果物をモックへ反映する。

relay (Bridge) 経路では同じ検出を Bridge (ユーザー PC) が行い
POST /dispatch/chat-relay/{job}/artifacts で送る。ここはサーバー内実行
(オーナー個人インスタンス構成) の対称実装で、チャット作業フォルダの
新規/更新 HTML をジョブ完了時にモックストアへ取り込む。
"""

from __future__ import annotations

import os
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.db.session import shared_session_factory
from src.services.mocks.artifacts import (
    ARTIFACT_KIND_MOCK,
    MAX_ARTIFACTS_PER_JOB,
    MAX_FILE_BYTES,
    MAX_HTML_BYTES,
    ArtifactIngestError,
    classify_artifact,
    file_type_for,
    ingest_file_artifact,
    ingest_html_artifact,
    ingest_html_output,
)

_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv"}
_MAX_DEPTH = 3


def _is_candidate(name: str) -> bool:
    """成果物候補か (HTML + GAP-145 の対応バイナリ形式)。"""
    return name.lower().endswith((".html", ".htm")) or file_type_for(name) is not None


def snapshot_artifact_files(root: str) -> dict[str, float]:
    """作業フォルダ直下〜深さ 3 の成果物候補ファイルの mtime を記録する。"""
    result: dict[str, float] = {}
    base = Path(root)
    if not base.is_dir():
        return result
    base_depth = len(base.parts)
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")]
        if len(Path(dirpath).parts) - base_depth >= _MAX_DEPTH:
            dirnames[:] = []
        for name in filenames:
            if not _is_candidate(name):
                continue
            p = Path(dirpath) / name
            try:
                result[str(p)] = p.stat().st_mtime
            except OSError:
                continue
    return result


def collect_new_artifacts(root: str, before: dict[str, float]) -> list[dict[str, object]]:
    """スナップショット比較で新規/更新された成果物を返す。

    HTML はテキスト ("html")、対応バイナリ (画像/PPTX/PDF/Excel/動画 等) は
    bytes ("data")。上限: 1 ジョブ MAX_ARTIFACTS_PER_JOB 件・HTML は
    MAX_HTML_BYTES / バイナリは MAX_FILE_BYTES。新しい順に優先する。
    """
    after = snapshot_artifact_files(root)
    changed = [
        (path, mtime)
        for path, mtime in after.items()
        if before.get(path) is None or mtime > before[path]
    ]
    changed.sort(key=lambda x: x[1], reverse=True)
    out: list[dict[str, object]] = []
    for path, _mtime in changed[:MAX_ARTIFACTS_PER_JOB]:
        try:
            raw = Path(path).read_bytes()
        except OSError:
            continue
        rel = os.path.relpath(path, root)
        if path.lower().endswith((".html", ".htm")):
            if len(raw) > MAX_HTML_BYTES:
                continue
            try:
                out.append({"file_name": rel, "html": raw.decode("utf-8")})
            except UnicodeDecodeError:
                continue
        else:
            if len(raw) > MAX_FILE_BYTES:
                continue
            out.append({"file_name": rel, "data": raw})
    return out


def _service_session_factory() -> async_sessionmaker[AsyncSession]:
    # GAP-197: engine はプロセスに 1 つ (個別に作るとプールが 13 倍になる)
    return shared_session_factory()


async def ingest_for_thread(
    *, thread_id: str, files: list[dict[str, object]], instruction: str = ""
) -> list[dict[str, object]]:
    """thread の project へ成果物を取り込む (自前 service session / commit 込み)。

    GAP-139: 種類を判定して振り分ける (mock → mocks / それ以外 →
    workflow_outputs)。GAP-145: バイナリ ("data") は ingest_file_artifact。
    失敗しても呼び出し側のチャット応答を壊さない — 取り込めた分だけ返す。
    """
    if not files:
        return []
    factory = _service_session_factory()
    results: list[dict[str, object]] = []
    async with factory() as session:
        row = (
            await session.execute(
                text("select project_id from public.chat_threads where id = cast(:t as uuid)"),
                {"t": thread_id},
            )
        ).first()
        if row is None or row.project_id is None:
            return []
        project_id = str(row.project_id)
        for f in files:
            file_name = str(f.get("file_name", ""))
            data = f.get("data")
            try:
                if isinstance(data, bytes):
                    results.append(
                        await ingest_file_artifact(
                            session,
                            project_id=project_id,
                            file_name=file_name,
                            data=data,
                            source="chat_pc_tools",
                            actor_label="agent_sdk",
                            instruction=instruction,
                        )
                    )
                    continue
                html = str(f.get("html", ""))
                kind = classify_artifact(file_name=file_name, html=html, instruction=instruction)
                if kind == ARTIFACT_KIND_MOCK:
                    results.append(
                        {
                            "type": "mock",
                            **await ingest_html_artifact(
                                session,
                                project_id=project_id,
                                file_name=file_name,
                                html=html,
                                source="chat_pc_tools",
                                actor_label="agent_sdk",
                            ),
                        }
                    )
                else:
                    results.append(
                        await ingest_html_output(
                            session,
                            project_id=project_id,
                            file_name=file_name,
                            html=html,
                            stage=kind,
                            source="chat_pc_tools",
                            actor_label="agent_sdk",
                        )
                    )
            except ArtifactIngestError:
                continue
        await session.commit()
    return results
