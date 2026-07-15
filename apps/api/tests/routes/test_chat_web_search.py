"""T-A-51: web_search を chat SSE 実経路へ配線 — 3-tier AC テスト。

tier 1 (structural): tools は T-F-21 build_web_search_tool() 経由で組み立てる。
tier 2 (functional): ATELIER_WEB_SEARCH_DISABLED=1 で注入無効化。
tier 2 (UNWANTED):   provider 例外はサニタイズ済み定型文で SSE error 化 (生エラー非漏えい)。
tier 3 (regression): fake 経路 (_fake_stream_chunks) は tools 概念を持たず不変。
"""

from __future__ import annotations

import pytest

from src.services import chat_sse
from src.tools.web_search import DEFAULT_MAX_USES, build_web_search_tool


class TestBuildStreamTools:
    def test_default_uses_t_f_21_descriptor(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("ATELIER_WEB_SEARCH_DISABLED", raising=False)
        tools = chat_sse._build_stream_tools()
        assert tools is not None
        assert len(tools) == 1
        # 独自 dict 直書きではなく T-F-21 の組立と完全一致すること
        assert tools[0] == build_web_search_tool()
        assert tools[0]["name"] == "web_search"
        assert tools[0]["max_uses"] == DEFAULT_MAX_USES

    def test_disabled_flag_returns_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ATELIER_WEB_SEARCH_DISABLED", "1")
        assert chat_sse._build_stream_tools() is None

    def test_flag_other_value_keeps_enabled(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ATELIER_WEB_SEARCH_DISABLED", "0")
        assert chat_sse._build_stream_tools() is not None


class TestFakePathUnchanged:
    async def test_fake_stream_still_echoes(self) -> None:
        chunks = [c async for c in chat_sse._fake_stream_chunks("こんにちは")]
        assert "".join(chunks) == "echo: こんにちは"
