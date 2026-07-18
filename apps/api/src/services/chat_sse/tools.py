"""チャットの Atelier ツール群（agentic tool-use）。

チャットの AI 社員が「しゃべる」だけでなく、実際にアプリ操作（成果物の保存等）を
行えるようにするための client-side tool 定義と実行器。web_search（Anthropic
server-side tool）とは別に、ここで定義したツールは chat_sse の agentic ループが
`tool_use` を受けてサーバ側で実行し、`tool_result` を返して継続する。

第1弾は `save_deliverable`（AI が作った成果物をナレッジとして永続化し、ナレッジ画面で
参照できるようにする）。以後、工程遷移・タスク作成・成果物HTML生成 等を同じ枠組みで追加する。
同じ実行器を MCP 経路からも再利用できるよう、LLM 非依存の純粋な関数として実装する。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from src.schemas.knowledge import KnowledgeCreate
from src.services import knowledge as knowledge_svc


@dataclass(frozen=True)
class ToolContext:
    """ツール実行に必要な実行文脈（RLS セッション + 実行者 + 対象）。"""

    session: AsyncSession
    actor_id: str
    project_id: str | None
    workspace_id: str | None


def atelier_tool_defs() -> list[dict[str, Any]]:
    """Anthropic Messages API 形式の tool 定義一覧。"""
    return [
        {
            "name": "save_deliverable",
            "description": (
                "作成した成果物(要件定義・提案書・議事メモ 等)をナレッジとして保存し、"
                "後からナレッジ画面で参照できるようにする。ユーザーが『保存して』"
                "『ナレッジに残して』等と言った時や、重要な成果物を作り終えた時に使う。"
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "成果物のタイトル"},
                    "category": {
                        "type": "string",
                        "description": "分類(例: 要件定義 / 提案 / 見積 / メモ)",
                    },
                    "content_md": {
                        "type": "string",
                        "description": "Markdown 本文(成果物の中身そのもの)",
                    },
                },
                "required": ["title", "category", "content_md"],
            },
        },
    ]


ATELIER_TOOL_NAMES: frozenset[str] = frozenset(d["name"] for d in atelier_tool_defs())


async def _save_deliverable(ctx: ToolContext, tool_input: dict[str, Any]) -> str:
    if not ctx.workspace_id:
        return "エラー: ワークスペースを特定できないため保存できませんでした。"
    title = str(tool_input.get("title") or "無題").strip()[:200] or "無題"
    category = str(tool_input.get("category") or "成果物").strip()[:100] or "成果物"
    content = str(tool_input.get("content_md") or "").strip() or "(本文なし)"
    created = await knowledge_svc.create_knowledge(
        ctx.session,
        actor_id=ctx.actor_id,
        data=KnowledgeCreate(
            account_id=ctx.workspace_id,
            account_type="workspace",
            scope="common",
            category=category,
            title=title,
            content_md=content,
        ),
    )
    if created is None:
        return "保存に失敗しました(権限または可視性の制約)。"
    return (
        f"成果物「{created.title}」をナレッジに保存しました(id={created.id})。"
        "ナレッジ画面の『共通』タブから参照できます。"
    )


async def execute_atelier_tool(ctx: ToolContext, name: str, tool_input: dict[str, Any]) -> str:
    """name に対応する Atelier ツールを実行し、tool_result 用の文字列を返す。

    未知/失敗はエラー文字列を返し、会話は継続できるようにする(例外で stream を落とさない)。
    """
    try:
        if name == "save_deliverable":
            return await _save_deliverable(ctx, tool_input)
        return f"未対応のツールです: {name}"
    except Exception as exc:  # pragma: no cover - 実行時例外は tool_result で AI に返す
        return f"ツール実行中にエラーが発生しました: {type(exc).__name__}: {exc}"
