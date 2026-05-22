"""Unit tests for apps/api/src/llm/batch.py (T-F-15)."""

# pyright: reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportUnknownMemberType=false, reportUnknownVariableType=false
from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.llm.batch import (
    AnthropicBatchClient,
    BatchHandle,
    BatchRequest,
    BatchResultItem,
    _parse_result_entry,
)
from src.llm.client import LLMMessage


@pytest.mark.unit
class TestBatchRequest:
    def test_minimal_ok(self) -> None:
        r = BatchRequest(
            custom_id="abc",
            model="claude-sonnet-4-6",
            messages=[LLMMessage(role="user", content="hi")],
        )
        assert r.custom_id == "abc"

    def test_empty_custom_id_rejected(self) -> None:
        with pytest.raises(ValueError, match="custom_id"):
            BatchRequest(
                custom_id="",
                model="m",
                messages=[LLMMessage(role="user", content="x")],
            )

    def test_invalid_max_tokens_rejected(self) -> None:
        with pytest.raises(ValueError, match="max_tokens"):
            BatchRequest(
                custom_id="id",
                model="m",
                messages=[LLMMessage(role="user", content="x")],
                max_tokens=0,
            )

    def test_to_sdk_dict_minimal(self) -> None:
        r = BatchRequest(
            custom_id="id1",
            model="claude-sonnet-4-6",
            messages=[LLMMessage(role="user", content="hi")],
            max_tokens=512,
            temperature=0.7,
        )
        d = r.to_sdk_dict()
        assert d["custom_id"] == "id1"
        assert d["params"]["model"] == "claude-sonnet-4-6"
        assert d["params"]["max_tokens"] == 512
        assert d["params"]["temperature"] == 0.7
        assert d["params"]["messages"] == [{"role": "user", "content": "hi"}]
        assert "system" not in d["params"]
        assert "metadata" not in d["params"]

    def test_to_sdk_dict_with_system_and_metadata(self) -> None:
        r = BatchRequest(
            custom_id="id1",
            model="m",
            messages=[LLMMessage(role="user", content="hi")],
            system="be brief",
            metadata={"client": "atelier"},
        )
        d = r.to_sdk_dict()
        assert d["params"]["system"] == "be brief"
        assert d["params"]["metadata"] == {"client": "atelier"}

    def test_to_sdk_dict_filters_non_user_assistant_roles(self) -> None:
        r = BatchRequest(
            custom_id="id1",
            model="m",
            messages=[
                LLMMessage(role="system", content="ignored"),
                LLMMessage(role="user", content="hi"),
            ],
        )
        d = r.to_sdk_dict()
        assert d["params"]["messages"] == [{"role": "user", "content": "hi"}]


@pytest.mark.unit
class TestParseResultEntry:
    def test_succeeded(self) -> None:
        entry = SimpleNamespace(
            custom_id="x",
            result=SimpleNamespace(
                type="succeeded",
                message=SimpleNamespace(
                    content=[
                        SimpleNamespace(type="text", text="hello "),
                        SimpleNamespace(type="text", text="world"),
                        SimpleNamespace(type="other"),
                    ],
                ),
            ),
        )
        out = _parse_result_entry(entry)
        assert out.status == "succeeded"
        assert out.text == "hello world"

    @pytest.mark.parametrize("err_type", ["errored", "canceled", "expired"])
    def test_error_states(self, err_type: str) -> None:
        entry = SimpleNamespace(
            custom_id="x",
            result=SimpleNamespace(type=err_type),
        )
        out = _parse_result_entry(entry)
        assert out.status == err_type
        assert out.text is None

    def test_unknown_type_raises(self) -> None:
        entry = SimpleNamespace(
            custom_id="x",
            result=SimpleNamespace(type="weird"),
        )
        with pytest.raises(RuntimeError, match="unknown batch result type"):
            _parse_result_entry(entry)


@pytest.mark.unit
class TestAnthropicBatchClient:
    @pytest.fixture
    def client(self, monkeypatch: pytest.MonkeyPatch) -> AnthropicBatchClient:
        # AsyncAnthropic を mock 化
        import anthropic  # type: ignore[import-not-found]

        sdk = MagicMock()
        sdk.messages.batches.create = AsyncMock()
        sdk.messages.batches.retrieve = AsyncMock()
        sdk.messages.batches.results = AsyncMock()
        monkeypatch.setattr(anthropic, "AsyncAnthropic", lambda **_: sdk)
        c = AnthropicBatchClient(api_key="test")
        return c

    @pytest.mark.asyncio
    async def test_submit_empty_rejected(self, client: AnthropicBatchClient) -> None:
        with pytest.raises(ValueError, match="non-empty"):
            await client.submit([])

    @pytest.mark.asyncio
    async def test_submit_returns_handle(self, client: AnthropicBatchClient) -> None:
        sdk_create: Any = client._sdk.messages.batches.create  # type: ignore[attr-defined]
        sdk_create.return_value = SimpleNamespace(id="batch_123")
        handle = await client.submit(
            [
                BatchRequest(
                    custom_id="c1",
                    model="m",
                    messages=[LLMMessage(role="user", content="x")],
                ),
            ],
        )
        assert handle == BatchHandle(batch_id="batch_123")
        sdk_create.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_status_returns_processing_status(
        self,
        client: AnthropicBatchClient,
    ) -> None:
        sdk_retrieve: Any = client._sdk.messages.batches.retrieve  # type: ignore[attr-defined]
        sdk_retrieve.return_value = SimpleNamespace(processing_status="in_progress")
        s = await client.status(BatchHandle(batch_id="b"))
        assert s == "in_progress"

    @pytest.mark.asyncio
    async def test_status_unknown_raises(
        self,
        client: AnthropicBatchClient,
    ) -> None:
        sdk_retrieve: Any = client._sdk.messages.batches.retrieve  # type: ignore[attr-defined]
        sdk_retrieve.return_value = SimpleNamespace(processing_status="weird")
        with pytest.raises(RuntimeError, match="unexpected batch status"):
            await client.status(BatchHandle(batch_id="b"))

    @pytest.mark.asyncio
    async def test_results_yields_parsed_items(
        self,
        client: AnthropicBatchClient,
    ) -> None:
        # results() は async iterator を返すので、Mock で async iter を作る
        async def fake_iter() -> Any:
            yield SimpleNamespace(
                custom_id="c1",
                result=SimpleNamespace(type="errored"),
            )
            yield SimpleNamespace(
                custom_id="c2",
                result=SimpleNamespace(
                    type="succeeded",
                    message=SimpleNamespace(
                        content=[SimpleNamespace(type="text", text="ok")],
                    ),
                ),
            )

        sdk_results: Any = client._sdk.messages.batches.results  # type: ignore[attr-defined]
        sdk_results.return_value = fake_iter()
        items: list[BatchResultItem] = []
        async for item in client.results(BatchHandle(batch_id="b")):
            items.append(item)
        assert len(items) == 2
        assert items[0].status == "errored"
        assert items[1].status == "succeeded"
        assert items[1].text == "ok"
