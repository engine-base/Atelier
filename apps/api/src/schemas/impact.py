"""影響範囲解析 API スキーマ (T-A-23 / F-IMP01)。

tasks.dependencies (uuid[]) を有向辺としてグラフを構築し、起点 task の変更で
影響を受ける下流 (descendants) を返す read-only エンドポイント。
"""

from __future__ import annotations

from pydantic import BaseModel


class ImpactAnalysisResponse(BaseModel):
    root_task_id: str
    affected_task_ids: list[str]
    affected_count: int
