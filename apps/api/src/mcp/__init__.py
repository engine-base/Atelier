"""Atelier MCP (Model Context Protocol) Server 同居レイヤ (T-F-22)。

API プロセスに MCP server を同居させ、外部 AI client (Claude Desktop / 自社 AI 社員)
から Atelier の業務オペレーション (project/task CRUD / RAG 検索 / 議事録抽出) を
tool として呼び出させる。

設計方針:
- tools.py: pure な tool 定義 + registry (依存なし、テスト容易)
- server.py: 公式 mcp SDK の薄いラッパ (遅延 import で test env 非依存)
"""

from .server import AtelierMcpServer
from .tools import McpTool, McpToolRegistry, default_registry

__all__ = [
    "AtelierMcpServer",
    "McpTool",
    "McpToolRegistry",
    "default_registry",
]
