"""GAP-130: PC 操作 (approve モード) 承認レジストリの unit tests。"""

from __future__ import annotations

import pytest

from src.services.chat_sse import pc_approvals


@pytest.mark.asyncio
async def test_create_resolve_roundtrip() -> None:
    rec = pc_approvals.create_request(user_id="u1", thread_id="t1", tool="Bash", summary="echo hi")
    assert pc_approvals.pending_count() >= 1
    # 冪等: 二重解決でも True (先勝ち)
    assert pc_approvals.resolve_request(rec.id, user_id="u1", decision="allow") is True
    assert pc_approvals.resolve_request(rec.id, user_id="u1", decision="deny") is True
    assert await rec.future == "allow"
    pc_approvals.discard(rec.id)
    assert pc_approvals.resolve_request(rec.id, user_id="u1", decision="allow") is False


@pytest.mark.asyncio
async def test_resolve_rejects_unknown_and_foreign() -> None:
    rec = pc_approvals.create_request(
        user_id="owner", thread_id="t1", tool="Write", summary="/tmp/a"
    )
    assert pc_approvals.resolve_request("no-such-id", user_id="owner", decision="allow") is False
    # 他ユーザーの承認 ID は解決できない (存在も漏らさない — 404 相当)
    assert pc_approvals.resolve_request(rec.id, user_id="attacker", decision="allow") is False
    assert not rec.future.done()
    pc_approvals.discard(rec.id)


def test_approval_timeout_env_override() -> None:
    assert pc_approvals.approval_timeout_seconds({}) == pc_approvals.DEFAULT_TIMEOUT_SECONDS
    assert pc_approvals.approval_timeout_seconds({pc_approvals.TIMEOUT_ENV: "12.5"}) == 12.5
    # 不正値・非正値は既定へ (黙って 0 秒即拒否にしない)
    for bad in ("abc", "0", "-3"):
        assert (
            pc_approvals.approval_timeout_seconds({pc_approvals.TIMEOUT_ENV: bad})
            == pc_approvals.DEFAULT_TIMEOUT_SECONDS
        )


def test_summarize_tool_input_primary_fields() -> None:
    s = pc_approvals.summarize_tool_input
    assert s("Bash", {"command": "ls -la"}) == "ls -la"
    assert s("Write", {"file_path": "/tmp/x.txt", "content": "秘密の長文"}) == "/tmp/x.txt"
    assert s("Read", {"file_path": "/tmp/y.txt"}) == "/tmp/y.txt"
    assert s("Grep", {"pattern": "TODO"}) == "TODO"
    # 未知ツール / 主要キー欠落はキー列挙 (中身を出しすぎない)
    assert s("Mystery", {"b": 1, "a": 2}) == "a, b"
    assert s("Bash", {}) == "(入力なし)"
    # 長大入力は切り詰める
    long = "x" * 500
    out = s("Bash", {"command": long})
    assert len(out) <= 200 and out.endswith("…")
