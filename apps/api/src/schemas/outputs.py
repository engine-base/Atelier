"""成果物 (workflow_outputs) API スキーマ (T-A-21 / GAP-023)。

E-006 workflow_outputs (project_scoped)。各工程の生成物。read 中心 (一覧・取得) に
加え、S-G01 の「編集」= ドキュメント AI (スティーブ) への修正依頼 (revise) と
コメント起点の AI 修正提案 (output_fix_proposals) を扱う。
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class OutputResponse(BaseModel):
    id: str
    project_id: str
    phase_id: str | None
    stage: str
    html_path: str | None
    json_path: str | None
    md_path: str | None
    summary: str | None
    version: int
    # GAP-023: 改訂メタ (author / revision_instruction / revised_from_version / model)
    meta: dict[str, object] = Field(default_factory=lambda: dict[str, object]())
    deleted_at: datetime | None
    created_at: datetime
    updated_at: datetime


class OutputReviseRequest(BaseModel):
    """「編集」= ドキュメント AI (スティーブ) への修正依頼 (GAP-023)。"""

    instruction: str = Field(min_length=1, max_length=4000)


class OutputAnchorResponse(BaseModel):
    """成果物 HTML 内の id 付き要素 (コメントの対象位置ピッカーの実体)。

    サーバーが実 HTML を取得して抽出する — 推測の位置候補は返さない。
    """

    element_id: str
    label: str


class FixProposalResponse(BaseModel):
    """コメントへの AI (スティーブ) 修正提案 (E: output_fix_proposals)。"""

    id: str
    comment_id: str
    output_id: str
    proposal: str
    status: str
    """pending / approved / rejected"""

    applied_output_id: str | None
    created_at: datetime
    resolved_at: datetime | None


class FixProposalApproveResponse(BaseModel):
    """承認結果 — 適用で生まれた新バージョンの成果物を返す。"""

    proposal: FixProposalResponse
    new_output: OutputResponse
