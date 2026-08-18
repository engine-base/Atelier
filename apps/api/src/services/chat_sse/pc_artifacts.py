"""GAP-137: agent_sdk (サーバー内実行) 経路の PC 操作成果物をモックへ反映する。

relay (Bridge) 経路では同じ検出を Bridge (ユーザー PC) が行い
POST /dispatch/chat-relay/{job}/artifacts で送る。ここはサーバー内実行
(オーナー個人インスタンス構成) の対称実装で、チャット作業フォルダの
新規/更新 HTML をジョブ完了時にモックストアへ取り込む。
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.db.session import create_engine, create_session_factory
from src.services.mocks.artifacts import (
    MAX_ARTIFACTS_PER_JOB,
    MAX_HTML_BYTES,
    ArtifactIngestError,
    IngestedMock,
    ingest_html_artifact,
)

_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv"}
_MAX_DEPTH = 3


def snapshot_html_files(root: str) -> dict[str, float]:
    """作業フォルダ直下〜深さ 3 の *.html/.htm の mtime を記録する。"""
    result: dict[str, float] = {}
    base = Path(root)
    if not base.is_dir():
        return result
    base_depth = len(base.parts)
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [
            d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")
        ]
        if len(Path(dirpath).parts) - base_depth >= _MAX_DEPTH:
            dirnames[:] = []
        for name in filenames:
            if not name.lower().endswith((".html", ".htm")):
                continue
            p = Path(dirpath) / name
            try:
                result[str(p)] = p.stat().st_mtime
            except OSError:
                continue
    return result


def collect_new_html(
    root: str, before: dict[str, float]
) -> list[tuple[str, str]]:
    """スナップショット比較で新規/更新された HTML を (相対名, 中身) で返す。

    上限: 1 ジョブ MAX_ARTIFACTS_PER_JOB 件・1 件 MAX_HTML_BYTES。超過分は
    新しい順に優先し、切り捨てはログではなく戻り値の件数で分かる。
    """
    after = snapshot_html_files(root)
    changed = [
        (path, mtime)
        for path, mtime in after.items()
        if before.get(path) is None or mtime > before[path]
    ]
    changed.sort(key=lambda x: x[1], reverse=True)
    out: list[tuple[str, str]] = []
    for path, _mtime in changed[:MAX_ARTIFACTS_PER_JOB]:
        try:
            raw = Path(path).read_bytes()
        except OSError:
            continue
        if len(raw) > MAX_HTML_BYTES:
            continue
        try:
            html = raw.decode("utf-8")
        except UnicodeDecodeError:
            continue
        rel = os.path.relpath(path, root)
        out.append((rel, html))
    return out


@lru_cache(maxsize=1)
def _service_session_factory() -> async_sessionmaker[AsyncSession]:
    return create_session_factory(create_engine())


async def ingest_for_thread(
    *, thread_id: str, files: list[tuple[str, str]]
) -> list[IngestedMock]:
    """thread の project へ成果物を取り込む (自前 service session / commit 込み)。

    失敗しても呼び出し側のチャット応答を壊さない — 取り込めた分だけ返す。
    """
    if not files:
        return []
    factory = _service_session_factory()
    results: list[IngestedMock] = []
    async with factory() as session:
        row = (
            await session.execute(
                text(
                    "select project_id from public.chat_threads "
                    "where id = cast(:t as uuid)"
                ),
                {"t": thread_id},
            )
        ).first()
        if row is None or row.project_id is None:
            return []
        project_id = str(row.project_id)
        for file_name, html in files:
            try:
                results.append(
                    await ingest_html_artifact(
                        session,
                        project_id=project_id,
                        file_name=file_name,
                        html=html,
                        source="chat_pc_tools",
                        actor_label="agent_sdk",
                    )
                )
            except ArtifactIngestError:
                continue
        await session.commit()
    return results
