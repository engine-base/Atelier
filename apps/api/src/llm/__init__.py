"""LLM クライアント抽象化。

設計方針（03_architecture/selected-stack.json#llm_client_abstraction）:
  - 自前 LLMClient (30-100 行)。重い抽象化に依存せず公式 SDK 直叩き。
  - Phase 0: Anthropic SDK + Claude Agent SDK のみ実装。
  - v2: GPT/Gemini を後段で追加。Protocol で型を揃え、provider 切替を可能にする。

呼び出し側は LLMClient プロトコルだけを知れば良い。具体 client (AnthropicClient,
OpenAIClient) は環境変数や config で選択。
"""

from .client import (
    LLMClient,
    LLMMessage,
    LLMResponse,
    LLMRole,
    LLMUsage,
    select_client,
)

__all__ = [
    "LLMClient",
    "LLMMessage",
    "LLMResponse",
    "LLMRole",
    "LLMUsage",
    "select_client",
]
