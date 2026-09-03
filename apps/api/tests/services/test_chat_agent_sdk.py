"""GAP-113: Agent SDK (サブスク) チャットアダプタの unit tests。

claude-agent-sdk は optional dep で CI に無い前提のため、sys.modules へ
フェイクモジュールを注入して検証する (実 SDK 不要で全経路を通す)。
"""

from __future__ import annotations

import sys
import types
from dataclasses import dataclass, field
from pathlib import Path
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


@dataclass
class _FakeRateLimitInfo:
    status: str
    rate_limit_type: str | None = None
    utilization: float | None = None
    resets_at: float | None = None


@dataclass
class _FakeRateLimitEvent:
    rate_limit_info: _FakeRateLimitInfo


class _FakeOptions:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs


@dataclass
class _FakeResultMessage:
    result: str = ""


@dataclass
class _FakeAllow:
    behavior: str = "allow"


@dataclass
class _FakeDeny:
    message: str = ""
    behavior: str = "deny"


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
    mod.RateLimitEvent = _FakeRateLimitEvent  # pyright: ignore[reportAttributeAccessIssue]
    mod.ResultMessage = _FakeResultMessage  # pyright: ignore[reportAttributeAccessIssue]
    mod.PermissionResultAllow = _FakeAllow  # pyright: ignore[reportAttributeAccessIssue]
    mod.PermissionResultDeny = _FakeDeny  # pyright: ignore[reportAttributeAccessIssue]
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


def testfold_prompt_includes_history_roles() -> None:
    folded = agent_sdk.fold_prompt(
        [("user", "前の質問"), ("assistant", "前の回答"), ("system", "無視される")],
        "新しい質問",
    )
    assert "[ユーザー] 前の質問" in folded
    assert "[アシスタント] 前の回答" in folded
    assert "無視される" not in folded
    assert folded.endswith("新しいユーザーメッセージ (これに応答する): 新しい質問")


def testfold_prompt_no_history_is_passthrough() -> None:
    assert agent_sdk.fold_prompt([], "こんにちは") == "こんにちは"


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


def _patch_bridge_presence(monkeypatch: pytest.MonkeyPatch, *, online: bool) -> None:
    """GAP-310: relay 経路は保存の前に **本人の PC が繋がっているか** を見る。

    ここを与えないと、relay の中身を検証したいテストが全部
    「PC 未接続」で先に打ち切られてしまう (relay の分岐に一度も入らない)。
    """
    from src.services import chat_relay

    async def _status(*_: Any, **__: Any) -> dict[str, Any]:
        return {"bridge_online": online}

    monkeypatch.setattr(chat_relay, "connection_status", _status)


class _CountingSession:
    """GAP-201: stream_chat が「待ちに入る前」に commit することを受けるフェイク。"""

    def __init__(self) -> None:
        self.commits = 0

    async def commit(self) -> None:
        self.commits += 1


