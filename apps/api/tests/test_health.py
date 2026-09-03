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


@pytest.mark.unit
@pytest.mark.asyncio
async def test_gap285_capabilities_reports_what_is_actually_installed(
    api_client: AsyncClient,
) -> None:
    """GAP-285 (G-11: 外部リソースの実在) — 「入れたつもり」を機械で確かめる口。

    本番に埋め込みの部品が 1 つも入っておらず、意味検索がずっと unavailable
    だった (通し J35-01 / J35-07)。deploy 直後にここを見て落とせるようにする。
    認証は要らない (デプロイ直後に叩くため) が、秘密は 1 つも返さない。
    """
    response = await api_client.get("/health/capabilities")

    assert response.status_code == 200
    body = response.json()
    # 「入っているか」は環境で変わる。ここで守るのは **正直に真偽を返すこと**
    assert isinstance(body["embeddings"], bool)
    assert isinstance(body["transcription"], bool)
    assert body["embedding_provider"] in {"local", "voyage", "none"}
    assert body["embedding_state"] in {"ready", "preparing", "unavailable"}
    # 部品が無いのに ready と言わない (fake green を作らない)
    if not body["embeddings"] and body["embedding_provider"] == "local":
        assert body["embedding_state"] != "ready"
    # 秘密は載せない
    assert not any("key" in k.lower() or "token" in k.lower() for k in body)
