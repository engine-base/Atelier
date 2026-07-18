"""CANONICAL_PHASE_NAMES 単体 (PG 不要)。

seed_default_phases が投入する工程名が、フロント lib/workflowPhases.ts の
CANONICAL_PHASES label と 1:1 で一致することを固定する (表示不整合の回帰防止)。
"""

from __future__ import annotations

from src.services.workflow import CANONICAL_PHASE_NAMES


def test_canonical_phase_names_match_frontend_labels() -> None:
    assert CANONICAL_PHASE_NAMES == (
        "ヒアリング",
        "要件定義",
        "アーキ設計",
        "デザイン",
        "機能分解",
        "タスク分解",
        "実装",
        "検証",
        "納品",
    )


def test_canonical_phase_names_has_nine_unique_entries() -> None:
    assert len(CANONICAL_PHASE_NAMES) == 9
    assert len(set(CANONICAL_PHASE_NAMES)) == 9
