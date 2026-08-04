# pyright: reportPrivateUsage=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false
"""GAP-015 議事録構造化解析 (analysis.py + worker 組込) の unit tests。

LLM 境界は fake client で差替え、JSON 抽出/正規化/エラー分類/
「解析失敗でも transcription は成功のまま」を検証する。
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from dataclasses import dataclass
from typing import Any

import pytest

from src.services.meetings import analysis, worker


def _run(coro: Awaitable[Any]) -> Any:
    return asyncio.new_event_loop().run_until_complete(coro)


@dataclass
class _FakeResponse:
    text: str


class _FakeClient:
    def __init__(self, reply: str | Exception) -> None:
        self._reply = reply
        self.calls: list[dict[str, Any]] = []

    async def complete(self, **kwargs: Any) -> _FakeResponse:
        self.calls.append(kwargs)
        if isinstance(self._reply, Exception):
            raise self._reply
        return _FakeResponse(text=self._reply)


_GOOD_JSON = (
    '{"summary": "LP 制作の要件を確認した。", '
    '"speakers": [{"name": "田中", "role": "クライアント"}, {"name": "ワンダ", "role": null}], '
    '"requirements": ["トップ + 問い合わせの 2 ページ", "納期 4 週間"], '
    '"action_items": [{"title": "見積ドラフト作成", "owner": "ワンダ"}, "ヒアリング議事録の共有"]}'
)


class TestAnalyzeTranscript:
    def test_parses_and_normalizes(self) -> None:
        client = _FakeClient(_GOOD_JSON)
        result = _run(analysis.analyze_transcript("こんにちは。LP の件です。", client=client))
        assert result["summary"].startswith("LP 制作")
        assert result["speakers"][0] == {"name": "田中", "role": "クライアント"}
        assert result["requirements"] == ["トップ + 問い合わせの 2 ページ", "納期 4 週間"]
        # 文字列だけの action_item も {title, owner:None} に正規化される
        assert result["action_items"][1] == {"title": "ヒアリング議事録の共有", "owner": None}
        assert result["model"] == analysis.ANALYSIS_MODEL
        # system プロンプトに JSON スキーマ指示が入っている
        assert "summary" in str(client.calls[0]["system"])

    def test_code_fence_reply_is_accepted(self) -> None:
        client = _FakeClient(f"```json\n{_GOOD_JSON}\n```")
        result = _run(analysis.analyze_transcript("t", client=client))
        assert result["summary"]

    def test_non_json_reply_raises_parse_failed(self) -> None:
        client = _FakeClient("すみません、解析できません。")
        with pytest.raises(analysis.AnalysisError) as ei:
            _run(analysis.analyze_transcript("t", client=client))
        assert ei.value.code == "parse_failed"

    def test_llm_exception_raises_llm_failed(self) -> None:
        client = _FakeClient(RuntimeError("api down"))
        with pytest.raises(analysis.AnalysisError) as ei:
            _run(analysis.analyze_transcript("t", client=client))
        assert ei.value.code == "llm_failed"

    def test_unconfigured_key_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        with pytest.raises(analysis.AnalysisError) as ei:
            _run(analysis.analyze_transcript("t"))
        assert ei.value.code == "llm_unconfigured"

    def test_long_transcript_truncated_flag(self) -> None:
        client = _FakeClient(_GOOD_JSON)
        result = _run(analysis.analyze_transcript("あ" * 30_000, client=client))
        assert result.get("truncated") is True
        sent = str(client.calls[0]["messages"][0].content)
        assert len(sent) < 30_000


class TestWorkerAnalysisStep:
    def test_analysis_merged_into_result(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def fake_analyze(text: str, **_kw: Any) -> dict[str, Any]:
            assert text == "本文"
            return {"summary": "S", "speakers": [], "requirements": [], "action_items": []}

        monkeypatch.setattr("src.services.meetings.analysis.analyze_transcript", fake_analyze)
        merged = _run(worker._analyze_result({"text": "本文"}))
        assert merged["analysis"]["summary"] == "S"
        assert "analysis_error" not in merged

    def test_analysis_error_is_additive(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """解析失敗でも transcription 結果は失われず、分類コードが残る。"""

        async def fake_analyze(text: str, **_kw: Any) -> dict[str, Any]:
            raise analysis.AnalysisError("llm_unconfigured", "no key")

        monkeypatch.setattr("src.services.meetings.analysis.analyze_transcript", fake_analyze)
        merged = _run(worker._analyze_result({"text": "本文", "segments": [1]}))
        assert merged["analysis_error"] == "llm_unconfigured"
        assert merged["text"] == "本文"
        assert merged["segments"] == [1]

    def test_empty_transcript_skips_llm(self) -> None:
        merged = _run(worker._analyze_result({"text": "  "}))
        assert merged["analysis_error"] == "empty_transcript"
