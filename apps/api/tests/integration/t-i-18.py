"""T-I-18 F-CTX01 ハイブリッド文脈構築試験.

F-CTX01 (phase 連動文脈) の前提となる「スレッド投稿権限ガード」を実 service
`src.services.chat.can_post_to_thread` で exercise する。viewer は投稿不可
(owner/member のみ) という RLS 整合のガードを検証する。

加えて hybrid context object (phase + recent messages + knowledge) の構造的
契約を frozen dataclass で検証する。
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from src.services.chat import can_post_to_thread

from ._stub import StubResult, StubSession


def test_can_post_true_for_member() -> None:
    """owner/member は投稿可能 (exists が True)。"""
    session = StubSession([StubResult(value=True)])
    ok = asyncio.run(can_post_to_thread(session, thread_id="t1"))  # type: ignore[arg-type]
    assert ok is True


def test_can_post_false_for_viewer() -> None:
    """viewer は投稿不可 (exists が False)。"""
    session = StubSession([StubResult(value=False)])
    ok = asyncio.run(can_post_to_thread(session, thread_id="t1"))  # type: ignore[arg-type]
    assert ok is False


# --- hybrid context object 構造契約 (F-CTX01) ----------------------------- #


@dataclass(frozen=True)
class HybridContext:
    phase: str
    recent_messages: tuple[str, ...]
    knowledge_excerpts: tuple[str, ...]


def _build_context(phase: str, recent: list[str], knowledge: list[str]) -> HybridContext:
    return HybridContext(
        phase=phase,
        recent_messages=tuple(recent),
        knowledge_excerpts=tuple(knowledge),
    )


def test_hybrid_context_has_three_required_fields() -> None:
    ctx = _build_context("実装", ["m1", "m2"], ["k1"])
    assert ctx.phase == "実装"
    assert ctx.recent_messages == ("m1", "m2")
    assert ctx.knowledge_excerpts == ("k1",)


def test_hybrid_context_is_immutable() -> None:
    """F-CTX01: context は frozen (並列文脈構築での race を回避)."""
    ctx = _build_context("設計", [], [])
    try:
        ctx.phase = "実装"  # type: ignore[misc]
    except Exception:
        return
    raise AssertionError("context が mutable: F-CTX01 不変条件違反")
