# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false
"""S-N01 ドラフトの AI 生成 = 営業 AI (トニー) + ナレッジ RAG (GAP-018)。

モックの「ナレッジの過去成約パターンから自動生成」の実体。GAP-022/023/024 と
同じ確定アーキ判断 (AI 生成は人間の明示操作起点のみ・自動生成しない) に従う:
  1. 「トニーにドラフト生成を依頼」(明示操作) → 実ナレッジ RAG 検索
     (services.knowledge.search_knowledge — 推測ソースは作らない)
  2. LLM が doc_type 別のドラフト (markdown) を生成
  3. sales doc 行を作成し、生成トレース (generated_by / model / inputs /
     knowledge_refs / steps) を meta に、参照ナレッジを knowledge_references
     (referrer_type='sales_doc') に記録
ANTHROPIC_API_KEY 未設定は 503 (偽の文面を出さない)。テストのみ
ATELIER_ALLOW_FAKE_LLM=1 で決定的スタブ。
"""

from __future__ import annotations

import os
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.llm.client import LLMMessage
from src.schemas.sales_docs import SalesDocGenerateRequest, SalesDocResponse
from src.services.knowledge import search_knowledge

from . import get_sales_doc, is_uuid, next_version

GENERATE_MODEL = os.environ.get("ATELIER_SALES_MODEL", "claude-sonnet-4-6")

DOC_TYPE_LABEL: dict[str, str] = {
    "proposal": "提案書",
    "estimate": "見積書",
    "contract": "業務委託契約書",
    "nda": "秘密保持契約書 (NDA)",
    "invoice": "請求書",
}

_SYSTEM_BASE = (
    "あなたは開発案件管理 SaaS の営業 AI「トニー」です。"
    "商談情報と参照ナレッジをもとに、{label}のドラフトを日本語の Markdown で作成してください。"
    "金額・日付・条件など未確定の情報は「(要確認)」と明示し、创作しないこと。"
    "末尾に「※ 本ドラフトは AI 補助で作成されています。最終版は人間レビュー後に確定されます。」"
    "の一文を必ず含めること。出力はドラフト本文 (Markdown) のみ。"
)


