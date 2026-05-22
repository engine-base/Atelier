"""MCP tool 定義と registry (T-F-22)。

MCP の tool は {name, description, input_schema (JSON Schema), handler} で
記述される。本モジュールはそれを type-safe な dataclass + registry として
表現する。実 SDK との接続は server.py が担う。

設計方針:
- pure: SDK / 外部 I/O への依存なし。test 容易性最優先。
- handler は async callable。registry が dispatch する。
- duplicate 登録は ValueError。registry は mutable だが register/invoke は
  単一スレッド前提 (asyncio event loop 内呼び出し)。
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

McpHandler = Callable[[dict[str, Any]], Awaitable[Any]]
"""tool handler の型。MCP request の arguments (dict) を受けて結果を返す。"""


@dataclass(frozen=True)
class McpTool:
    """MCP tool 1 件分の宣言。

    Anthropic MCP spec の Tool 形 (name / description / inputSchema) と
    対応する。JSON Schema は dict[str, Any] で保持する (Pydantic との
    duplicate 防止)。
    """

    name: str
    description: str
    input_schema: dict[str, Any]
    handler: McpHandler = field(repr=False)

    def __post_init__(self) -> None:
        if not self.name:
            raise ValueError("McpTool.name must be non-empty")
        if not self.description:
            raise ValueError("McpTool.description must be non-empty")
        if not isinstance(self.input_schema, dict):  # pyright: ignore[reportUnnecessaryIsInstance]
            raise TypeError("McpTool.input_schema must be a dict (JSON Schema)")

    def to_descriptor(self) -> dict[str, Any]:
        """MCP SDK が解釈する dict 形に変換する (handler は除外)。"""
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": dict(self.input_schema),
        }


class McpToolRegistry:
    """tool の登録 / lookup / dispatch を担う。

    duplicate 登録は ValueError。空 registry でも list() / get() は安全に
    動作する (空 list / None)。
    """

    def __init__(self) -> None:
        self._tools: dict[str, McpTool] = {}

    def register(self, tool: McpTool) -> None:
        """tool を登録する。同名既存があれば ValueError。"""
        if tool.name in self._tools:
            raise ValueError(f"duplicate MCP tool name: {tool.name!r}")
        self._tools[tool.name] = tool

    def unregister(self, name: str) -> bool:
        """name を取り除く。存在したら True、無ければ False。"""
        return self._tools.pop(name, None) is not None

    def get(self, name: str) -> McpTool | None:
        return self._tools.get(name)

    def list_tools(self) -> list[McpTool]:
        """登録順を保った tool list を返す (dict insertion order に依存)。"""
        return list(self._tools.values())

    def descriptors(self) -> list[dict[str, Any]]:
        """SDK 向け descriptor list (handler 除外) を返す。"""
        return [t.to_descriptor() for t in self._tools.values()]

    async def invoke(self, name: str, arguments: dict[str, Any]) -> Any:
        """name に対応する tool を arguments で起動する。

        Raises:
            KeyError: name が未登録。
        """
        tool = self._tools.get(name)
        if tool is None:
            raise KeyError(f"MCP tool not found: {name!r}")
        return await tool.handler(arguments)

    def __len__(self) -> int:
        return len(self._tools)

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and name in self._tools


default_registry = McpToolRegistry()
"""プロセス共有のデフォルト registry。app 起動時に各モジュールが register する。"""


__all__ = [
    "McpHandler",
    "McpTool",
    "McpToolRegistry",
    "default_registry",
]
