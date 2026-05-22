"""Unit tests for apps/api/src/llm/caching.py (T-F-15)."""

from __future__ import annotations

from typing import Any

import pytest

from src.llm.caching import (
    EPHEMERAL,
    MIN_CACHEABLE_TOKENS,
    cache_system_prompt,
    estimate_should_cache,
    mark_cacheable,
    mark_last_message_cacheable,
)


@pytest.mark.unit
class TestConstants:
    def test_ephemeral_literal(self) -> None:
        assert EPHEMERAL == "ephemeral"

    def test_min_cacheable_tokens_anthropic_recommended(self) -> None:
        assert MIN_CACHEABLE_TOKENS == 1024


@pytest.mark.unit
class TestCacheSystemPrompt:
    def test_empty_returns_empty_list(self) -> None:
        assert cache_system_prompt("") == []

    def test_text_wrapped_with_cache_control(self) -> None:
        out = cache_system_prompt("hello")
        assert out == [
            {
                "type": "text",
                "text": "hello",
                "cache_control": {"type": "ephemeral"},
            }
        ]


@pytest.mark.unit
class TestMarkCacheable:
    def test_adds_cache_control(self) -> None:
        block: dict[str, Any] = {"type": "text", "text": "x"}
        out = mark_cacheable(block)
        assert out["cache_control"] == {"type": "ephemeral"}

    def test_does_not_mutate_input(self) -> None:
        block: dict[str, Any] = {"type": "text", "text": "x"}
        mark_cacheable(block)
        assert "cache_control" not in block

    def test_preserves_other_fields(self) -> None:
        block: dict[str, Any] = {"type": "text", "text": "x", "extra": 1}
        out = mark_cacheable(block)
        assert out["extra"] == 1


@pytest.mark.unit
class TestMarkLastMessageCacheable:
    def test_empty_messages(self) -> None:
        assert mark_last_message_cacheable([]) == []

    def test_string_content_converted_to_block_list(self) -> None:
        msgs: list[dict[str, Any]] = [{"role": "user", "content": "hi"}]
        out = mark_last_message_cacheable(msgs)
        assert out[0]["content"] == [
            {
                "type": "text",
                "text": "hi",
                "cache_control": {"type": "ephemeral"},
            }
        ]

    def test_block_list_content_last_block_marked(self) -> None:
        msgs: list[dict[str, Any]] = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "a"},
                    {"type": "text", "text": "b"},
                ],
            },
        ]
        out = mark_last_message_cacheable(msgs)
        content = out[0]["content"]
        assert isinstance(content, list)
        assert content[0] == {"type": "text", "text": "a"}
        assert content[1]["cache_control"] == {"type": "ephemeral"}

    def test_empty_block_list_no_op(self) -> None:
        msgs: list[dict[str, Any]] = [{"role": "user", "content": []}]
        out = mark_last_message_cacheable(msgs)
        assert out[0]["content"] == []

    def test_non_dict_block_in_list_skipped(self) -> None:
        msgs: list[dict[str, Any]] = [
            {"role": "user", "content": ["not-a-dict"]},
        ]
        out = mark_last_message_cacheable(msgs)
        # 非 dict は touch しない
        assert out[0]["content"] == ["not-a-dict"]

    def test_does_not_mutate_input(self) -> None:
        msgs: list[dict[str, Any]] = [{"role": "user", "content": "hi"}]
        mark_last_message_cacheable(msgs)
        assert msgs[0]["content"] == "hi"


@pytest.mark.unit
class TestEstimateShouldCache:
    def test_below_threshold(self) -> None:
        assert estimate_should_cache(100) is False

    def test_at_threshold(self) -> None:
        assert estimate_should_cache(MIN_CACHEABLE_TOKENS) is True

    def test_above_threshold(self) -> None:
        assert estimate_should_cache(10000) is True
