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
from pathlib import Path
from typing import Any

PROVIDER_ENV = "ATELIER_LLM_PROVIDER"
MODEL_ENV = "ATELIER_AGENT_SDK_MODEL"
WORKSPACE_ENV = "ATELIER_CHAT_WORKSPACE"

# opt-in と認識する値 (小文字比較)。既定・空・"anthropic" は従来経路。
_SUBSCRIPTION_VALUES = frozenset({"agent_sdk", "claude_subscription", "subscription"})

# GAP-129: auto モードで許可する Claude Code ツール (ローカル作業一式)。
# チャット既定 (off) では従来どおり一切許可しない。
_AUTO_TOOLS = ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]


def chat_workspace_dir(env: dict[str, str] | None = None) -> str:
    """auto モードの作業フォルダ (成果物の保存先)。

    既定は ~/AtelierChatWork。ATELIER_CHAT_WORKSPACE で変更可能。
    チャットの PC 操作をこのフォルダ配下に限定する意図はカレントディレクトリ
    としての誘導であり、強制サンドボックスではない (auto は本人 opt-in)。
    """
    e = env if env is not None else dict(os.environ)
    configured = (e.get(WORKSPACE_ENV) or "").strip()
    return configured or str(Path.home() / "AtelierChatWork")


def build_options_kwargs(
    *,
    system_prompt: str,
    tools_mode: str = "off",
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    """ClaudeAgentOptions に渡す kwargs を組み立てる (テスト可能な純粋部分)。

    GAP-129: tools_mode
      - "off"  (既定): ツール一切なし・1 往復のみ (従来のチャット挙動)
      - "auto": Claude Code 同等のローカル作業ツールを許可し、確認なしで
        自動実行する (Claude Code の bypassPermissions と同じ)。作業フォルダ
        (chat_workspace_dir) をカレントにして起動する。
    """
    kwargs: dict[str, Any] = {
        "system_prompt": system_prompt,
        "allowed_tools": [],
        "max_turns": 1,
        "include_partial_messages": True,
    }
    if tools_mode == "auto":
        workspace = chat_workspace_dir(env)
        kwargs.update(
            {
                "system_prompt": system_prompt
                + "\n\nあなたはローカル作業ツール (ファイルの読み書き・コマンド実行) を使えます。"
                + "ファイルの作成・編集はカレントの作業フォルダ内で行い、"
                + "作ったファイルは絶対パスで報告してください。",
                "allowed_tools": list(_AUTO_TOOLS),
                "permission_mode": "bypassPermissions",
                "cwd": workspace,
                "max_turns": 25,
            }
        )
    model = (env if env is not None else dict(os.environ)).get(MODEL_ENV, "").strip()
    if model:
        kwargs["model"] = model
    return kwargs


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


def fold_prompt(history: list[tuple[str, str]], user_message: str) -> str:
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
    rate_limits_out: list[dict[str, Any]] | None = None,
    tools_mode: str = "off",
) -> AsyncIterator[str | dict[str, Any]]:
    """Agent SDK (サブスク認証) で実 stream。

    yield するもの:
      - str: 応答本文の text delta (従来どおり)
      - dict {"tool": name, "detail": ...}: GAP-129 auto モードでのツール実行
        イベント (UI が「Bash を実行中…」等のランタイム状態を実況するための実値)

    include_partial_messages=True で CLI の raw stream event を受け、
    content_block_delta/text_delta を逐次 yield する。partial が一度も
    届かない場合 (旧 CLI 等) は完成 AssistantMessage の TextBlock で代替する。

    GAP-124: 実行中に CLI が発行する RateLimitEvent (5 時間 / 7 日枠の実測
    使用率 — API 応答ヘッダー由来) を rate_limits_out に収集する。
    GAP-129: tools_mode="auto" で Claude Code 同等のローカル作業ツールを許可
    (本人 opt-in、専用作業フォルダをカレントに起動)。
    """
    from claude_agent_sdk import (  # pyright: ignore[reportMissingImports]
        AssistantMessage,
        ClaudeAgentOptions,
        StreamEvent,
        TextBlock,
        query,
    )

    try:
        from claude_agent_sdk import (  # pyright: ignore[reportMissingImports]
            RateLimitEvent,
        )
    except ImportError:  # 旧 SDK — プラン枠観測なしで動作継続 (誠実: 出さない)
        RateLimitEvent = None  # type: ignore[assignment]

    child_env = _subprocess_env()
    options_kwargs = build_options_kwargs(system_prompt=system_prompt, tools_mode=tools_mode)
    if tools_mode == "auto":
        # 作業フォルダを実作成 (無いと CLI が cwd 起動に失敗する)
        Path(str(options_kwargs.get("cwd", ""))).mkdir(parents=True, exist_ok=True)
        # CLI は root での bypassPermissions を拒否する。root で動くのは検証
        # コンテナのみ (実ユーザー機は非 root) — その場合だけ明示フラグを立てる。
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            child_env["IS_SANDBOX"] = "1"
    options_kwargs["env"] = child_env

    saw_partial = False
    async for msg in query(
        prompt=fold_prompt(history, user_message),
        options=ClaudeAgentOptions(**options_kwargs),
    ):
        if isinstance(msg, StreamEvent):
            event: dict[str, Any] = msg.event
            etype = event.get("type")
            if etype == "content_block_start":
                # GAP-129: ツール実行の開始をランタイム状態として通知
                raw_block = event.get("content_block")
                block_d: dict[str, Any] = raw_block if isinstance(raw_block, dict) else {}
                if block_d.get("type") == "tool_use":
                    name = block_d.get("name")
                    if isinstance(name, str) and name:
                        yield {"tool": name}
                continue
            if etype != "content_block_delta":
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
        elif (
            rate_limits_out is not None
            and RateLimitEvent is not None
            and isinstance(msg, RateLimitEvent)
        ):
            info = msg.rate_limit_info
            status = getattr(info, "status", None)
            if status in ("allowed", "allowed_warning", "rejected"):
                rate_limits_out.append(
                    {
                        "status": status,
                        "rate_limit_type": getattr(info, "rate_limit_type", None),
                        "utilization": getattr(info, "utilization", None),
                        "resets_at": getattr(info, "resets_at", None),
                    }
                )
