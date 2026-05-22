"""Unit tests for apps/api/src/mcp/tools.py (T-F-22)."""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from typing import Any

import pytest

from src.mcp.tools import McpTool, McpToolRegistry, default_registry


async def _echo(args: dict[str, Any]) -> dict[str, Any]:
    return {"echo": args}


@pytest.mark.unit
class TestMcpTool:
    def test_basic_ok(self) -> None:
        t = McpTool(
            name="echo",
            description="echo back",
            input_schema={"type": "object"},
            handler=_echo,
        )
        assert t.name == "echo"

    def test_frozen(self) -> None:
        t = McpTool(
            name="x",
            description="d",
            input_schema={},
            handler=_echo,
        )
        with pytest.raises(FrozenInstanceError):
            t.name = "y"  # type: ignore[misc]

    def test_empty_name_rejected(self) -> None:
        with pytest.raises(ValueError, match="name"):
            McpTool(name="", description="d", input_schema={}, handler=_echo)

    def test_empty_description_rejected(self) -> None:
        with pytest.raises(ValueError, match="description"):
            McpTool(name="n", description="", input_schema={}, handler=_echo)

    def test_non_dict_schema_rejected(self) -> None:
        with pytest.raises(TypeError, match="input_schema"):
            McpTool(
                name="n",
                description="d",
                input_schema="not-a-dict",  # type: ignore[arg-type]
                handler=_echo,
            )

    def test_to_descriptor_excludes_handler(self) -> None:
        t = McpTool(
            name="n",
            description="d",
            input_schema={"type": "object", "required": ["x"]},
            handler=_echo,
        )
        d = t.to_descriptor()
        assert d == {
            "name": "n",
            "description": "d",
            "inputSchema": {"type": "object", "required": ["x"]},
        }
        assert "handler" not in d

    def test_to_descriptor_copies_schema(self) -> None:
        schema: dict[str, Any] = {"type": "object"}
        t = McpTool(name="n", description="d", input_schema=schema, handler=_echo)
        d = t.to_descriptor()
        d["inputSchema"]["mutated"] = True
        # 元 schema は影響を受けない (defensive copy)
        assert "mutated" not in schema


@pytest.mark.unit
class TestMcpToolRegistry:
    @pytest.fixture
    def reg(self) -> McpToolRegistry:
        return McpToolRegistry()

    @pytest.fixture
    def tool(self) -> McpTool:
        return McpTool(
            name="echo",
            description="echo back",
            input_schema={"type": "object"},
            handler=_echo,
        )

    def test_empty_registry(self, reg: McpToolRegistry) -> None:
        assert len(reg) == 0
        assert reg.list_tools() == []
        assert reg.descriptors() == []
        assert reg.get("missing") is None
        assert "anything" not in reg

    def test_register_and_lookup(
        self,
        reg: McpToolRegistry,
        tool: McpTool,
    ) -> None:
        reg.register(tool)
        assert len(reg) == 1
        assert reg.get("echo") is tool
        assert "echo" in reg

    def test_duplicate_rejected(
        self,
        reg: McpToolRegistry,
        tool: McpTool,
    ) -> None:
        reg.register(tool)
        with pytest.raises(ValueError, match="duplicate"):
            reg.register(tool)

    def test_unregister(
        self,
        reg: McpToolRegistry,
        tool: McpTool,
    ) -> None:
        reg.register(tool)
        assert reg.unregister("echo") is True
        assert reg.unregister("echo") is False
        assert len(reg) == 0

    def test_list_tools_preserves_order(self, reg: McpToolRegistry) -> None:
        for name in ("a", "b", "c"):
            reg.register(
                McpTool(name=name, description=name, input_schema={}, handler=_echo),
            )
        assert [t.name for t in reg.list_tools()] == ["a", "b", "c"]

    def test_descriptors(self, reg: McpToolRegistry, tool: McpTool) -> None:
        reg.register(tool)
        d = reg.descriptors()
        assert d == [tool.to_descriptor()]

    def test_contains_non_string(self, reg: McpToolRegistry) -> None:
        assert (123 in reg) is False

    @pytest.mark.asyncio
    async def test_invoke_dispatches_handler(
        self,
        reg: McpToolRegistry,
        tool: McpTool,
    ) -> None:
        reg.register(tool)
        result = await reg.invoke("echo", {"hello": "world"})
        assert result == {"echo": {"hello": "world"}}

    @pytest.mark.asyncio
    async def test_invoke_unknown_raises(self, reg: McpToolRegistry) -> None:
        with pytest.raises(KeyError, match="not found"):
            await reg.invoke("missing", {})


@pytest.mark.unit
class TestDefaultRegistry:
    def test_module_singleton(self) -> None:
        # 同じインスタンスが import 経由で共有される
        from src.mcp.tools import default_registry as r2

        assert default_registry is r2