async def _run_stream_chat() -> list[str]:
    from src.services import chat_sse

    events: list[str] = []
    async for b in chat_sse.stream_chat(
        _CountingSession(),  # pyright: ignore[reportArgumentType]  - DB I/O は全てフェイク済
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


@pytest.mark.asyncio
async def test_stream_chat_uses_relay_when_opted_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GAP-114: provider=relay で relay 経路の delta が SSE で届く。"""
    from src.services import chat_sse
    from src.services.chat_sse import relay as sse_relay

    _patch_stream_chat_io(monkeypatch)

    async def _fake_relay(**_: Any) -> Any:
        yield "リレー応答"

    monkeypatch.setattr(sse_relay, "relay_stream_chunks", _fake_relay)
    _patch_bridge_presence(monkeypatch, online=True)
    monkeypatch.setenv(agent_sdk.PROVIDER_ENV, "relay")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    events: list[str] = []
    async for b in chat_sse.stream_chat(
        _CountingSession(),  # pyright: ignore[reportArgumentType]  - DB I/O は全てフェイク済
        actor_id="actor",
        thread_id="thread",
        user_message="やあ",
        use_rag=False,
        include_history=0,
        rag_account_id=None,
    ):
        events.append(b.decode())
    joined = "".join(events)
    assert '"delta"' in joined and "リレー応答" in joined
    assert '"end"' in joined


@pytest.mark.asyncio
async def test_stream_chat_relay_offline_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GAP-114: Bridge オフラインは具体的な誠実エラーを SSE で返す。"""
    from src.services import chat_sse
    from src.services.chat_sse import relay as sse_relay

    _patch_stream_chat_io(monkeypatch)

    async def _offline_relay(**_: Any) -> Any:
        raise sse_relay.RelayUnavailable
        yield  # pragma: no cover  - generator 化のため

    # presence は「繋がっている」。**繋いだ後に中継が落ちた** ときの誠実エラーを見る
    # (未接続そのものは GAP-310 の別テストが持つ)。
    monkeypatch.setattr(sse_relay, "relay_stream_chunks", _offline_relay)
    _patch_bridge_presence(monkeypatch, online=True)
    monkeypatch.setenv(agent_sdk.PROVIDER_ENV, "relay")
    events: list[str] = []
    async for b in chat_sse.stream_chat(
        _CountingSession(),  # pyright: ignore[reportArgumentType]  - DB I/O は全てフェイク済
        actor_id="actor",
        thread_id="thread",
        user_message="やあ",
        use_rag=False,
        include_history=0,
        rag_account_id=None,
    ):
        events.append(b.decode())
    joined = "".join(events)
    assert "Bridge" in joined and "オフライン" in joined
    assert '"end"' not in joined


@pytest.mark.asyncio
async def test_stream_collects_rate_limit_events(monkeypatch: pytest.MonkeyPatch) -> None:
    """GAP-124: RateLimitEvent (5h/7日枠の実測) を収集する — 応答 delta は不変。"""
    _install_fake_sdk(
        monkeypatch,
        [
            _FakeRateLimitEvent(
                _FakeRateLimitInfo(
                    status="allowed_warning",
                    rate_limit_type="five_hour",
                    utilization=0.42,
                    resets_at=1_800_000_000.0,
                )
            ),
            _delta_event("やあ"),
            _FakeRateLimitEvent(
                _FakeRateLimitInfo(status="allowed", rate_limit_type="seven_day", utilization=0.1)
            ),
            # 不正 status は収集しない (実値以外を記録しない)
            _FakeRateLimitEvent(_FakeRateLimitInfo(status="bogus")),
        ],
    )
    from src.services.chat_sse.agent_sdk import agent_sdk_stream_chunks

    out: list[dict[str, Any]] = []
    chunks = await _collect(
        agent_sdk_stream_chunks(
            system_prompt="s", history=[], user_message="u", rate_limits_out=out
        )
    )
    assert chunks == ["やあ"]
    assert len(out) == 2
    assert out[0]["rate_limit_type"] == "five_hour"
    assert out[0]["utilization"] == 0.42
    assert out[1]["rate_limit_type"] == "seven_day"


# --------------------------------------------------------------------------- #
# GAP-129: PC 操作 (tools_mode) のオプション組み立て
# --------------------------------------------------------------------------- #


def test_build_options_off_has_no_tools() -> None:
    from src.services.chat_sse.agent_sdk import build_options_kwargs

    kw = build_options_kwargs(system_prompt="SYS", tools_mode="off", env={})
    assert kw["allowed_tools"] == []
    assert kw["max_turns"] == 1
    assert "permission_mode" not in kw
    assert "cwd" not in kw


def test_build_options_auto_enables_claude_code_tools(tmp_path: Path) -> None:
    from src.services.chat_sse.agent_sdk import build_options_kwargs

    kw = build_options_kwargs(
        system_prompt="SYS",
        tools_mode="auto",
        env={"ATELIER_CHAT_WORKSPACE": str(tmp_path)},
    )
    assert set(kw["allowed_tools"]) == {"Read", "Write", "Edit", "Bash", "Glob", "Grep"}
    assert kw["permission_mode"] == "bypassPermissions"
    assert kw["cwd"] == str(tmp_path)
    assert kw["max_turns"] > 1
    # ツール利用の指示が system prompt に足される
    assert "ローカル作業ツール" in kw["system_prompt"]


def test_chat_workspace_dir_default_and_override(tmp_path: Path) -> None:
    from src.services.chat_sse.agent_sdk import chat_workspace_dir

    assert chat_workspace_dir({}).endswith("AtelierChatWork")
    assert chat_workspace_dir({"ATELIER_CHAT_WORKSPACE": str(tmp_path)}) == str(tmp_path)


# --------------------------------------------------------------------------- #
# GAP-130: PC 操作の承認モード (approve)
# --------------------------------------------------------------------------- #


def test_build_options_approve_uses_permission_prompt(tmp_path: Path) -> None:
    """approve は allowed_tools に載せない (載せると聞かずに自動許可される)。"""
    from src.services.chat_sse.agent_sdk import build_options_kwargs

    kw = build_options_kwargs(
        system_prompt="SYS",
        tools_mode="approve",
        env={"ATELIER_CHAT_WORKSPACE": str(tmp_path)},
    )
    assert kw["allowed_tools"] == []
    assert kw["permission_mode"] == "default"
    assert kw["cwd"] == str(tmp_path)
    assert kw["max_turns"] > 1
    assert "承認制" in kw["system_prompt"]


def _deny_result(message: str) -> tuple[str, str]:
    """SDK の PermissionResultDeny の代役 (テスト用ファクトリ)。"""
    return ("DENIED", message)


@pytest.mark.asyncio
async def test_pc_can_use_tool_allow_flow() -> None:
    """承認カード発行 → allow 決定 → 実行許可 + resolved イベント。"""
    import asyncio

    from src.services.chat_sse import pc_approvals
    from src.services.chat_sse.agent_sdk import make_pc_can_use_tool

    events: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
    cb = make_pc_can_use_tool(
        user_id="u1",
        thread_id="t1",
        events=events,
        allow_result=lambda: "ALLOWED",
        deny_result=_deny_result,
    )
    task = asyncio.ensure_future(cb("Bash", {"command": "echo hi"}, None))
    kind, payload = await asyncio.wait_for(events.get(), timeout=2)
    assert kind == "approval"
    assert payload["tool"] == "Bash"
    assert payload["summary"] == "echo hi"
    # 他ユーザーでは解決できない (403 相当 → False)
    assert pc_approvals.resolve_request(payload["id"], user_id="mallory", decision="allow") is False
    assert pc_approvals.resolve_request(payload["id"], user_id="u1", decision="allow") is True
    assert await asyncio.wait_for(task, timeout=2) == "ALLOWED"
    kind2, payload2 = await asyncio.wait_for(events.get(), timeout=2)
    assert kind2 == "resolved" and payload2["decision"] == "allow"
    assert pc_approvals.pending_count() == 0


@pytest.mark.asyncio
async def test_pc_can_use_tool_deny_and_timeout() -> None:
    """deny 決定は拒否、無応答はタイムアウトで拒否 (勝手に実行しない)。"""
    import asyncio

    from src.services.chat_sse import pc_approvals
    from src.services.chat_sse.agent_sdk import make_pc_can_use_tool

    events: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
    cb = make_pc_can_use_tool(
        user_id="u1",
        thread_id="t1",
        events=events,
        allow_result=lambda: "ALLOWED",
        deny_result=_deny_result,
        timeout_seconds=0.05,
    )
    # deny
    task = asyncio.ensure_future(cb("Write", {"file_path": "/tmp/x.txt"}, None))
    _, payload = await asyncio.wait_for(events.get(), timeout=2)
    assert pc_approvals.resolve_request(payload["id"], user_id="u1", decision="deny") is True
    result = await asyncio.wait_for(task, timeout=2)
    assert result[0] == "DENIED" and "拒否" in result[1]
    await events.get()  # resolved イベントを消費
    # timeout (決定なし)
    task2 = asyncio.ensure_future(cb("Bash", {"command": "rm -rf /"}, None))
    await asyncio.wait_for(events.get(), timeout=2)
    result2 = await asyncio.wait_for(task2, timeout=2)
    assert result2[0] == "DENIED" and "時間内に承認しなかった" in result2[1]
    _, resolved2 = await asyncio.wait_for(events.get(), timeout=2)
    assert resolved2["decision"] == "timeout"
    assert pc_approvals.pending_count() == 0


@pytest.mark.asyncio
async def test_pc_can_use_tool_rejects_unlisted_tool() -> None:
    """許可対象外ツール (WebSearch 等) は承認カードを出さず即拒否。"""
    import asyncio

    from src.services.chat_sse import pc_approvals
    from src.services.chat_sse.agent_sdk import make_pc_can_use_tool

    events: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
    cb = make_pc_can_use_tool(
        user_id="u1",
        thread_id="t1",
        events=events,
        allow_result=lambda: "ALLOWED",
        deny_result=_deny_result,
    )
    result = await cb("WebSearch", {"query": "x"}, None)
    assert result[0] == "DENIED" and "許可されていません" in result[1]
    assert events.empty()
    assert pc_approvals.pending_count() == 0


@pytest.mark.asyncio
async def test_stream_approve_emits_approval_chunks(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """approve モードの実ストリーム: 承認カード → allow → resolved → 応答 delta。"""
    import asyncio

    from src.services.chat_sse import pc_approvals

    captured: dict[str, Any] = {}

    async def _fake_query(*, prompt: Any, options: Any = None) -> Any:
        captured["prompt"] = prompt
        captured["options"] = options
        cb = options.kwargs["can_use_tool"]
        result = await cb("Bash", {"command": "echo hi"}, None)
        captured["perm_result"] = result
        yield _delta_event("実行しました")

    mod = types.ModuleType("claude_agent_sdk")
    mod.AssistantMessage = _FakeAssistantMessage  # pyright: ignore[reportAttributeAccessIssue]
    mod.ClaudeAgentOptions = _FakeOptions  # pyright: ignore[reportAttributeAccessIssue]
    mod.StreamEvent = _FakeStreamEvent  # pyright: ignore[reportAttributeAccessIssue]
    mod.TextBlock = _FakeTextBlock  # pyright: ignore[reportAttributeAccessIssue]
    mod.RateLimitEvent = _FakeRateLimitEvent  # pyright: ignore[reportAttributeAccessIssue]
    mod.ResultMessage = _FakeResultMessage  # pyright: ignore[reportAttributeAccessIssue]
    mod.PermissionResultAllow = _FakeAllow  # pyright: ignore[reportAttributeAccessIssue]
    mod.PermissionResultDeny = _FakeDeny  # pyright: ignore[reportAttributeAccessIssue]
    mod.query = _fake_query  # pyright: ignore[reportAttributeAccessIssue]
    monkeypatch.setitem(sys.modules, "claude_agent_sdk", mod)
    monkeypatch.setenv("ATELIER_CHAT_WORKSPACE", str(tmp_path))

    gen = agent_sdk.agent_sdk_stream_chunks(
        system_prompt="s",
        history=[],
        user_message="ファイルを作って",
        tools_mode="approve",
        approval_user_id="u1",
        approval_thread_id="t1",
    )
    first = await asyncio.wait_for(gen.__anext__(), timeout=2)
    assert isinstance(first, dict) and "pc_approval" in first
    ap = first["pc_approval"]
    assert ap["tool"] == "Bash" and ap["summary"] == "echo hi"
    assert pc_approvals.resolve_request(ap["id"], user_id="u1", decision="allow") is True
    rest = [c async for c in gen]
    assert {"pc_approval_resolved": {"id": ap["id"], "decision": "allow"}} in rest
    assert "実行しました" in rest
    # 許可の実型が SDK の PermissionResultAllow で返っている
    assert isinstance(captured["perm_result"], _FakeAllow)
    # streaming 入力 (AsyncIterable) で起動している (can_use_tool の SDK 制約)
    assert not isinstance(captured["prompt"], str)
