"""外から見える API の base URL (GAP-298 / 通し J46-02 / J45-02)。

Fly の proxy 越しでは `request.base_url` が `http://` になり、自己署名の閲覧 URL
(content-url / 共有リンク) が http で発行されて https の画面で Mixed Content として
block されていた。proxy が付ける X-Forwarded-Proto / X-Forwarded-Host を尊重し、
明示設定 (ATELIER_PUBLIC_BASE_URL) があればそれを最優先にする。
"""

from __future__ import annotations

import os

from fastapi import Request


def public_base_url(request: Request) -> str:
    """末尾 `/` 付きの base URL (request.base_url と同じ形)。"""
    explicit = (os.environ.get("ATELIER_PUBLIC_BASE_URL") or "").strip()
    if explicit:
        return explicit.rstrip("/") + "/"
    base = str(request.base_url)
    proto = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    host = (request.headers.get("x-forwarded-host") or "").split(",")[0].strip()
    if host:
        base = f"{proto or request.url.scheme}://{host}/"
    elif proto in ("http", "https") and base.startswith("http://") and proto == "https":
        base = "https://" + base[len("http://") :]
    return base
