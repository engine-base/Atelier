"""GAP-138: 単発 LLM 呼出の共通チェーン (relay → agent_sdk → API → fake)。

チャット SSE 以外の機能 (モック生成/改訂、要約 等) が LLM を 1 往復だけ
使いたいとき、確定アーキテクチャの費用順で解決する:

    1. relay        — ユーザー PC の Bridge = 本人の Claude サブスク (標準)
    2. agent_sdk    — サーバー内 claude CLI = オーナーのサブスク (個人インスタンス)
    3. ANTHROPIC_API_KEY — 従量課金 (明示設定時のみ)
    4. fake         — ATELIER_ALLOW_FAKE_LLM=1 のテスト経路のみ

誠実設計: relay モードで Bridge がオフラインのときは **黙って API 課金に
落とさず** LLMUnavailable("bridge_offline") を上げる (呼び出し側がユーザーへ
「Bridge を起動してください」を返す)。どの経路も無ければ "unconfigured"。
"""

from __future__ import annotations

import os
from collections.abc import Callable

DEFAULT_API_MODEL = os.environ.get("ATELIER_DESIGN_MODEL", "claude-sonnet-4-6")


class LLMUnavailable(Exception):
    """実行経路が使えない (code: bridge_offline / unconfigured / failed)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def llm_complete(
    *,
    system_prompt: str,
    user_text: str,
    actor_id: str,
    thread_id: str | None = None,
    max_tokens: int = 4096,
    fake: Callable[[], str] | None = None,
) -> tuple[str, str]:
    """1 往復の LLM 補完。(text, provider) を返す。

    provider は "relay" / "agent_sdk" / "api" / "fake" — 呼び出し側が
    meta (どの費用で生成されたか) に記録する。空応答は failed。
    """
    from .agent_sdk import sdk_available, subscription_mode_enabled
    from .relay import RelayUnavailable, relay_mode_enabled

    if relay_mode_enabled():
        from .relay import relay_stream_chunks

        try:
            parts = [
                c
                async for c in relay_stream_chunks(
                    system_prompt=system_prompt,
                    history=[],
                    user_message=user_text,
                    thread_id=thread_id,
                    actor_id=actor_id,
                )
                if isinstance(c, str)
            ]
        except RelayUnavailable:
            raise LLMUnavailable(
                "bridge_offline",
                "お使いの PC の Bridge がオフラインのため AI 実行ができません。"
                "Bridge アプリを起動してから再実行してください。",
            ) from None
        except Exception as exc:
            raise LLMUnavailable("failed", f"ローカル実行が失敗しました: {exc}") from exc
        out = "".join(parts).strip()
        if out == "":
            raise LLMUnavailable("failed", "ローカル実行が空の応答を返しました")
        return out, "relay"

    if subscription_mode_enabled() and sdk_available():
        from .agent_sdk import agent_sdk_stream_chunks

        try:
            chunks = agent_sdk_stream_chunks(
                system_prompt=system_prompt, history=[], user_message=user_text
            )
            out = "".join([c async for c in chunks if isinstance(c, str)]).strip()
        except Exception as exc:
            raise LLMUnavailable("failed", f"サブスク実行が失敗しました: {exc}") from exc
        if out == "":
            raise LLMUnavailable("failed", "サブスク実行が空の応答を返しました")
        return out, "agent_sdk"

    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            from anthropic import AsyncAnthropic  # type: ignore[import-not-found]

            client = AsyncAnthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
            msg = await client.messages.create(
                model=DEFAULT_API_MODEL,
                max_tokens=max_tokens,
                system=system_prompt,
                messages=[{"role": "user", "content": user_text}],
            )
            out = "".join(
                str(getattr(b, "text", "")) for b in msg.content if getattr(b, "type", "") == "text"
            ).strip()
        except Exception as exc:
            raise LLMUnavailable("failed", f"API 実行が失敗しました: {exc}") from exc
        if out == "":
            raise LLMUnavailable("failed", "API が空の応答を返しました")
        return out, "api"

    if fake is not None and os.environ.get("ATELIER_ALLOW_FAKE_LLM") == "1":
        return fake(), "fake"

    raise LLMUnavailable(
        "unconfigured",
        "利用できる LLM 実行経路がありません (Bridge / サブスク / API キーのいずれも未設定)",
    )
