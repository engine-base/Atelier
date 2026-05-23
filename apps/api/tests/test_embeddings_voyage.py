"""Unit tests for apps/api/src/embeddings/voyage.py (T-F-14)."""

# pyright: reportPrivateUsage=false
from __future__ import annotations

import json
from dataclasses import FrozenInstanceError
from typing import Any

import httpx
import pytest

from src.embeddings.voyage import (
    DEFAULT_DIMENSIONS,
    DEFAULT_MODEL,
    MAX_BATCH_SIZE,
    EmbedResult,
    EmbedUsage,
    VoyageClient,
    VoyageError,
)


def _ok_response(n: int = 1, dim: int = 1024) -> dict[str, Any]:
    return {
        "data": [{"embedding": [0.1] * dim, "index": i} for i in range(n)],
        "model": "voyage-3-large",
        "usage": {"total_tokens": n * 3},
    }


def _client(handler: Any, *, max_retries: int = 3) -> VoyageClient:
    """テスト用の VoyageClient (httpx.MockTransport を inject)。"""
    transport = httpx.MockTransport(handler)
    return VoyageClient(api_key="pa-test", max_retries=max_retries, transport=transport)


# ─────────────────────────────────────────────────────────
# 定数
# ─────────────────────────────────────────────────────────
@pytest.mark.unit
class TestConstants:
    def test_default_model(self) -> None:
        assert DEFAULT_MODEL == "voyage-3-large"

    def test_default_dimensions(self) -> None:
        assert DEFAULT_DIMENSIONS == 1024

    def test_max_batch_size(self) -> None:
        assert MAX_BATCH_SIZE == 1000


# ─────────────────────────────────────────────────────────
# DTO
# ─────────────────────────────────────────────────────────
@pytest.mark.unit
class TestDataClasses:
    def test_usage_frozen(self) -> None:
        u = EmbedUsage(total_tokens=10)
        with pytest.raises(FrozenInstanceError):
            u.total_tokens = 20  # type: ignore[misc]

    def test_result_frozen(self) -> None:
        r = EmbedResult(
            embeddings=[[0.1] * 1024],
            model="voyage-3-large",
            usage=EmbedUsage(total_tokens=1),
        )
        with pytest.raises(FrozenInstanceError):
            r.model = "x"  # type: ignore[misc]

    def test_result_default_dimensions(self) -> None:
        r = EmbedResult(
            embeddings=[[0.1] * 1024],
            model="voyage-3-large",
            usage=EmbedUsage(total_tokens=1),
        )
        assert r.dimensions == DEFAULT_DIMENSIONS


