"""health endpoint smoke test (T-F-04 + T-F-24 配線確認)。"""

from __future__ import annotations

import pytest
from httpx import AsyncClient


@pytest.mark.unit
@pytest.mark.asyncio
async def test_health_returns_ok(api_client: AsyncClient) -> None:
    response = await api_client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "atelier-api"
    assert isinstance(body["version"], str)
