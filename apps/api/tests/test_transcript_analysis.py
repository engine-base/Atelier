# pyright: reportPrivateUsage=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false
"""議事録構造化解析の unit tests (GAP-015 → GAP-184 で全面改訂)。

GAP-184 で固定する挙動:
  - 長い会議を**打ち切らない** (分割して全部読む)
  - 決定事項・論点・数値・リスク・未決を落とさない 9 セクション
  - 各項目に引用 (quote) を持てる = 創作を人が検出できる
  - プラン枠の上限は「失敗」ではなく「後で再試行」
"""

from __future__ import annotations

import asyncio
import json
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
    """毎回同じ応答を返す fake。reply が list なら呼び出しごとに順に返す。"""

    def __init__(self, reply: str | Exception | list[str]) -> None:
        self._reply = reply
        self.calls: list[dict[str, Any]] = []

    async def complete(self, **kwargs: Any) -> _FakeResponse:
        self.calls.append(kwargs)
        if isinstance(self._reply, Exception):
            raise self._reply
        if isinstance(self._reply, list):
            idx = min(len(self.calls) - 1, len(self._reply) - 1)
            return _FakeResponse(text=self._reply[idx])
        return _FakeResponse(text=self._reply)


_RICH_JSON = json.dumps(
    {
        "summary": "LP 制作の要件と予算・納期を確認し、構成を 2 案から 1 案に絞った。",
        "speakers": [
            {"name": "田中", "role": "クライアント"},
            {"name": "ワンダ", "role": None},
        ],
        "agenda": ["現状の課題", "構成案の比較", "予算と納期"],
        "decisions": [
            {
                "title": "構成は A 案で確定",
                "detail": "トップ + 問い合わせの 2 ページ構成にする",
                "decided_by": "田中",
                "quote": "じゃあ A 案でいきましょう",
            }
        ],
        "requirements": [
            {
                "title": "問い合わせフォームに自動返信",
                "detail": "送信後にサンクスメールを自動送信する",
                "kind": "functional",
                "priority": "must",
                "quote": "自動返信は絶対に欲しいです",
            },
            {
                "title": "スマホ表示を優先",
                "detail": "アクセスの 7 割がスマホ",
                "kind": "non_functional",
                "priority": "should",
                "quote": "うちのお客さん、ほぼスマホなんですよ",
            },
        ],
        "open_questions": [
            {
                "question": "写真素材は誰が用意するか",
                "context": "既存素材の権利が不明",
                "quote": "写真ってこちらで用意するんでしたっけ",
            }
        ],
        "risks": [
            {
                "title": "素材の到着遅れ",
                "impact": "公開日が後ろ倒しになる",
                "quote": "素材が遅れると厳しいですね",
            }
        ],
        "action_items": [
            {
                "title": "見積ドラフト作成",
                "owner": "ワンダ",
                "due": "今週金曜",
                "quote": "金曜までに見積もりをください",
            },
            "ヒアリング議事録の共有",
        ],
        "facts": [
            {"label": "予算", "value": "80 万円", "quote": "予算は 80 万くらいで"},
            {"label": "公開希望日", "value": "4 月 1 日", "quote": "4 月 1 日には出したい"},
        ],
        "next_meeting": {"date": "来週水曜 14:00", "agenda": "見積のレビュー"},
    },
    ensure_ascii=False,
)


class TestRichSchema:
    def test_extracts_all_nine_sections(self) -> None:
        """1 時間の会議で落としてはいけない項目が全部入る (GAP-184 の主眼)。"""
        client = _FakeClient(_RICH_JSON)
        r = _run(analysis.analyze_transcript("打合せ本文", client=client))
        assert r["summary"]
        assert r["speakers"][0] == {"name": "田中", "role": "クライアント"}
        assert r["agenda"] == ["現状の課題", "構成案の比較", "予算と納期"]
        assert r["decisions"][0]["title"] == "構成は A 案で確定"
        assert len(r["requirements"]) == 2
        assert r["open_questions"][0]["question"].startswith("写真素材")
        assert r["risks"][0]["title"] == "素材の到着遅れ"
        assert r["action_items"][0]["owner"] == "ワンダ"
        assert r["action_items"][0]["due"] == "今週金曜"
        assert {f["label"] for f in r["facts"]} == {"予算", "公開希望日"}
        assert r["next_meeting"]["date"] == "来週水曜 14:00"

    def test_every_item_can_carry_a_source_quote(self) -> None:
        """引用があるから「創作していないか」を人が確かめられる。"""
        client = _FakeClient(_RICH_JSON)
        r = _run(analysis.analyze_transcript("打合せ本文", client=client))
        assert r["decisions"][0]["quote"] == "じゃあ A 案でいきましょう"
        assert r["requirements"][0]["quote"] == "自動返信は絶対に欲しいです"
        assert r["facts"][0]["quote"] == "予算は 80 万くらいで"

    def test_requirements_are_classified_and_prioritised(self) -> None:
        client = _FakeClient(_RICH_JSON)
        r = _run(analysis.analyze_transcript("x", client=client))
        kinds = {q["kind"] for q in r["requirements"]}
        assert kinds == {"functional", "non_functional"}
        assert r["requirements"][0]["priority"] == "must"

    def test_system_prompt_tells_the_model_not_to_be_thin(self) -> None:
        client = _FakeClient(_RICH_JSON)
        _run(analysis.analyze_transcript("x", client=client))
        system = str(client.calls[0]["system"])
        assert "薄くまとめないこと" in system
        assert "quote" in system
        assert "数値・金額・日付" in system