# ─────────────────────────────────────────────────────────
# 初期化
# ─────────────────────────────────────────────────────────
@pytest.mark.unit
class TestInit:
    def test_explicit_api_key(self) -> None:
        c = VoyageClient(api_key="pa-test")
        assert c._api_key == "pa-test"

    def test_reads_env_var(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("VOYAGE_API_KEY", "pa-from-env")
        c = VoyageClient()
        assert c._api_key == "pa-from-env"

    def test_missing_key_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("VOYAGE_API_KEY", raising=False)
        with pytest.raises(VoyageError, match="VOYAGE_API_KEY"):
            VoyageClient()

    def test_negative_max_retries_rejected(self) -> None:
        with pytest.raises(ValueError, match="max_retries"):
            VoyageClient(api_key="x", max_retries=-1)


# ─────────────────────────────────────────────────────────
# embed
# ─────────────────────────────────────────────────────────
@pytest.mark.unit
class TestEmbed:
    @pytest.mark.asyncio
    async def test_empty_inputs_rejected(self) -> None:
        c = VoyageClient(api_key="x")
        with pytest.raises(ValueError, match="non-empty"):
            await c.embed([])

    @pytest.mark.asyncio
    async def test_single_input_happy(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_ok_response(n=1))

        c = _client(handler)
        result = await c.embed(["hello"])
        assert len(result.embeddings) == 1
        assert result.dimensions == 1024
        assert result.usage.total_tokens == 3

    @pytest.mark.asyncio
    async def test_authorization_header_sent(self) -> None:
        captured: dict[str, str] = {}

        def handler(req: httpx.Request) -> httpx.Response:
            captured["auth"] = req.headers.get("authorization", "")
            return httpx.Response(200, json=_ok_response(n=1))

        c = _client(handler)
        await c.embed(["hello"])
        assert captured["auth"] == "Bearer pa-test"

    @pytest.mark.asyncio
    async def test_batch_splitting(self) -> None:
        call_count = 0

        def handler(req: httpx.Request) -> httpx.Response:
            nonlocal call_count
            call_count += 1
            body = json.loads(req.content)
            return httpx.Response(200, json=_ok_response(n=len(body["input"])))

        c = _client(handler)
        result = await c.embed(["x"] * 1500)
        assert call_count == 2  # 1000 + 500
        assert len(result.embeddings) == 1500

    @pytest.mark.asyncio
    async def test_4xx_immediately_raises_without_retry(self) -> None:
        attempts = {"n": 0}

        def handler(_: httpx.Request) -> httpx.Response:
            attempts["n"] += 1
            return httpx.Response(401, text='{"error":"unauthorized"}')

        c = _client(handler, max_retries=3)
        with pytest.raises(VoyageError, match="non-retryable 401"):
            await c.embed(["hi"])
        assert attempts["n"] == 1  # retry されないこと

    @pytest.mark.asyncio
    async def test_5xx_retries_and_eventually_fails(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        call_count = 0

        def handler(_: httpx.Request) -> httpx.Response:
            nonlocal call_count
            call_count += 1
            return httpx.Response(503, text="service unavailable")

        async def fake_sleep(_: float) -> None:
            return None

        monkeypatch.setattr("asyncio.sleep", fake_sleep)
        c = _client(handler, max_retries=2)
        with pytest.raises(VoyageError, match="max retries exceeded"):
            await c.embed(["hi"])
        assert call_count == 3  # 初回 + 2 retry

    @pytest.mark.asyncio
    async def test_429_retries_then_succeeds(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        attempts = {"n": 0}

        def handler(_: httpx.Request) -> httpx.Response:
            attempts["n"] += 1
            if attempts["n"] < 2:
                return httpx.Response(429, text="rate limited")
            return httpx.Response(200, json=_ok_response(n=1))

        async def fake_sleep(_: float) -> None:
            return None

        monkeypatch.setattr("asyncio.sleep", fake_sleep)
        c = _client(handler, max_retries=3)
        result = await c.embed(["hi"])
        assert len(result.embeddings) == 1
        assert attempts["n"] == 2

    @pytest.mark.asyncio
    async def test_network_error_retried(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        attempts = {"n": 0}

        def handler(_: httpx.Request) -> httpx.Response:
            attempts["n"] += 1
            if attempts["n"] < 2:
                raise httpx.ConnectError("network down")
            return httpx.Response(200, json=_ok_response(n=1))

        async def fake_sleep(_: float) -> None:
            return None

        monkeypatch.setattr("asyncio.sleep", fake_sleep)
        c = _client(handler, max_retries=3)
        result = await c.embed(["hi"])
        assert len(result.embeddings) == 1

    @pytest.mark.asyncio
    async def test_network_error_max_retries(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("network down")

        async def fake_sleep(_: float) -> None:
            return None

        monkeypatch.setattr("asyncio.sleep", fake_sleep)
        c = _client(handler, max_retries=1)
        with pytest.raises(VoyageError, match="max retries exceeded"):
            await c.embed(["hi"])


@pytest.mark.unit
class TestEmbedQuery:
    @pytest.mark.asyncio
    async def test_uses_query_input_type(self) -> None:
        captured: dict[str, Any] = {}

        def handler(req: httpx.Request) -> httpx.Response:
            captured["body"] = json.loads(req.content)
            return httpx.Response(200, json=_ok_response(n=1))

        c = _client(handler)
        vec = await c.embed_query("検索クエリ")
        assert len(vec) == 1024
        assert captured["body"]["input_type"] == "query"
        assert captured["body"]["input"] == ["検索クエリ"]
