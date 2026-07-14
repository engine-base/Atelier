"""pytest 共通 fixture。

apps/api のテストはここを起点に共通 fixture を解決する。DB / FastAPI client /
モック LLM など、複数テストで再利用する fixture を集約する。
"""

from __future__ import annotations

import asyncio
import os
import sys
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

# apps/api を sys.path に追加して src/* を import できるようにする
_API_ROOT = Path(__file__).resolve().parent
if str(_API_ROOT) not in sys.path:
    sys.path.insert(0, str(_API_ROOT))

# テスト時は外部送信を抑止
os.environ.setdefault("ATELIER_EMAIL_DRY_RUN", "1")
# レート制限は既定で無効化 (signin 系テストは同一 TestClient IP で連打するため)。
# 実到達の検証は tests/test_rate_limit.py が明示的に有効化して行う。
os.environ.setdefault("ATELIER_RATE_LIMIT_DISABLED", "1")


@pytest.fixture(scope="session")
def event_loop() -> Iterator[asyncio.AbstractEventLoop]:
    """セッションスコープの event loop。pytest-asyncio session 互換。"""
    loop = asyncio.new_event_loop()
    try:
        yield loop
    finally:
        loop.close()


@pytest.fixture
async def api_client() -> AsyncIterator[AsyncClient]:
    """FastAPI app を ASGI 経由で叩く AsyncClient。"""
    from main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client
