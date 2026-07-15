"""T-A-52: Prompt Caching を chat SSE 実経路へ配線 — 3-tier AC テスト。

tier 1 (structural): system は T-F-15 cache_system_prompt() 経由の blocks で渡す。
tier 2 (functional): ATELIER_PROMPT_CACHE_DISABLED=1 で plain string のまま。
tier 2 (UNWANTED):   blocks 連結 = 原文一致 (意味内容を変えない・致命)。
tier 3 (regression): 空 system は plain string 扱い (SDK へ空 list を渡さない)。
"""

from __future__ import annotations

import pytest

from src.llm.caching import cache_system_prompt
from src.services import chat_sse

SYSTEM = "あなたは Atelier の AI アシスタントです。\n\nペルソナ: トニー (COO)"


class TestBuildSystemParam:
    def test_default_uses_t_f_15_cacheable_blocks(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("ATELIER_PROMPT_CACHE_DISABLED", raising=False)
        param = chat_sse._build_system_param(SYSTEM)
        assert isinstance(param, list)
        # 独自組立ではなく T-F-15 の組立と完全一致すること
        assert param == cache_system_prompt(SYSTEM)
        assert param[0]["cache_control"] == {"type": "ephemeral"}

    def test_blocks_join_equals_original(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("ATELIER_PROMPT_CACHE_DISABLED", raising=False)
        param = chat_sse._build_system_param(SYSTEM)
        assert isinstance(param, list)
        joined = "".join(b["text"] for b in param)
        assert joined == SYSTEM  # 意味内容を変えない (致命 AC)

    def test_disabled_flag_keeps_plain_string(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("ATELIER_PROMPT_CACHE_DISABLED", "1")
        assert chat_sse._build_system_param(SYSTEM) == SYSTEM

    def test_empty_system_stays_plain(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("ATELIER_PROMPT_CACHE_DISABLED", raising=False)
        assert chat_sse._build_system_param("") == ""
