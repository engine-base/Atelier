"""filedb 成果物の「中身が何か」を実体から引く (GAP-176 / GAP-268 で共有化)。

routes/outputs (運営側 S-G01) と services/client_signin/content (クライアント側 S-L03) の
両方が同じ判定を使う。表示種別は ContentUrl.kind の値域に写す:
image → image / pdf → pdf / sheet → sheet / それ以外 (slides, doc, video 等) → binary
(プレビュー枠を出さず DL 導線にする)。
"""

from __future__ import annotations

from typing import Literal

from src.services.mocks.artifacts import (
    FILEDB_PREFIX,
    fetch_file_content,
    file_type_for,
    service_session_factory,
)

ContentKind = Literal["html", "pdf", "image", "sheet", "binary"]


async def filedb_kind(html_path: str) -> tuple[ContentKind, str | None, str | None]:
    """filedb 成果物の (表示種別, ファイル名, MIME) を実体から引く。"""
    factory = service_session_factory()
    async with factory() as service_session:
        found = await fetch_file_content(service_session, file_id=html_path[len(FILEDB_PREFIX) :])
    if found is None:
        return "binary", None, None
    _data, mime, file_name = found
    pair = file_type_for(file_name)
    file_kind = pair[0] if pair else ""
    if file_kind == "image":
        return "image", file_name, mime
    if file_kind == "pdf":
        return "pdf", file_name, mime
    if file_kind == "sheet":
        return "sheet", file_name, mime
    return "binary", file_name, mime