class TestLongMeetingIsNotTruncated:
    def test_split_covers_the_whole_transcript(self) -> None:
        """打ち切らない。1 時間 = 約 18,000〜24,000 字でも全部読む。"""
        body = "あ" * 25_000
        chunks = analysis.split_transcript(body)
        assert len(chunks) >= 3
        # 重なりがあるので合計は元より長い = 欠落が無い
        assert sum(len(c) for c in chunks) >= len(body)

    def test_short_transcript_is_a_single_chunk(self) -> None:
        assert len(analysis.split_transcript("短い会議")) == 1

    def test_empty_transcript_is_reported_not_faked(self) -> None:
        with pytest.raises(analysis.AnalysisError) as ei:
            _run(analysis.analyze_transcript("   ", client=_FakeClient(_RICH_JSON)))
        assert ei.value.code == "empty"

    def test_long_meeting_calls_llm_per_chunk_and_merges(self) -> None:
        """2 時間の会議でも後半が消えない (旧実装は 24,000 字で切っていた)。"""
        body = "い" * 25_000
        merge_reply = json.dumps({"summary": "全体の流れ"}, ensure_ascii=False)
        client = _FakeClient([_RICH_JSON, _RICH_JSON, _RICH_JSON, merge_reply])
        r = _run(analysis.analyze_transcript(body, client=client))
        assert r["segments"] >= 3
        assert r["source_chars"] == 25_000
        # チャンク数 + 統合要約の 1 回
        assert len(client.calls) == r["segments"] + 1
        assert r["summary"] == "全体の流れ"

    def test_merge_deduplicates_repeated_items(self) -> None:
        """同じ決定が複数区間に出ても 1 件にまとまる。"""
        part = analysis.normalize(json.loads(_RICH_JSON))
        merged = analysis.merge_sections([part, part, part])
        assert len(merged["decisions"]) == 1
        assert len(merged["requirements"]) == 2
        assert len(merged["facts"]) == 2


class TestNormalizeIsForgiving:
    def test_old_string_only_requirements_still_work(self) -> None:
        """過去に保存された旧形式 (文字列だけ) を壊さない。"""
        out = analysis.normalize({"requirements": ["納期 4 週間"], "action_items": ["共有"]})
        assert out["requirements"][0]["title"] == "納期 4 週間"
        assert out["requirements"][0]["kind"] == "functional"
        assert out["action_items"][0] == {
            "title": "共有",
            "owner": None,
            "due": None,
            "quote": "",
        }

    def test_unknown_kind_and_priority_fall_back(self) -> None:
        out = analysis.normalize(
            {"requirements": [{"title": "x", "kind": "でたらめ", "priority": "最高"}]}
        )
        assert out["requirements"][0]["kind"] == "functional"
        assert out["requirements"][0]["priority"] == "should"

    def test_items_without_the_required_field_are_dropped(self) -> None:
        """根拠になる見出しが無い項目は捨てる (空の箱を並べない)。"""
        out = analysis.normalize({"decisions": [{"detail": "詳細だけ"}, {"title": "本物"}]})
        assert len(out["decisions"]) == 1
        assert out["decisions"][0]["title"] == "本物"


class TestErrors:
    def test_code_fence_reply_is_accepted(self) -> None:
        client = _FakeClient(f"```json\n{_RICH_JSON}\n```")
        assert _run(analysis.analyze_transcript("t", client=client))["summary"]

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

    def test_no_route_reports_bridge_offline_and_is_retryable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from src.services.chat_sse import relay as relay_mod

        async def _offline(*_a: object, **_k: object):
            raise relay_mod.RelayUnavailable
            yield ""

        monkeypatch.delenv("ATELIER_ALLOW_FAKE_LLM", raising=False)
        monkeypatch.setattr(relay_mod, "relay_stream_chunks", _offline)
        with pytest.raises(analysis.AnalysisError) as ei:
            _run(analysis.analyze_transcript("t"))
        assert ei.value.code == "bridge_offline"
        assert ei.value.code in analysis.RETRYABLE_CODES


class TestPlanLimitIsNotAFailure:
    """GAP-184: 5 時間 / 7 日の枠は必ずリセットされる。失敗で確定させない。"""

    def test_rate_limited_is_retryable(self) -> None:
        assert "rate_limited" in analysis.RETRYABLE_CODES

    def test_worker_holds_the_row_on_plan_limit(self) -> None:
        assert worker._analysis_retryable({"analysis_error": "rate_limited"}) is True

    def test_worker_does_not_hold_on_permanent_failure(self) -> None:
        assert worker._analysis_retryable({"analysis_error": "parse_failed"}) is False

    def test_chain_classifies_limit_messages(self) -> None:
        from src.services.chat_sse.llm_chain import _looks_rate_limited

        assert _looks_rate_limited("Claude usage limit reached, resets at 15:00")
        assert _looks_rate_limited("rate_limit_error")
        assert _looks_rate_limited("プラン枠の上限に達しました")
        assert not _looks_rate_limited("connection refused")

    def test_scheduled_actions_also_retry_on_limit(self) -> None:
        from src.services.cron.actions import RETRYABLE_LLM_CODES

        assert "rate_limited" in RETRYABLE_LLM_CODES
