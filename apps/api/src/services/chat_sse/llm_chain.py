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
from typing import Any, Protocol

DEFAULT_API_MODEL = os.environ.get("ATELIER_DESIGN_MODEL", "claude-sonnet-4-6")

API_BILLING_ENV = "ATELIER_ALLOW_API_BILLING"


def api_billing_allowed() -> bool:
    """運営の `ANTHROPIC_API_KEY` (従量課金) を使ってよいか。

    GAP-175: **既定は禁止**。確定アーキテクチャでは利用者向けの AI 実行は
    すべて本人の Claude サブスク (Bridge) で動くので、運営のキーに落ちるのは
    設計違反かつ課金事故になる。以前は「キーが環境にあれば黙って使う」動作で、
    Bridge が繋がっていない全ユーザー分が運営持ちになりうる状態だった。

    BYOK / セルフホスト等でどうしても API 課金を使う場合だけ
    `ATELIER_ALLOW_API_BILLING=1` を明示する。
    (運営バッチであるナレッジ自動キュレーションはこの経路を通らず、
     元から運営負担と決めているので影響しない。)
    """
    # GAP-178: 判定は llm_route.resolve_llm_route() に集約 (env を読む場所を 1 つに)。
    # 主経路が api のとき、および「Bridge 未接続時の肩代わり」を明示許可した
    # ときだけ真。既定ではどちらも成立しない = 運営に費用は発生しない。
    from .llm_route import resolve_llm_route

    route = resolve_llm_route()
    return route.route == "api" or route.api_fallback_allowed


