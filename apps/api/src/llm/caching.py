"""Anthropic Prompt Caching ヘルパ (T-F-15)。

Anthropic Messages API の `cache_control: {"type": "ephemeral"}` を content block
に付与するための type-safe ユーティリティ。

参照:
- https://docs.claude.com/en/docs/build-with-claude/prompt-caching
- 5 分 TTL の ephemeral cache。1024+ token のシステムプロンプト / context に
  cache_control を付けることで以降の同一プレフィックスは 90% 課金減 + 高速化。

設計方針:
- pure module (SDK 直叩きなし)。content dict を変換するだけ。
- 呼び出し側は `cache_system_prompt()` / `mark_cacheable()` で Anthropic に渡す
  payload を整形してから `messages.create(system=..., messages=...)` に注入する。
"""

from __future__ import annotations

from typing import Any, Literal

EPHEMERAL: Literal["ephemeral"] = "ephemeral"
"""Anthropic prompt cache の唯一のタイプ (2026-05 時点)。"""

MIN_CACHEABLE_TOKENS = 1024
"""Anthropic 推奨の最小 cacheable トークン数 (sonnet/haiku 共通)。"""


def _cache_control() -> dict[str, str]:
    return {"type": EPHEMERAL}


def cache_system_prompt(system_text: str) -> list[dict[str, Any]]:
    """system 引数を ephemeral cache 付き block list に変換する。

    Anthropic SDK は system に文字列 / block list 両方を受け入れる。block list
    形式に変換することで cache_control 注入が可能になる。

    Args:
        system_text: system プロンプト文字列。空文字列は空 list を返す。

    Returns:
        例: [{"type": "text", "text": "...", "cache_control": {"type": "ephemeral"}}]
    """
    if not system_text:
        return []
    return [
        {
            "type": "text",
            "text": system_text,
            "cache_control": _cache_control(),
        }
    ]


def mark_cacheable(block: dict[str, Any]) -> dict[str, Any]:
    """既存の content block に cache_control を付与した新しい block を返す (immutable)。

    Args:
        block: Anthropic content block dict (例: {"type": "text", "text": "..."})。

    Returns:
        cache_control が付与された新しい block。元の block は変更しない。
    """
    return {**block, "cache_control": _cache_control()}


def mark_last_message_cacheable(
    messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """messages 末尾の最後の text block に cache_control を付与した新 list を返す。

    会話履歴の長い prefix を再利用するときの最頻パターン。元 list は変更しない。

    Args:
        messages: Anthropic messages 形式。content は str または block list。

    Returns:
        cache_control を付与した新 messages list。messages が空なら空 list。
    """
    if not messages:
        return []
    out = [dict(m) for m in messages]
    last = out[-1]
    content = last.get("content")
    if isinstance(content, str):
        last["content"] = [
            {
                "type": "text",
                "text": content,
                "cache_control": _cache_control(),
            }
        ]
        return out
    if isinstance(content, list):
        blocks: list[Any] = list(content)  # type: ignore[arg-type]
        if not blocks:
            return out
        last_block = blocks[-1]
        if isinstance(last_block, dict):
            typed_block: dict[str, Any] = last_block  # type: ignore[assignment]
            blocks[-1] = mark_cacheable(typed_block)
            last["content"] = blocks
    return out


def estimate_should_cache(approx_tokens: int) -> bool:
    """approx_tokens が cache 推奨閾値以上か判定する。

    1024 token 未満では cache_write のオーバーヘッドが回収できないため、
    呼び出し側で cache_control を付けるかどうかの判断に使う。
    """
    return approx_tokens >= MIN_CACHEABLE_TOKENS


__all__ = [
    "EPHEMERAL",
    "MIN_CACHEABLE_TOKENS",
    "cache_system_prompt",
    "estimate_should_cache",
    "mark_cacheable",
    "mark_last_message_cacheable",
]
