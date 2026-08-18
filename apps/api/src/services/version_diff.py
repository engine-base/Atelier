"""GAP-155: バージョン間差分 (unified diff) — モック/成果物共通。

「ブランチはしない。誰がどう変えたかわかって戻せたらいいレベル。モック以外もね」
(経営者すり合わせ) の実装。差分はサーバ側で実 HTML 2 版から difflib で計算する
— クライアント推測やキャッシュ近似は使わない。バイナリ (filedb://) は差分表示
不可と誠実に返す (テキスト化偽装をしない)。
"""

from __future__ import annotations

import difflib

import httpx

from src.storage_signing import create_signed_download_url

from .mocks.artifacts import FILEDB_PREFIX, MOCKDB_PREFIX, fetch_content_service

_MAX_DIFF_CHARS = 200_000


class VersionDiffError(Exception):
    """差分の構造的失敗 (code: binary / no_content / content_unavailable /
    different_chain / too_large)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def load_text_content(storage_path: str) -> str:
    """差分対象の実テキスト (HTML) を取得する。

    mockdb:// は DB 内蔵ストア (service 経由)、通常パスは署名付き URL 経由。
    filedb:// (画像/PPTX 等のバイナリ) はテキスト差分に意味が無いため error。
    """
    if storage_path.startswith(FILEDB_PREFIX):
        raise VersionDiffError("binary", "バイナリ形式のファイルはテキスト差分を表示できません")
    if storage_path.startswith(MOCKDB_PREFIX):
        text = await fetch_content_service(storage_path[len(MOCKDB_PREFIX) :])
        if text is None:
            raise VersionDiffError("content_unavailable", "版の本文が見つかりません")
        return text
    url = await create_signed_download_url(storage_path)
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(url)
    if r.status_code >= 400:
        raise VersionDiffError(
            "content_unavailable", f"版の本文取得に失敗しました: {r.status_code}"
        )
    return r.text


def unified_diff(
    *, from_label: str, from_text: str, to_label: str, to_text: str
) -> tuple[str, int, int]:
    """unified diff 文字列と (追加行数, 削除行数) を返す。同一内容は ("", 0, 0)。"""
    lines = list(
        difflib.unified_diff(
            from_text.splitlines(),
            to_text.splitlines(),
            fromfile=from_label,
            tofile=to_label,
            lineterm="",
        )
    )
    added = sum(1 for ln in lines if ln.startswith("+") and not ln.startswith("+++"))
    removed = sum(1 for ln in lines if ln.startswith("-") and not ln.startswith("---"))
    diff = "\n".join(lines)
    if len(diff) > _MAX_DIFF_CHARS:
        raise VersionDiffError(
            "too_large", "差分が大きすぎて表示できません — 版を分けて確認してください"
        )
    return diff, added, removed
