"""GAP-113: Agent SDK (サブスク) チャットアダプタの unit tests。

claude-agent-sdk は optional dep で CI に無い前提のため、sys.modules へ
フェイクモジュールを注入して検証する (実 SDK 不要で全経路を通す)。
"""

from __future__ import annotations

import sys
import types
from dataclasses import dataclass, field
from typing import Any

import pytest

from src.services.chat_sse import agent_sdk

# ---------------------------------------------------------------------------
# フェイク SDK (sys.modules 注入用)
# ---------------------------------------------------------------------------


@dataclass
class _FakeTextBlock:
    text: str


@dataclass
class _FakeAssistantMessage:
    content: list[Any] = field(default_factory=lambda: [])


@dataclass
class _FakeStreamEvent:
    event: dict[str, Any] = field(default_factory=lambda: {})


class _FakeOptions:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


def _install_fake_sdk(monkeypatch: pytest.MonkeyPatch, messages: list[Any]) -> dict[str, Any]:
    """フェイク claude_agent_sdk を sys.modules に注入し、query 呼出を記録する。"""
    captured: dict[str, Any] = {}

    async def _fake_query(*, prompt: str, options: Any = None) -> Any:
        captured["prompt"] = prompt
        captured["options"] = options
        for m in messages:
            yield m

    mod = types.ModuleType("claude_agent_sdk")
    mod.AssistantMessage = _FakeAssistantMessage  # pyright: ignore[reportAttributeAccessIssue]
    mod.ClaudeAgentOptions = _FakeOptions  # pyright: ignore[reportAttributeAccessIssue]
    mod.StreamEvent = _FakeStreamEvent  # pyright: ignore[reportAttributeAccessIssue]
    mod.TextBlock = _FakeTextBlock  # pyright: ignore[reportAttributeAccessIssue]
    mod.query = _fake_query  # pyright: ignore[reportAttributeAccessIssue]
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", mod)
    return captured


def _delta_event(text: str) -> _FakeStreamEvent:
    return _FakeStreamEvent(
        event={"type": "content_block_delta", "delta": {"type": "text_delta", "text": text}}
    )


async def _collect(gen: Any) -> list[str]:
    return [c async for c in gen]


# ---------------------------------------------------------------------------
# opt-in フラグ / SDK 検出
# ---------------------------------------------------------------------------


def test_subscription_mode_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    """ATELIER_LLM_PROVIDER の明示 opt-in のみ有効 (既定・anthropic は無効)。"""
    monkeypatch.delenv(agent_sdk.PROVIDER_ENV, raising=False)
    assert agent_sdk.subscription_mode_enabled() is False
    monkeypatch.setenv(agent_sdk.PROVIDER_ENV, "anthropic")
    assert agent_sdk.subscription_mode_enabled() is False
    for v in ("agent_sdk", "AGENT_SDK", " claude_subscription ", "subscription"):
        monkeypatch.setenv(agent_sdk.PROVIDER_ENV, v)
        assert agent_sdk.subscription_mode_enabled() is True, v


def test_sdk_available_false_when_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    """SDK 未導入 (import 不可) なら False — 黙る fallback 判定の入口。"""
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", None)
    assert agent_sdk.sdk_available() is False


def test_sdk_available_true_with_fake(monkeypatch: pytest.MonkeyPatch) -> None:
    _install_fake_sdk(monkeypatch, [])
    assert agent_sdk.sdk_available() is True


# ---------------------------------------------------------------------------
# prompt 畳み込み / env 除去
# ---------------------------------------------------------------------------


def test_fold_prompt_includes_history_roles() -> None:
    folded = agent_sdk._fold_prompt(  # pyright: ignore[reportPrivateUsage]
        [("user", "前の質問"), ("assistant", "前の回答"), ("system", "無視される")],
        "新しい質問",
    )
    assert "[ユーザー] 前の質問" in folded
    assert "[アシスタント] 前の回答" in folded
    assert "無視される" not in folded
    assert folded.endswith("新しいユーザーメッセージ (これに応答する): 新しい質問")


def test_fold_prompt_no_history_is_passthrough() -> None:
    assert agent_sdk._fold_prompt([], "こんにちは") == "こんにちは"  # pyright: ignore[reportPrivateUsage]


def test_subprocess_env_drops_api_keys(monkeypatch: pytest.MonkeyPatch) -> None:
    """API キー系 3 変数を必ず除去 (黙って従量課金へ流れる事故の閉塞)。"""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "tok")
    monkeypatch.setenv("CLAUDE_CODE_API_KEY", "key")
    monkeypatch.setenv("ATELIER_KEEP_ME", "1")
    env = agent_sdk._subprocess_env()  # pyright: ignore[reportPrivateUsage]
    assert "ANTHROPIC_API_KEY" not in env
    assert "ANTHROPIC_AUTH_TOKEN" not in env
    assert "CLAUDE_CODE_API_KEY" not in env
    assert env["ATELIER_KEEP_ME"] == "1"


