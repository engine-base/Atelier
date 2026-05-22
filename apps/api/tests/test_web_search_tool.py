"""Unit tests for apps/api/src/tools/web_search.py (T-F-21)."""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from types import SimpleNamespace

import pytest

from src.tools.web_search import (
    DEFAULT_MAX_USES,
    WEB_SEARCH_TOOL_NAME,
    WEB_SEARCH_TOOL_TYPE,
    WebSearchToolConfig,
    build_web_search_tool,
    count_web_search_invocations,
    is_web_search_tool_use,
)


@pytest.mark.unit
class TestConstants:
    def test_tool_type_identifier(self) -> None:
        assert WEB_SEARCH_TOOL_TYPE == "web_search_20250305"

    def test_tool_name(self) -> None:
        assert WEB_SEARCH_TOOL_NAME == "web_search"

    def test_default_max_uses(self) -> None:
        assert DEFAULT_MAX_USES >= 1


@pytest.mark.unit
class TestWebSearchToolConfig:
    def test_defaults(self) -> None:
        cfg = WebSearchToolConfig()
        assert cfg.max_uses == DEFAULT_MAX_USES
        assert cfg.allowed_domains is None
        assert cfg.blocked_domains is None
        assert cfg.user_location is None

    def test_frozen(self) -> None:
        cfg = WebSearchToolConfig()
        with pytest.raises(FrozenInstanceError):
            cfg.max_uses = 10  # type: ignore[misc]

    def test_max_uses_must_be_positive(self) -> None:
        with pytest.raises(ValueError, match="max_uses"):
            WebSearchToolConfig(max_uses=0)

    def test_max_uses_negative_rejected(self) -> None:
        with pytest.raises(ValueError, match="max_uses"):
            WebSearchToolConfig(max_uses=-1)

    def test_allowed_and_blocked_mutually_exclusive(self) -> None:
        with pytest.raises(ValueError, match="mutually exclusive"):
            WebSearchToolConfig(
                allowed_domains=("a.com",),
                blocked_domains=("b.com",),
            )

    def test_allowed_domains_only_ok(self) -> None:
        cfg = WebSearchToolConfig(allowed_domains=("example.com",))
        assert cfg.allowed_domains == ("example.com",)

    def test_blocked_domains_only_ok(self) -> None:
        cfg = WebSearchToolConfig(blocked_domains=("evil.com",))
        assert cfg.blocked_domains == ("evil.com",)


@pytest.mark.unit
class TestBuildWebSearchTool:
    def test_none_config_uses_defaults(self) -> None:
        d = build_web_search_tool(None)
        assert d == {
            "type": "web_search_20250305",
            "name": "web_search",
            "max_uses": DEFAULT_MAX_USES,
        }

    def test_no_arg_uses_defaults(self) -> None:
        assert build_web_search_tool() == build_web_search_tool(None)

    def test_custom_max_uses(self) -> None:
        d = build_web_search_tool(WebSearchToolConfig(max_uses=2))
        assert d["max_uses"] == 2

    def test_allowed_domains_serialized_as_list(self) -> None:
        d = build_web_search_tool(
            WebSearchToolConfig(allowed_domains=("a.com", "b.com")),
        )
        assert d["allowed_domains"] == ["a.com", "b.com"]
        assert "blocked_domains" not in d

    def test_blocked_domains_serialized_as_list(self) -> None:
        d = build_web_search_tool(
            WebSearchToolConfig(blocked_domains=("evil.com",)),
        )
        assert d["blocked_domains"] == ["evil.com"]
        assert "allowed_domains" not in d

    def test_user_location_serialized_as_dict(self) -> None:
        d = build_web_search_tool(
            WebSearchToolConfig(
                user_location={
                    "type": "approximate",
                    "city": "Tokyo",
                    "country": "JP",
                },
            ),
        )
        assert d["user_location"] == {
            "type": "approximate",
            "city": "Tokyo",
            "country": "JP",
        }


@pytest.mark.unit
class TestIsWebSearchToolUse:
    def test_server_tool_use_with_web_search_name(self) -> None:
        block = SimpleNamespace(type="server_tool_use", name="web_search")
        assert is_web_search_tool_use(block) is True

    def test_web_search_tool_result_block(self) -> None:
        block = SimpleNamespace(type="web_search_tool_result", name="web_search")
        assert is_web_search_tool_use(block) is True

    def test_server_tool_use_without_name_treated_as_web_search(self) -> None:
        # SDK バージョンによっては name フィールド未提供 → 寛容に True
        block = SimpleNamespace(type="server_tool_use")
        assert is_web_search_tool_use(block) is True

    def test_text_block_returns_false(self) -> None:
        block = SimpleNamespace(type="text", text="hello")
        assert is_web_search_tool_use(block) is False

    def test_other_tool_use_returns_false(self) -> None:
        block = SimpleNamespace(type="server_tool_use", name="other_tool")
        assert is_web_search_tool_use(block) is False

    def test_plain_object_without_type_returns_false(self) -> None:
        assert is_web_search_tool_use(object()) is False


@pytest.mark.unit
class TestCountWebSearchInvocations:
    def test_empty_content(self) -> None:
        assert count_web_search_invocations([]) == 0

    def test_counts_only_web_search(self) -> None:
        content: list[object] = [
            SimpleNamespace(type="text", text="hi"),
            SimpleNamespace(type="server_tool_use", name="web_search"),
            SimpleNamespace(type="web_search_tool_result", name="web_search"),
            SimpleNamespace(type="server_tool_use", name="other"),
        ]
        assert count_web_search_invocations(content) == 2
