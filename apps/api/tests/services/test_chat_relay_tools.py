"""GAP-134: Bridge 経路の PC 操作 (relay SSE アダプタ) の unit tests。

DB は使わない — chat_relay サービス関数と session factory をフェイクし、
イベント多重化 (delta / tool / pc_approval / resolved) と tools_mode の
受け渡しを検証する。DB 込みの実往復は e2e (.qa/gap-134) が担当。
"""

from __future__ import annotations

from typing import Any

import pytest

from src.services import chat_relay as relay_svc
from src.services.chat_sse import relay as sse_relay


class _FakeSession:
    async def __aenter__(self) -> Any:
        return self

    async def __aexit__(self, *args: Any) -> bool:
        return False

    async def commit(self) -> None: ...


@pytest.fixture()
def relay_env(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """フェイク chat_relay 一式。state で job の進行をテストから制御する。"""
    state: dict[str, Any] = {
        "enqueued": None,
        "status": "running",
        "chunks": [],  # (seq, kind, content)
        "served_after": -1,
        "approvals": [],
    }
    monkeypatch.setattr(sse_relay, "_session_factory", lambda: _FakeSession)
    monkeypatch.setattr(sse_relay, "_POLL_INTERVAL_SECONDS", 0.0)

    async def _online(_s: Any) -> bool:
        return True

    async def _enqueue(_s: Any, **kwargs: Any) -> str:
        state["enqueued"] = kwargs
        return "job-1"

    async def _fetch(_s: Any, *, job_id: str, after_seq: int) -> list[tuple[int, str, str]]:
        return [c for c in state["chunks"] if c[0] > after_seq]

    async def _result(_s: Any, *, job_id: str) -> tuple[str, str | None]:
        return state["status"], None

    async def _approvals(_s: Any, *, job_id: str) -> list[dict[str, str]]:
        return list(state["approvals"])

    monkeypatch.setattr(relay_svc, "worker_online", _online)
    monkeypatch.setattr(relay_svc, "enqueue_job", _enqueue)
    monkeypatch.setattr(relay_svc, "fetch_chunks", _fetch)
    monkeypatch.setattr(relay_svc, "job_result", _result)
    monkeypatch.setattr(relay_svc, "list_job_approvals", _approvals)
    return state


@pytest.mark.asyncio
async def test_relay_stream_multiplexes_tool_and_approval_events(
    relay_env: dict[str, Any],
) -> None:
    """delta / tool 実況 / 承認カード / 解決 が agent_sdk と同一形で流れる。"""
    state = relay_env
    gen = sse_relay.relay_stream_chunks(
        system_prompt="SYS",
        history=[],
        user_message="ファイル作って",
        thread_id="t1",
        actor_id="u1",
        tools_mode="approve",
    )
    # 1 巡目: 承認カード pending
    state["approvals"] = [
        {"id": "ap-1", "tool": "Bash", "summary": "touch x", "decision": "pending"}
    ]
    first = await gen.__anext__()
    assert first == {"pc_approval": {"id": "ap-1", "tool": "Bash", "summary": "touch x"}}
    # 2 巡目: 決定 allow + ツール実況 + 本文 → 完了
    state["approvals"] = [{"id": "ap-1", "tool": "Bash", "summary": "touch x", "decision": "allow"}]
    state["chunks"] = [(0, "tool", "Bash"), (1, "delta", "作りました")]
    state["status"] = "done"
    rest = [c async for c in gen]
    assert {"tool": "Bash"} in rest
    assert "作りました" in rest
    assert {"pc_approval_resolved": {"id": "ap-1", "decision": "allow"}} in rest
    # enqueue に tools_mode が伝わっている
    assert state["enqueued"]["tools_mode"] == "approve"


@pytest.mark.asyncio
async def test_relay_stream_off_mode_passes_only_deltas(relay_env: dict[str, Any]) -> None:
    """off (従来チャット) は tools_mode=off で enqueue され、delta のみ流れる。"""
    state = relay_env
    state["chunks"] = [(0, "delta", "こんにちは")]
    state["status"] = "done"
    out = [
        c
        async for c in sse_relay.relay_stream_chunks(
            system_prompt="SYS",
            history=[],
            user_message="やあ",
            thread_id="t1",
            actor_id="u1",
        )
    ]
    assert out == ["こんにちは"]
    assert state["enqueued"]["tools_mode"] == "off"


@pytest.mark.asyncio
async def test_stream_chat_allows_tools_on_relay(monkeypatch: pytest.MonkeyPatch) -> None:
    """GAP-134: relay モードでは tools_mode=approve が拒否されず Bridge へ渡る。"""
    from src.services import chat_sse

    # DB 依存をフェイク (test_chat_agent_sdk と同じパターン)
    async def _fake_build_context(*a: Any, **k: Any) -> Any:
        return "system", [], []

    async def _fake_insert(*a: Any, **k: Any) -> str:
        return "00000000-0000-0000-0000-000000000000"

    class _FakeAuditWriter:
        def __init__(self, *_: Any) -> None: ...

        async def write(self, *_: Any, **__: Any) -> None: ...

    monkeypatch.setattr(chat_sse, "build_context", _fake_build_context)
    monkeypatch.setattr(chat_sse, "_insert_message", _fake_insert)
    monkeypatch.setattr(chat_sse, "AuditWriter", _FakeAuditWriter)
    monkeypatch.setenv("ATELIER_LLM_PROVIDER", "relay")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    captured: dict[str, Any] = {}

    async def _fake_relay(**kwargs: Any) -> Any:
        captured.update(kwargs)
        yield {"tool": "Write"}
        yield "了解"

    monkeypatch.setattr(sse_relay, "relay_stream_chunks", _fake_relay)
    events: list[str] = []
    async for b in chat_sse.stream_chat(
        None,  # pyright: ignore[reportArgumentType]  - DB I/O は全てフェイク済
        actor_id="u1",
        thread_id="t1",
        user_message="ファイル作って",
        use_rag=False,
        include_history=0,
        rag_account_id=None,
        tools_mode="approve",
    ):
        events.append(b.decode())
    joined = "".join(events)
    assert '"error"' not in joined  # 誠実エラーで弾かれていない
    assert '"tool"' in joined and "了解" in joined and '"end"' in joined
    assert captured["tools_mode"] == "approve"
