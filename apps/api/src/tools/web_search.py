"""Anthropic web_search server-side tool 統合 (T-F-21)。

selected-stack.json#web_search = "Claude 公式 web_search (Anthropic API 内蔵)"。
Anthropic Messages API の `tools` パラメータに渡す server-tool descriptor を
type-safe に組み立てるユーティリティ層。

仕様参照:
- https://docs.claude.com/en/docs/build-with-claude/tool-use/web-search-tool
- tool type identifier: "web_search_20250305"
- name: "web_search"

設計方針:
- 本モジュールは pure (副作用なし)。実 HTTP 呼び出しは SDK が server-side で実行する。
- 呼び出し側 (T-F-12 AnthropicClient) は `build_web_search_tool(...)` で descriptor を
  得て `messages.create(tools=[...])` に注入する。
- response から web_search 使用を検出するヘルパも提供 (cost/audit 用)。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, TypedDict

WEB_SEARCH_TOOL_TYPE: Literal["web_search_20250305"] = "web_search_20250305"
"""Anthropic 公式 web_search tool の type identifier (2025-03-05 版)。"""

WEB_SEARCH_TOOL_NAME: Literal["web_search"] = "web_search"
"""tools[].name に入れる識別子。"""

DEFAULT_MAX_USES = 5
"""1 リクエスト中の web_search 呼び出し回数の既定上限 (Anthropic 推奨)。"""


class UserLocation(TypedDict, total=False):
    """検索結果の地域バイアスに使う optional な user_location。"""

    type: Literal["approximate"]
    city: str
    region: str
    country: str
    timezone: str


@dataclass(frozen=True)
class WebSearchToolConfig:
    """web_search tool 設定。Anthropic SDK 用 dict に変換する DTO。

    Attributes:
        max_uses: 1 リクエストあたりの最大検索回数 (1 以上)。
        allowed_domains: 検索対象を限定するドメイン一覧 (None で無制限)。
        blocked_domains: 検索対象から除外するドメイン一覧 (None で無し)。
        user_location: 地域バイアス情報 (None で無し)。

    Invariants:
        - max_uses >= 1
        - allowed_domains と blocked_domains は同時指定不可 (Anthropic 仕様)
    """

    max_uses: int = DEFAULT_MAX_USES
    allowed_domains: tuple[str, ...] | None = None
    blocked_domains: tuple[str, ...] | None = None
    user_location: UserLocation | None = field(default=None)

    def __post_init__(self) -> None:
        if self.max_uses < 1:
            raise ValueError(f"max_uses must be >= 1, got {self.max_uses}")
        if self.allowed_domains is not None and self.blocked_domains is not None:
            raise ValueError(
                "allowed_domains and blocked_domains are mutually exclusive "
                "(Anthropic web_search tool spec)"
            )


def build_web_search_tool(
    config: WebSearchToolConfig | None = None,
) -> dict[str, Any]:
    """Anthropic messages.create(tools=[...]) に渡す descriptor を構築する。

    Args:
        config: 設定。None なら DEFAULT_MAX_USES のみで他は未設定。

    Returns:
        Anthropic SDK が解釈する tool descriptor dict。
        例: {"type": "web_search_20250305", "name": "web_search", "max_uses": 5}
    """
    cfg = config or WebSearchToolConfig()
    descriptor: dict[str, Any] = {
        "type": WEB_SEARCH_TOOL_TYPE,
        "name": WEB_SEARCH_TOOL_NAME,
        "max_uses": cfg.max_uses,
    }
    if cfg.allowed_domains is not None:
        descriptor["allowed_domains"] = list(cfg.allowed_domains)
    if cfg.blocked_domains is not None:
        descriptor["blocked_domains"] = list(cfg.blocked_domains)
    if cfg.user_location is not None:
        descriptor["user_location"] = dict(cfg.user_location)
    return descriptor


def is_web_search_tool_use(block: object) -> bool:
    """Anthropic response content block が web_search の tool_use か判定する。

    SDK の response.content は heterogeneous list (TextBlock / ToolUseBlock /
    ServerToolUseBlock 等) なので duck-typing で判定する。
    """
    block_type = getattr(block, "type", None)
    if block_type in ("server_tool_use", "web_search_tool_result"):
        name = getattr(block, "name", None)
        if name is None or name == WEB_SEARCH_TOOL_NAME:
            return True
    return False


def count_web_search_invocations(content: list[object]) -> int:
    """response.content から web_search 起動回数を集計する (cost/audit 用)。"""
    return sum(1 for b in content if is_web_search_tool_use(b))


__all__ = [
    "DEFAULT_MAX_USES",
    "WEB_SEARCH_TOOL_NAME",
    "WEB_SEARCH_TOOL_TYPE",
    "UserLocation",
    "WebSearchToolConfig",
    "build_web_search_tool",
    "count_web_search_invocations",
    "is_web_search_tool_use",
]
