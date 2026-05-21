"""Unit tests for apps/api/src/llm/openai.py.

OpenAIClient は v2 用 placeholder。complete() は NotImplementedError を投げる。
Coverage target: >= 80%.
"""

from __future__ import annotations

import pytest

from src.llm import LLMMessage
from src.llm.openai import OpenAIClient


@pytest.mark.unit
class TestOpenAIClient:
    def test_provider_name(self) -> None:
        client = OpenAIClient()
        assert client.provider == "openai"

    @pytest.mark.asyncio
    async def test_complete_raises_not_implemented(self) -> None:
        client = OpenAIClient()
        with pytest.raises(NotImplementedError, match="reserved for v2"):
            await client.complete(
                model="gpt-4",
                messages=[LLMMessage(role="user", content="hi")],
                system=None,
                max_tokens=10,
                temperature=0.5,
                stop_sequences=None,
            )

    @pytest.mark.asyncio
    async def test_complete_raises_with_all_optional_args(self) -> None:
        client = OpenAIClient()
        with pytest.raises(NotImplementedError):
            await client.complete(
                model="gpt-4",
                messages=[LLMMessage(role="user", content="hi")],
                system="be brief",
                max_tokens=64,
                temperature=1.0,
                stop_sequences=["END"],
            )