class LLMUnavailable(Exception):
    """実行経路が使えない。

    code:
      - bridge_offline : 利用者の PC が繋がっていない (後で再試行すれば成功しうる)
      - rate_limited   : 本人の Claude プラン枠が上限 (GAP-184 — 必ずリセットされる)
      - unconfigured   : 経路が 1 つも無い
      - failed         : 実行したが失敗した (恒久的)
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


#: GAP-184: Claude CLI / API が上限で止まったときに出る語 (実測ベース)。
_RATE_LIMIT_MARKERS = (
    "rate limit",
    "rate_limit",
    "usage limit",
    "usage_limit",
    "5-hour limit",
    "five hour limit",
    "quota",
    "上限",
    "利用枠",
)


def _looks_rate_limited(message: str) -> bool:
    """エラー文面が「プラン枠の上限」を指しているか。

    上限は時間が経てば必ず解消するので、恒久的な失敗と混ぜてはいけない。
    """
    low = message.lower()
    return any(marker in low for marker in _RATE_LIMIT_MARKERS)


async def llm_stream(
    *,
    system_prompt: str,
    user_text: str,
    actor_id: str,
    thread_id: str | None = None,
    max_tokens: int = 4096,
    fake: Callable[[], str] | None = None,
):
    """1 往復の LLM 補完を逐次 yield する (GAP-147: 進行状況の可視化用)。

    yield: ("provider", name) を最初に 1 回 → ("delta", text) を逐次。
    経路の解決順・誠実設計は llm_complete と同一。API 経路 (非ストリーム) と
    fake は 1 回で全文を yield する。
    """
    from .agent_sdk import sdk_available, subscription_mode_enabled
    from .relay import RelayUnavailable, relay_mode_enabled

    if relay_mode_enabled():
        from .relay import relay_stream_chunks

        yield ("provider", "relay")
        got = False
        try:
            async for c in relay_stream_chunks(
                system_prompt=system_prompt,
                history=[],
                user_message=user_text,
                thread_id=thread_id,
                actor_id=actor_id,
            ):
                if isinstance(c, str):
                    got = True
                    yield ("delta", c)
        except RelayUnavailable:
            # GAP-175: relay が既定になったので、テスト専用 fake だけは
            # 明示 opt-in (ATELIER_ALLOW_FAKE_LLM=1) のときに使う。
            # 本番ではこの env は設定しないので、必ず正直に断る。
            if fake is not None and os.environ.get("ATELIER_ALLOW_FAKE_LLM") == "1":
                yield ("provider", "fake")
                yield ("delta", fake())
                return
            raise LLMUnavailable(
                "bridge_offline",
                "お使いの PC の Bridge がオフラインのため AI 実行ができません。"
                "Bridge アプリを起動してから再実行してください。",
            ) from None
        except LLMUnavailable:
            raise
        except Exception as exc:
            raise LLMUnavailable("failed", f"ローカル実行が失敗しました: {exc}") from exc
        if not got:
            raise LLMUnavailable("failed", "ローカル実行が空の応答を返しました")
        return

    if subscription_mode_enabled() and sdk_available():
        from .agent_sdk import agent_sdk_stream_chunks

        yield ("provider", "agent_sdk")
        got = False
        try:
            async for c in agent_sdk_stream_chunks(
                system_prompt=system_prompt, history=[], user_message=user_text
            ):
                if isinstance(c, str):
                    got = True
                    yield ("delta", c)
        except LLMUnavailable:
            raise
        except Exception as exc:
            raise LLMUnavailable("failed", f"サブスク実行が失敗しました: {exc}") from exc
        if not got:
            raise LLMUnavailable("failed", "サブスク実行が空の応答を返しました")
        return

    # API / fake は非ストリーム — llm_complete に委譲して 1 回で返す
    out, provider = await llm_complete(
        system_prompt=system_prompt,
        user_text=user_text,
        actor_id=actor_id,
        thread_id=thread_id,
        max_tokens=max_tokens,
        fake=fake,
    )
    yield ("provider", provider)
    yield ("delta", out)


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
            # GAP-175: relay が既定。テスト専用 fake のみ明示 opt-in で許す
            # (本番では ATELIER_ALLOW_FAKE_LLM を設定しないので必ず断る)。
            if fake is not None and os.environ.get("ATELIER_ALLOW_FAKE_LLM") == "1":
                return fake(), "fake"
            raise LLMUnavailable(
                "bridge_offline",
                "お使いの PC の Bridge がオフラインのため AI 実行ができません。"
                "Bridge アプリを起動してから再実行してください。",
            ) from None
        except Exception as exc:
            # GAP-184: 本人プランの上限 (5 時間 / 7 日) は必ずリセットされる。
            # 「失敗」で確定させると解析や自動実行が永久に欠ける (GAP-177 と同じ罠)。
            if _looks_rate_limited(str(exc)):
                raise LLMUnavailable(
                    "rate_limited",
                    "お使いの Claude プランの利用枠が上限に達しています。"
                    "枠がリセットされたら自動で再実行します。",
                ) from exc
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

    if api_billing_allowed() and os.environ.get("ANTHROPIC_API_KEY"):
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
        "bridge_offline",
        "お使いの PC の Bridge がオフラインのため AI 実行ができません。"
        "Bridge アプリを起動してから再実行してください。",
    )


class InjectedCompletionClient(Protocol):
    """テストが注入する 1 往復クライアント (実 LLM の代わり)。"""

    async def complete(
        self,
        *,
        model: str,
        messages: list[Any],
        system: str | None = ...,
        max_tokens: int = ...,
        temperature: float = ...,
    ) -> Any: ...


async def llm_complete_or_injected(
    *,
    system_prompt: str,
    user_text: str,
    actor_id: str,
    max_tokens: int = 4096,
    fake: Callable[[], str] | None = None,
    client: InjectedCompletionClient | None = None,
    model: str = DEFAULT_API_MODEL,
    temperature: float = 0.2,
) -> tuple[str, str]:
    """GAP-171: 明示注入 client があればそれを、無ければ費用順チェーンを使う。

    成果物改訂・営業ドラフト・フェーズ提案・議事録解析は、もともと
    `ANTHROPIC_API_KEY` (= 運営の従量課金) を直接叩いていた。確定アーキテクチャは
    「**全ユーザーが自分の PC・自分の Claude サブスクで実行する**」なので、
    これらも relay → agent_sdk → API キー → fake の費用順チェーンに乗せる。

    `client` はテストの差し替え口としてのみ残す (本番経路では None)。
    """
    if client is not None:
        from src.llm.client import LLMMessage

        res = await client.complete(
            model=model,
            messages=[LLMMessage(role="user", content=user_text)],
            system=system_prompt,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        out = str(getattr(res, "text", "")).strip()
        if out == "":
            raise LLMUnavailable("failed", "注入クライアントが空の応答を返しました")
        return out, "injected"

    return await llm_complete(
        system_prompt=system_prompt,
        user_text=user_text,
        actor_id=actor_id,
        max_tokens=max_tokens,
        fake=fake,
    )
