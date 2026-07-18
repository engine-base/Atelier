"""チャットの Atelier agentic ツール (save_deliverable 等) の単体テスト。

tier 1 (structural): tool 定義スキーマ / include_atelier で注入されること。
tier 2 (functional): execute_atelier_tool が save_deliverable で knowledge を作成する。
tier 2 (UNWANTED):   workspace 不明 / 未知ツール はエラー文字列で返し例外で落とさない。
"""
# pyright: reportPrivateUsage=false

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from src.services import chat_sse
from src.services.chat_sse import tools as chat_tools


def test_atelier_tool_defs_schema() -> None:
    defs = chat_tools.atelier_tool_defs()
    names = {d["name"] for d in defs}
    assert "save_deliverable" in names
    save = next(d for d in defs if d["name"] == "save_deliverable")
    props = save["input_schema"]["properties"]
    assert {"title", "category", "content_md"} <= set(props)
    assert save["input_schema"]["required"] == ["title", "category", "content_md"]


def test_build_stream_tools_includes_atelier(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ATELIER_WEB_SEARCH_DISABLED", raising=False)
    with_atelier = chat_sse._build_stream_tools(include_atelier=True)
    assert with_atelier is not None
    names = {t["name"] for t in with_atelier}
    assert "web_search" in names and "save_deliverable" in names
    # 既定 (include_atelier=False) は web_search のみ (従来動作)。
    default = chat_sse._build_stream_tools()
    assert default is not None
    assert {t["name"] for t in default} == {"web_search"}


async def test_execute_save_deliverable_creates_knowledge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def fake_create(session: Any, *, actor_id: str, data: Any) -> Any:
        captured["actor_id"] = actor_id
        captured["data"] = data
        return SimpleNamespace(id="k-123", title=data.title)

    monkeypatch.setattr("src.services.knowledge.create_knowledge", fake_create, raising=True)
    ctx = chat_tools.ToolContext(
        session=object(),  # type: ignore[arg-type]
        actor_id="u-1",
        project_id="p-1",
        workspace_id="w-1",
    )
    out = await chat_tools.execute_atelier_tool(
        ctx,
        "save_deliverable",
        {"title": "要件定義ドラフト", "category": "要件定義", "content_md": "# 本文"},
    )
    assert "k-123" in out and "保存しました" in out
    data = captured["data"]
    assert captured["actor_id"] == "u-1"
    assert data.account_id == "w-1"
    assert data.account_type == "workspace"
    assert data.title == "要件定義ドラフト"
    assert data.content_md == "# 本文"


async def test_execute_save_deliverable_without_workspace() -> None:
    ctx = chat_tools.ToolContext(
        session=object(),  # type: ignore[arg-type]
        actor_id="u-1",
        project_id="p-1",
        workspace_id=None,
    )
    out = await chat_tools.execute_atelier_tool(
        ctx, "save_deliverable", {"title": "x", "category": "y", "content_md": "z"}
    )
    assert "エラー" in out


async def test_execute_unknown_tool_returns_message() -> None:
    ctx = chat_tools.ToolContext(
        session=object(),  # type: ignore[arg-type]
        actor_id="u-1",
        project_id=None,
        workspace_id=None,
    )
    out = await chat_tools.execute_atelier_tool(ctx, "does_not_exist", {})
    assert "未対応" in out
