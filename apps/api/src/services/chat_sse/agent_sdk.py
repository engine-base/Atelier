# pyright: reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnknownMemberType=false
# (claude-agent-sdk は optional dep で CI 環境に無く import が Unknown になるため。
#  src/mcp/server.py の mcp SDK と同じ抑制方針)
"""GAP-113: Claude サブスクリプション (Agent SDK) チャットアダプタ。

S-E01 チャットの LLM 呼出を、Anthropic API (従量課金) ではなく
**オーナー自身の Claude サブスクリプション** (Claude Code / Agent SDK 認証) で
行うための opt-in プロバイダ。

規約上の位置づけ (2026-08 時点の公式ヘルプに基づく):
- Agent SDK のサブスク認証は「自分のプロンプト・自分の仕事だけを処理する
  パーソナルユース」に限り許可される。
- したがって本モードは **セルフホスト個人インスタンス専用**。ホスト版 (顧客が
  使う本番) では有効化してはならない — そちらは BYOK / 運営 API キーを使う。
- 有効化は環境変数 `ATELIER_LLM_PROVIDER=agent_sdk` の明示 opt-in のみ。
  既定 (未設定) では従来どおり Anthropic API 経路。

動作要件 (実行ホスト側):
- `claude` CLI がインストールされ、サブスクアカウントでログイン済みであること
  (または `claude setup-token` で発行した CLAUDE_CODE_OAUTH_TOKEN が env にあること)。
- `claude-agent-sdk` (PyPI) がインストール済みであること。optional dep のため
  未インストール環境 (CI 等) でも本モジュールの import 自体は成功する (遅延 import —
  src/mcp/server.py の mcp SDK と同じ方針)。

v1 の制限 (誠実表示: 隠さず gap-tracker GAP-113 に記録):
- Atelier ツール (save_deliverable 等の agentic ループ) は本モードでは未注入。
  テキスト応答 + RAG/ペルソナ文脈のみ。ツール実行が必要な会話は API 経路を使う。
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from typing import Any

PROVIDER_ENV = "ATELIER_LLM_PROVIDER"
MODEL_ENV = "ATELIER_AGENT_SDK_MODEL"

# opt-in と認識する値 (小文字比較)。既定・空・"anthropic" は従来経路。
_SUBSCRIPTION_VALUES = frozenset({"agent_sdk", "claude_subscription", "subscription"})


def subscription_mode_enabled() -> bool:
    """ATELIER_LLM_PROVIDER がサブスクモードを指しているか。"""
    return os.environ.get(PROVIDER_ENV, "").strip().lower() in _SUBSCRIPTION_VALUES


def sdk_available() -> bool:
    """claude-agent-sdk が import 可能か (未導入 CI では False)。"""
    try:
        import claude_agent_sdk  # noqa: F401  # pyright: ignore[reportMissingImports,reportUnusedImport]
    except Exception:
        return False
    return True


def _fold_prompt(history: list[tuple[str, str]], user_message: str) -> str:
    """history + 新規メッセージを単一プロンプトに畳む。

    Agent SDK の query() は単発プロンプト I/F のため、直近履歴をテキストで
    前置する (API 経路の messages 配列と同じ情報量を保つ)。
    """
    if not history:
        return user_message
    lines: list[str] = ["これまでの会話:"]
    for role, content in history:
        if role in ("user", "assistant"):
            label = "ユーザー" if role == "user" else "アシスタント"
            lines.append(f"[{label}] {content}")
    lines.append("")
    lines.append(f"新しいユーザーメッセージ (これに応答する): {user_message}")
    return "\n".join(lines)


def _subprocess_env() -> dict[str, str]:
    """CLI 子プロセスへ渡す env。

    ANTHROPIC_API_KEY を必ず除外する — 残っていると OAuth より優先されて
    **黙って API 従量課金に切り替わる** (flow-kit の ccstart.sh:113 と同じ理由)。
    同系統の ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_API_KEY も外す。
    """
    drop = {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_API_KEY"}
    return {k: v for k, v in os.environ.items() if k not in drop}


async def agent_sdk_stream_chunks(
    *,
    system_prompt: str,
    history: list[tuple[str, str]],
    user_message: str,
) -> AsyncIterator[str]:
    """Agent SDK (サブスク認証) で実 stream。text delta を yield する。

    include_partial_messages=True で CLI の raw stream event を受け、
    content_block_delta/text_delta を逐次 yield する。partial が一度も
    届かない場合 (旧 CLI 等) は完成 AssistantMessage の TextBlock で代替する。
    """
    from claude_agent_sdk import (  # pyright: ignore[reportMissingImports]
        AssistantMessage,
        ClaudeAgentOptions,
        StreamEvent,
        TextBlock,
        query,
    )

    options_kwargs: dict[str, Any] = {
        "system_prompt": system_prompt,
        # チャット応答専用: CLI 側ツール (ファイル編集/Bash 等) は一切許可しない。
        "allowed_tools": [],
        "max_turns": 1,
        "include_partial_messages": True,
        "env": _subprocess_env(),
    }
    model = os.environ.get(MODEL_ENV, "").strip()
    if model:
        options_kwargs["model"] = model

    saw_partial = False
    async for msg in query(
        prompt=_fold_prompt(history, user_message),
        options=ClaudeAgentOptions(**options_kwargs),
    ):
        if isinstance(msg, StreamEvent):
            event: dict[str, Any] = msg.event
            if event.get("type") != "content_block_delta":
                continue
            raw_delta = event.get("delta")
            delta: dict[str, Any] = raw_delta if isinstance(raw_delta, dict) else {}
            if delta.get("type") != "text_delta":
                continue
            text = delta.get("text")
            if isinstance(text, str) and text:
                saw_partial = True
                yield text
        elif isinstance(msg, AssistantMessage) and not saw_partial:
            for block in msg.content:
                if isinstance(block, TextBlock) and block.text:
                    yield block.text
