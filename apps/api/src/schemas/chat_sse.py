"""チャット SSE ストリーミング + F-CTX01 文脈構築 API スキーマ (T-A-18)。

S-E01 チャット画面で、user message を post → assistant 応答を SSE で
チャンク配信する。LLM 呼出前に F-CTX01 文脈構築 (過去 message 数件 +
ナレッジ RAG 上位 hits) を system message として組み立てる。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from src.schemas.chat import ChatAttachment


class ChatStreamRequest(BaseModel):
    """SSE ストリーム開始リクエスト。

    user_message は thread に追記された assistant 応答対象のユーザ発話。
    use_knowledge_rag=True ならナレッジ RAG (account 単位で voyage 検索) を
    system プロンプトに inject する。include_history は過去 message 数
    (新しい順)。attachments は事前に /chat/attachments/upload-url → PUT 済の
    添付メタ (GAP-001 — user message に関連付けて永続)。
    """

    user_message: str = Field(min_length=1, max_length=20000)
    use_knowledge_rag: bool = True
    include_history: int = Field(default=10, ge=0, le=50)
    rag_account_id: str | None = None
    # GAP-129/130: PC 操作 (Claude Code 同等ツール)。"off"=従来 (ツールなし)、
    # "approve"=実行ごとにユーザー承認 (Claude Code の permission prompt 同等)、
    # "auto"=確認なしで自動実行。いずれも agent_sdk モード限定・本人 opt-in。
    tools_mode: Literal["off", "approve", "auto"] = "off"
    attachments: list[ChatAttachment] = Field(
        default_factory=lambda: list[ChatAttachment](), max_length=10
    )


class ChatStreamChunk(BaseModel):
    """SSE 単一 event payload。"""

    type: Literal[
        "start",
        "delta",
        "end",
        "error",
        "context",
        "tool",
        "pc_approval",
        "pc_approval_resolved",
    ]
    content: str | None = None
    metadata: dict[str, object] | None = None


class PcApprovalDecisionRequest(BaseModel):
    """GAP-130: PC 操作 (approve モード) の承認カードへの決定。"""

    decision: Literal["allow", "deny"]


class PcApprovalDecisionResponse(BaseModel):
    """決定の受理結果。"""

    resolved: bool


class ChatContextPreviewRequest(BaseModel):
    """SSE を回さずに F-CTX01 構築結果だけを取り出すデバッグ用 API。"""

    user_message: str = Field(min_length=1, max_length=20000)
    include_history: int = Field(default=10, ge=0, le=50)
    rag_account_id: str | None = None


class ChatContextPreviewResponse(BaseModel):
    """構築された system_prompt + 引用ナレッジ。"""

    system_prompt: str
    history_count: int
    rag_hit_ids: list[str]


# ── GAP-189: 実行の制御 (中断 / 追い足し / 繋ぎ直し) ───────────────────


class ChatRunResponse(BaseModel):
    """今このスレッドで走っている実行 (無ければ null)。"""

    job_id: str | None = None
    status: str | None = None
    tools_mode: str | None = None
    started_at: str | None = None


class ChatRunCancelResponse(BaseModel):
    """中断の結果。message はそのまま画面に出せる日本語。"""

    status: Literal["cancelled", "already_finished"]
    message: str
    assistant_message_id: str | None = None
    saved_chars: int = 0


class ChatQueuedMessageRequest(BaseModel):
    """実行中に送られた追い足し指示。受領した瞬間に保存する。"""

    content: str = Field(min_length=1, max_length=20000)
    tools_mode: Literal["off", "approve", "auto"] = "off"


class ChatQueuedMessageResponse(BaseModel):
    """待ち行列の 1 件。"""

    id: str
    content: str
    tools_mode: str
    created_at: str | None = None