class SalesDocGenerateError(Exception):
    """生成の構造的失敗 (code: llm_unconfigured / llm_failed)。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def _generate_body(
    data: SalesDocGenerateRequest,
    knowledge_excerpts: list[dict[str, str]],
    client: Any | None,
) -> tuple[str, str]:
    """本文を生成する。返り値 (markdown, 使用モデル)。"""
    label = DOC_TYPE_LABEL[data.doc_type]
    if client is None and not os.environ.get("ANTHROPIC_API_KEY"):
        if os.environ.get("ATELIER_ALLOW_FAKE_LLM") == "1":
            refs = "\n".join(f"- {k['title']}" for k in knowledge_excerpts) or "- (参照なし)"
            return (
                f"# {data.opportunity} {label}\n\n"
                f"顧客: {data.customer}\n\n"
                f"[fake LLM] 商談概要「{data.notes[:120]}」をもとに生成した{label}ドラフト。\n\n"
                f"## 参照ナレッジ\n{refs}\n\n"
                "※ 本ドラフトは AI 補助で作成されています。最終版は人間レビュー後に確定されます。"
            ), "fake-llm"
        raise SalesDocGenerateError(
            "llm_unconfigured",
            "ANTHROPIC_API_KEY が未設定のため営業 AI によるドラフト生成を実行できません",
        )
    if client is None:
        from src.llm.anthropic import AnthropicClient

        client = AnthropicClient()
    knowledge_block = (
        "\n\n".join(f"### {k['title']}\n{k['content'][:2000]}" for k in knowledge_excerpts)
        or "(参照ナレッジなし)"
    )
    try:
        res = await client.complete(
            model=GENERATE_MODEL,
            messages=[
                LLMMessage(
                    role="user",
                    content=(
                        f"顧客名: {data.customer}\n案件: {data.opportunity}\n\n"
                        f"商談概要・要望:\n{data.notes}\n\n"
                        f"参照ナレッジ:\n{knowledge_block}"
                    ),
                )
            ],
            system=_SYSTEM_BASE.format(label=label),
            max_tokens=4096,
            temperature=0.3,
        )
    except Exception as e:
        raise SalesDocGenerateError("llm_failed", f"LLM 呼出に失敗: {e}") from e
    body = str(res.text).strip()
    if not body:
        raise SalesDocGenerateError("llm_failed", "LLM が空のドラフトを返しました")
    return body, GENERATE_MODEL


async def generate(
    session: AsyncSession,
    *,
    actor_id: str,
    data: SalesDocGenerateRequest,
    client: Any | None = None,
) -> SalesDocResponse | None:
    """AI 生成でドラフトを作成する。None = project 不可視/不在。"""
    if not is_uuid(data.project_id):
        return None
    proj = await session.execute(
        text(
            "select p.id, p.workspace_id from public.projects p "
            "where p.id = cast(:pid as uuid) and p.deleted_at is null"
        ),
        {"pid": data.project_id},
    )
    project = proj.first()
    if project is None:
        return None

    # 実ナレッジ RAG (推測ソースを作らない — hit したものだけがトレースに残る)。
    # 埋め込み未設定時の ilike フォールバックは部分一致のため、長い合成クエリ
    # ではなく観点別 (doc_type ラベル / 案件 / 顧客) に検索して上位をマージする。
    label = DOC_TYPE_LABEL[data.doc_type]
    seen_ids: set[str] = set()
    hits = []
    for q in (
        f"{label} {data.opportunity} {data.notes[:120]}",
        label,
        data.opportunity,
        data.customer,
    ):
        search = await search_knowledge(
            session,
            query=q,
            limit=3,
            account_id=str(project.workspace_id),
            project_id=data.project_id,
        )
        for h in search.hits:
            if h.knowledge.id in seen_ids:
                continue
            seen_ids.add(h.knowledge.id)
            hits.append(h)
        if len(hits) >= 3:
            break
    hits = hits[:3]
    knowledge_refs = [
        {
            "id": h.knowledge.id,
            "title": h.knowledge.title,
            "category": h.knowledge.category,
        }
        for h in hits
    ]
    excerpts = [{"title": h.knowledge.title, "content": h.knowledge.content_md} for h in hits]

    body, used_model = await _generate_body(data, excerpts, client)

    version = await next_version(session, project_id=data.project_id, doc_type=data.doc_type)
    meta: dict[str, object] = {
        "generated_by": "tony",
        "model": used_model,
        "inputs": {"customer": data.customer, "opportunity": data.opportunity},
        "knowledge_refs": knowledge_refs,
        # 実際に行った工程のみを記録する (実行していないレビュー等は含めない)
        "steps": [
            f"ナレッジ参照 ({len(knowledge_refs)} 件)",
            f"トニーが本文を生成 ({used_model})",
        ],
    }
    import json as json_mod

    row = await session.execute(
        text(
            "insert into public.workflow_outputs "
            "(project_id, stage, summary, version, meta) "
            "values (cast(:pid as uuid), cast(:st as workflow_stage_enum), :sm, :ver, "
            "cast(:meta as jsonb)) returning id"
        ),
        {
            "pid": data.project_id,
            "st": data.doc_type,
            "sm": body,
            "ver": version,
            "meta": json_mod.dumps(meta, ensure_ascii=False),
        },
    )
    new_id = str(row.scalar_one())

    # 生成トレース: 参照した実ナレッジを knowledge_references に記録
    for ref in knowledge_refs:
        await session.execute(
            text(
                "insert into public.knowledge_references "
                "(knowledge_id, referrer_type, referrer_id, context) "
                "values (cast(:kid as uuid), 'sales_doc', cast(:rid as uuid), :ctx) "
                "on conflict (knowledge_id, referrer_type, referrer_id) "
                "do update set reference_count = public.knowledge_references.reference_count + 1, "
                "last_referenced_at = now()"
            ),
            {"kid": ref["id"], "rid": new_id, "ctx": data.doc_type},
        )

    await AuditWriter(session).write(
        AuditEvent(
            action="sales_doc.generate",
            target_type="workflow_output",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={
                "doc_type": data.doc_type,
                "version": version,
                "knowledge_refs": [r["id"] for r in knowledge_refs],
                "model": used_model,
            },
        )
    )
    return await get_sales_doc(session, new_id)