# ---------------------------------------------------------------------------
# ストリーム本体
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stream_yields_partial_deltas(monkeypatch: pytest.MonkeyPatch) -> None:
    """partial (content_block_delta/text_delta) を逐次 yield する。"""
    captured = _install_fake_sdk(
        monkeypatch,
        [
            _delta_event("こん"),
            _FakeStreamEvent(event={"type": "message_start"}),  # 無関係 event は無視
            _delta_event("にちは"),
            # partial があった場合、完成 AssistantMessage は二重 yield しない
            _FakeAssistantMessage(content=[_FakeTextBlock(text="こんにちは")]),
        ],
    )
    out = await _collect(
        agent_sdk.agent_sdk_stream_chunks(
            system_prompt="sys", history=[("user", "a")], user_message="b"
        )
    )
    assert out == ["こん", "にちは"]
    # options の安全設定を突合: CLI ツール全禁止 + 1 turn + API キー除去済 env
    opts = captured["options"].kwargs
    assert opts["allowed_tools"] == []
    assert opts["max_turns"] == 1
    assert opts["include_partial_messages"] is True
    assert "ANTHROPIC_API_KEY" not in opts["env"]
    assert "[ユーザー] a" in captured["prompt"]


@pytest.mark.asyncio
async def test_stream_falls_back_to_assistant_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """partial が一度も来ない場合は完成 AssistantMessage の text で代替する。"""
    _install_fake_sdk(
        monkeypatch,
        [_FakeAssistantMessage(content=[_FakeTextBlock(text="完成応答")])],
    )
    out = await _collect(
        agent_sdk.agent_sdk_stream_chunks(system_prompt="sys", history=[], user_message="q")
    )
    assert out == ["完成応答"]


@pytest.mark.asyncio
async def test_stream_passes_model_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """ATELIER_AGENT_SDK_MODEL 設定時のみ model を options へ渡す。"""
    captured = _install_fake_sdk(monkeypatch, [])
    monkeypatch.setenv(agent_sdk.MODEL_ENV, "claude-sonnet-4-6")
    await _collect(
        agent_sdk.agent_sdk_stream_chunks(system_prompt="s", history=[], user_message="u")
    )
    assert captured["options"].kwargs["model"] == "claude-sonnet-4-6"


# ---------------------------------------------------------------------------
# stream_chat 配線 (SSE レベル / DB 非依存 — 文脈構築・永続化はフェイク)
# ---------------------------------------------------------------------------


def _patch_stream_chat_io(monkeypatch: pytest.MonkeyPatch) -> None:
    """stream_chat の DB 依存 (文脈構築/insert/audit) をフェイク化する。"""
    from src.services import chat_sse

    async def _fake_build_context(*args: Any, **kwargs: Any) -> Any:
        return "system", [], []

    async def _fake_insert(*args: Any, **kwargs: Any) -> str:
        return "00000000-0000-0000-0000-000000000000"

    class _FakeAuditWriter:
        def __init__(self, *_: Any) -> None: ...

        async def write(self, *_: Any, **__: Any) -> None: ...

    monkeypatch.setattr(chat_sse, "build_context", _fake_build_context)
    monkeypatch.setattr(chat_sse, "_insert_message", _fake_insert)
    monkeypatch.setattr(chat_sse, "AuditWriter", _FakeAuditWriter)


async def _run_stream_chat() -> list[str]:
    from src.services import chat_sse

    events: list[str] = []
    async for b in chat_sse.stream_chat(
        None,  # pyright: ignore[reportArgumentType]  - DB I/O は全てフェイク済
        actor_id="actor",
        thread_id="thread",
        user_message="やあ",
        use_rag=False,
        include_history=0,
        rag_account_id=None,
    ):
        events.append(b.decode())
    return events


@pytest.mark.asyncio
async def test_stream_chat_uses_agent_sdk_when_opted_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """opt-in + SDK あり → Agent SDK 経路の delta が SSE で届き、end まで完走する。"""
    _patch_stream_chat_io(monkeypatch)
    _install_fake_sdk(monkeypatch, [_delta_event("サブスク応答")])
    monkeypatch.setenv(agent_sdk.PROVIDER_ENV, "agent_sdk")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    events = await _run_stream_chat()
    joined = "".join(events)
    assert '"delta"' in joined and "サブスク応答" in joined
    assert '"end"' in joined
    assert '"error"' not in joined


@pytest.mark.asyncio
async def test_stream_chat_errors_when_sdk_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """opt-in なのに SDK 不在 → 黙って API/fake に落とさず SSE error で誠実に停止。"""
    _patch_stream_chat_io(monkeypatch)
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", None)
    monkeypatch.setenv(agent_sdk.PROVIDER_ENV, "agent_sdk")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-not-be-used")
    events = await _run_stream_chat()
    joined = "".join(events)
    assert "サブスクリプションモードが利用できません" in joined
    assert '"end"' not in joined
