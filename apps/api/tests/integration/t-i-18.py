"""T-I-18 F-CTX01 ハイブリッド文脈構築試験.

F-CTX01 (phase 連動文脈) は AI 社員の system prompt に
「現在の phase + 直近 N 件の会話 + 関連 knowledge」を hybrid に注入する。

スケルトン: services.chat.build_context() の本実装完了後に肉付け。
現状は context object の構造的契約のみ検証。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class HybridContext:
    """F-CTX01 が構築する hybrid context object."""

    phase: str
    recent_messages: tuple[str, ...]
    knowledge_excerpts: tuple[str, ...]


def _build_context(phase: str, recent: list[str], knowledge: list[str]) -> HybridContext:
    return HybridContext(
        phase=phase,
        recent_messages=tuple(recent),
        knowledge_excerpts=tuple(knowledge),
    )


def test_context_has_three_required_fields() -> None:
    """phase / recent_messages / knowledge_excerpts が必須."""
    ctx = _build_context("実装", ["m1"], ["k1"])
    assert ctx.phase == "実装"
    assert ctx.recent_messages == ("m1",)
    assert ctx.knowledge_excerpts == ("k1",)


def test_context_is_immutable() -> None:
    """frozen dataclass で immutable に保つ (race condition 回避)."""
    ctx = _build_context("設計", [], [])
    try:
        ctx.phase = "実装"  # type: ignore[misc]
    except Exception:
        return
    raise AssertionError("context が mutable: F-CTX01 不変条件違反")
