# pyright: reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnusedFunction=false
"""Atelier MCP Server 同居実装 (T-F-22)。

API プロセスに MCP server を「同居」させ、外部 AI client から Atelier の
業務 tool を呼び出せるようにする。本モジュールは公式 mcp SDK の薄いラッパ。

参照:
- https://modelcontextprotocol.io/
- https://github.com/modelcontextprotocol/python-sdk

設計方針:
- mcp SDK は optional dep (T-F-22 scope では未追加)。遅延 import で
  test/CI を mcp 不在で通す。production 起動時に install する。
- AtelierMcpServer は McpToolRegistry を bind し、SDK の Server 実体を
  build する。serve_stdio() は SDK が import 済の前提で実呼び出し。
"""

from __future__ import annotations

import logging
from typing import Any

from .tools import McpToolRegistry, default_registry

logger = logging.getLogger(__name__)

SERVER_NAME = "atelier"
SERVER_VERSION = "0.1.0"


class AtelierMcpServer:
    """MCP server の Atelier 統合層。

    registry に登録された tool を SDK の handler に bridge する。serve_stdio()
    呼び出し時に mcp SDK を import する (遅延)。
    """

    def __init__(
        self,
        *,
        registry: McpToolRegistry | None = None,
        name: str = SERVER_NAME,
        version: str = SERVER_VERSION,
    ) -> None:
        self.registry = registry if registry is not None else default_registry
        self.name = name
        self.version = version
        if not self.name:
            raise ValueError("AtelierMcpServer.name must be non-empty")

    def list_tool_descriptors(self) -> list[dict[str, Any]]:
        """SDK 向け descriptor list を返す (handler は除外)。"""
        return self.registry.descriptors()

    async def dispatch(self, name: str, arguments: dict[str, Any]) -> Any:
        """tool 名と arguments で registry を介して handler を呼ぶ。

        SDK の call_tool handler から呼び出される統一エントリポイント。
        """
        logger.info(
            "mcp dispatch: server=%s tool=%s",
            self.name,
            name,
        )
        return await self.registry.invoke(name, arguments)

    def build_sdk_server(self) -> Any:
        """公式 mcp SDK の Server インスタンスを生成して返す。

        Raises:
            ImportError: mcp package が未インストール。
        """
        try:
            from mcp.server import Server  # type: ignore[import-not-found]
        except ImportError as exc:
            raise ImportError(
                "mcp package is not installed. Add `mcp` to apps/api deps "
                "via a separate tickets.json scope-expand PR.",
            ) from exc

        sdk_server = Server(self.name)
        self._wire_handlers(sdk_server)
        return sdk_server

    def _wire_handlers(self, sdk_server: Any) -> None:
        """SDK Server に list_tools / call_tool handler を bind する。"""

        @sdk_server.list_tools()
        async def _list_tools() -> list[Any]:
            return self.list_tool_descriptors()

        @sdk_server.call_tool()
        async def _call_tool(name: str, arguments: dict[str, Any]) -> Any:
            return await self.dispatch(name, arguments)

    async def serve_stdio(self) -> None:
        """stdio transport で MCP server を実起動する (production 経路)。

        Raises:
            ImportError: mcp package が未インストール。
        """
        try:
            from mcp.server.stdio import stdio_server  # type: ignore[import-not-found]
        except ImportError as exc:
            raise ImportError(
                "mcp package is not installed. See build_sdk_server() for hint.",
            ) from exc

        sdk_server = self.build_sdk_server()
        async with stdio_server() as (read_stream, write_stream):
            await sdk_server.run(
                read_stream,
                write_stream,
                sdk_server.create_initialization_options(),
            )


__all__ = [
    "SERVER_NAME",
    "SERVER_VERSION",
    "AtelierMcpServer",
]
