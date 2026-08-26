# pyright: reportUnusedFunction=false
"""未捕捉例外 (500) が利用者に何を返すかのテスト (GAP-215)。

2026-08-26 の通しで、DB が落ちた状態でサインインすると画面の赤帯に
`internal server error (ConnectionRefusedError) at /auth/signin` が出た。
例外クラス名と内部パスがそのまま利用者に届いていた。

ここで固定するのは 2 点:

  1. **内部の言葉を外に出さない** — 例外クラス名も、リクエストパスも、
     英語の "internal server error" も本文に含まない。
  2. **問い合わせの手がかりは残す** — error_log に記録できたときは参照 ID を
     添える。記録できないとき (DB 自体が落ちているとき) は ID 無しで、
     それでもレスポンスは壊さない。
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from src.errors import UNHANDLED_MESSAGE, UnhandledErrorMiddleware


def _build_app() -> FastAPI:
    app = FastAPI()

    @app.get("/auth/signin")
    async def boom() -> dict[str, Any]:
        raise ConnectionRefusedError(111, "Connection refused")

    app.add_middleware(UnhandledErrorMiddleware)
    return app


async def _get_detail() -> tuple[int, str]:
    app = _build_app()
    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/auth/signin")
    return res.status_code, res.json()["detail"]


@pytest.mark.asyncio
async def test_記録できたら参照IDを添える() -> None:
    with patch(
        "src.observability.errors.record_exception",
        AsyncMock(return_value="1f2e3d4c-0000-0000-0000-abcdefabcdef"),
    ):
        status, detail = await _get_detail()

    assert status == 500
    assert UNHANDLED_MESSAGE in detail
    assert "1f2e3d4c-0000-0000-0000-abcdefabcdef" in detail


@pytest.mark.asyncio
async def test_記録できなくてもレスポンスは壊れない() -> None:
    # DB ごと落ちている状況 — record_exception 自体が例外を投げる
    with patch(
        "src.observability.errors.record_exception",
        AsyncMock(side_effect=ConnectionRefusedError(111, "Connection refused")),
    ):
        status, detail = await _get_detail()

    assert status == 500
    assert detail == UNHANDLED_MESSAGE
    assert "参照 ID" not in detail


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "leak",
    [
        "ConnectionRefusedError",  # 例外クラス名
        "/auth/signin",  # リクエストパス
        "internal server error",  # 英語の内部語
        "Traceback",
    ],
)
async def test_内部の言葉が本文に出ない(leak: str) -> None:
    with patch(
        "src.observability.errors.record_exception",
        AsyncMock(return_value="1f2e3d4c-0000-0000-0000-abcdefabcdef"),
    ):
        _, detail = await _get_detail()

    assert leak not in detail
