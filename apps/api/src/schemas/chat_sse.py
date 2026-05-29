"""チャット SSE ストリーミング + F-CTX01 文脈構築 API スキーマ (T-A-18)。

S-E01 チャット画面で、user message を post → assistant 応答を SSE で
チャンク配信する。LLM 呼出前に F-CTX01 文脈構築 (過去 message 数件 +
ナレッジ RAG 上位 hits) を system message として組み立てる。
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class ChatStreamRequest(BaseModel):
    """SSE ストリーム開始リクエスト。

    user_message は thread に追記された assistant 応答対象のユーザ発話。
    use_knowledge_rag=True ならナレッジ RAG (account 単位で voyage 検索) を
    system プロンプトに inject する。include_history は過去 message 数
    (新しい順)。
    """

    user_message: str = Field(min_length=1, max_length=20000)
    use_knowledge_rag: bool = True
    include_history: int = Field(default=10, ge=0, le=50)
    rag_account_id: str | None = None


class ChatStreamChunk(BaseModel):
    """SSE 単一 event payload。"""

    type: Literal["start", "delta", "end", "error", "context"]
    content: str | None = None
    metadata: dict[str, object] | None = None


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
