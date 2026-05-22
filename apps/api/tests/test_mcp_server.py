"""Unit tests for apps/api/src/mcp/server.py (T-F-22)."""

# pyright: reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownLambdaType=false
from __future__ import annotations

import builtins
import sys
from types import ModuleType, SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.mcp.server import SERVER_NAME, SERVER_VERSION, AtelierMcpServer
from src.mcp.tools import McpTool, McpToolRegistry


async def _hi(_: dict[str, Any]) -> str:
    return "hi"


@pytest.mark.unit
class TestServerConstruction:
    def test_defaults(self) -> None:
        s = AtelierMcpServer()
        assert s.name == SERVER_NAME == "atelier"
        assert s.version == SERVER_VERSION

    def test_custom_registry(self) -> None:
        reg = McpToolRegistry()
        s = AtelierMcpServer(registry=reg)
        assert s.registry is reg

    def test_empty_name_rejected(self) -> None:
        with pytest.raises(ValueError, match="name"):
            AtelierMcpServer(name="")


@pytest.mark.unit
class TestListDescriptors:
    def test_empty_registry(self) -> None:
        s = AtelierMcpServer(registry=McpToolRegistry())
        assert s.list_tool_descriptors() == []

    def test_with_tools(self) -> None:
        reg = McpToolRegistry()
        reg.register(
            McpTool(name="hi", description="d", input_schema={}, handler=_hi),
        )
        s = AtelierMcpServer(registry=reg)
        d = s.list_tool_descriptors()
        assert len(d) == 1
        assert d[0]["name"] == "hi"


@pytest.mark.unit
class TestDispatch:
    @pytest.mark.asyncio
    async def test_calls_registry_invoke(self) -> None:
        reg = McpToolRegistry()
        reg.register(
            McpTool(name="hi", description="d", input_schema={}, handler=_hi),
        )
        s = AtelierMcpServer(registry=reg)
        result = await s.dispatch("hi", {})
        assert result == "hi"

    @pytest.mark.asyncio
    async def test_unknown_tool_propagates(self) -> None:
        s = AtelierMcpServer(registry=McpToolRegistry())
        with pytest.raises(KeyError):
            await s.dispatch("missing", {})


@pytest.mark.unit
class TestBuildSdkServer:
    def test_import_error_when_mcp_missing(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        real_import = builtins.__import__

        def fake_import(
            name: str,
            globals_: Any = None,
            locals_: Any = None,
            fromlist: Any = (),
            level: int = 0,
        ) -> Any:
            if name.startswith("mcp.server") or name == "mcp":
                raise ImportError("not installed")
            return real_import(name, globals_, locals_, fromlist, level)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        s = AtelierMcpServer()
        with pytest.raises(ImportError, match="mcp package is not installed"):
            s.build_sdk_server()

    def test_wires_handlers_when_mcp_present(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # mcp.server.Server を stub 化して inject
        fake_server_instance = MagicMock()
        fake_server_instance.list_tools.return_value = lambda fn: fn
        fake_server_instance.call_tool.return_value = lambda fn: fn

        fake_server_module = ModuleType("mcp.server")
        fake_server_module.Server = MagicMock(return_value=fake_server_instance)  # type: ignore[attr-defined]
        fake_mcp_root = ModuleType("mcp")
        fake_mcp_root.server = fake_server_module  # type: ignore[attr-defined]
        monkeypatch.setitem(sys.modules, "mcp", fake_mcp_root)
        monkeypatch.setitem(sys.modules, "mcp.server", fake_server_module)

        reg = McpToolRegistry()
        reg.register(
            McpTool(name="hi", description="d", input_schema={}, handler=_hi),
        )
        s = AtelierMcpServer(registry=reg)
        sdk = s.build_sdk_server()
        assert sdk is fake_server_instance
        fake_server_instance.list_tools.assert_called_once()
        fake_server_instance.call_tool.assert_called_once()


@pytest.mark.unit
class TestServeStdio:
    @pytest.mark.asyncio
    async def test_import_error_when_mcp_missing(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        real_import = builtins.__import__

        def fake_import(
            name: str,
            globals_: Any = None,
            locals_: Any = None,
            fromlist: Any = (),
            level: int = 0,
        ) -> Any:
            if name.startswith("mcp"):
                raise ImportError
            return real_import(name, globals_, locals_, fromlist, level)

        monkeypatch.setattr(builtins, "__import__", fake_import)
        s = AtelierMcpServer()
        with pytest.raises(ImportError, match="mcp package is not installed"):
            await s.serve_stdio()

    @pytest.mark.asyncio
    async def test_runs_when_mcp_present(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        # serve_stdio は build_sdk_server() + stdio_server() を呼ぶ
        fake_server_instance = MagicMock()
        fake_server_instance.list_tools.return_value = lambda fn: fn
        fake_server_instance.call_tool.return_value = lambda fn: fn
        fake_server_instance.run = AsyncMock()
        fake_server_instance.create_initialization_options.return_value = {}

        fake_server_module = ModuleType("mcp.server")
        fake_server_module.Server = MagicMock(return_value=fake_server_instance)  # type: ignore[attr-defined]

        # stdio_server は async context manager を返す
        class FakeStdioCtx:
            async def __aenter__(self) -> tuple[Any, Any]:
                return ("read", "write")

            async def __aexit__(
                self,
                *_: object,
            ) -> bool:
                return False

        fake_stdio_module = ModuleType("mcp.server.stdio")
        fake_stdio_module.stdio_server = MagicMock(return_value=FakeStdioCtx())  # type: ignore[attr-defined]

        fake_mcp_root = ModuleType("mcp")
        fake_mcp_root.server = fake_server_module  # type: ignore[attr-defined]

        monkeypatch.setitem(sys.modules, "mcp", fake_mcp_root)
        monkeypatch.setitem(sys.modules, "mcp.server", fake_server_module)
        monkeypatch.setitem(sys.modules, "mcp.server.stdio", fake_stdio_module)

        s = AtelierMcpServer()
        await s.serve_stdio()
        fake_server_instance.run.assert_awaited_once()


@pytest.mark.unit
class TestWireHandlers:
    @pytest.mark.asyncio
    async def test_handlers_dispatch_via_registry(self) -> None:
        """_wire_handlers 内で decorator が return する関数が registry を叩くか。"""
        captured: dict[str, Any] = {}

        def list_decorator(fn: Any) -> Any:
            captured["list"] = fn
            return fn

        def call_decorator(fn: Any) -> Any:
            captured["call"] = fn
            return fn

        sdk = SimpleNamespace(
            list_tools=lambda: list_decorator,
            call_tool=lambda: call_decorator,
        )
        reg = McpToolRegistry()
        reg.register(
            McpTool(name="hi", description="d", input_schema={}, handler=_hi),
        )
        s = AtelierMcpServer(registry=reg)
        s._wire_handlers(sdk)
        assert "list" in captured
        assert "call" in captured

        # list_tools handler は descriptors を返す
        result = await captured["list"]()
        assert isinstance(result, list)
        assert result[0]["name"] == "hi"

        # call_tool handler は registry.invoke を呼ぶ
        result2 = await captured["call"]("hi", {})
        assert result2 == "hi"
