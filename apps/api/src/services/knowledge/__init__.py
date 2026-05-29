"""ナレッジ (knowledge_nodes) サービス層 (T-A-36)。

RLS が効く AsyncSession を受け取り E-018 knowledge_nodes を操作する。
可視性/権限は RLS (T-D-18)。状態変更で audit_logs 1 行。

Voyage embedding は VoyageClient (T-F-14) 経由。create / update で
content_md を embed して保存、search で query を embed して cosine 類似度
で取得する。VOYAGE_API_KEY 未設定環境では embedding を None で保存し、
search はテキスト LIKE フォールバックする (テスト容易性 / dev 環境)。
"""

from __future__ import annotations

import os
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.embeddings.voyage import VoyageClient, VoyageError
from src.schemas.knowledge import (
    KnowledgeAccountType,
    KnowledgeCreate,
    KnowledgeResponse,
    KnowledgeScope,
    KnowledgeSearchHit,
    KnowledgeSearchResponse,
    KnowledgeUpdate,
)

_COLS = (
    "id, account_id, account_type, scope, owner_employee_id, category, "
    "title, content_md, tags, source_type, source_project_id, "
    "confidence_score, usage_count, is_anonymized, approved_by_user_id, "
    "deleted_at, created_at, updated_at"
)


def _row_to_response(row: Any) -> KnowledgeResponse:
    return KnowledgeResponse(
        id=str(row.id),
        account_id=str(row.account_id),
        account_type=str(row.account_type),  # type: ignore[arg-type]
        scope=str(row.scope),  # type: ignore[arg-type]
        owner_employee_id=(None if row.owner_employee_id is None else str(row.owner_employee_id)),
        category=str(row.category),
        title=str(row.title),
        content_md=str(row.content_md),
        tags=list(row.tags) if row.tags is not None else [],
        source_type=str(row.source_type),
        source_project_id=(None if row.source_project_id is None else str(row.source_project_id)),
        confidence_score=float(row.confidence_score),
        usage_count=int(row.usage_count),
        is_anonymized=bool(row.is_anonymized),
        approved_by_user_id=(
            None if row.approved_by_user_id is None else str(row.approved_by_user_id)
        ),
        deleted_at=row.deleted_at,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _embedding_to_pg_literal(vec: list[float]) -> str:
    """pgvector 入力用の文字列リテラル '[v1,v2,...]' を構築する。"""
    return "[" + ",".join(f"{v:.7f}" for v in vec) + "]"


async def _embed_text(content: str, *, input_type: str = "document") -> list[float] | None:
    """Voyage で content を embed。VOYAGE_API_KEY 未設定なら None を返す。"""
    if not os.environ.get("VOYAGE_API_KEY"):
        return None
    try:
        client = VoyageClient()
        if input_type == "query":
            return await client.embed_query(content)
        result = await client.embed([content], input_type="document")
        return result.embeddings[0]
    except VoyageError:
        return None


async def list_knowledge(
    session: AsyncSession,
    *,
    account_id: str | None = None,
    account_type: KnowledgeAccountType | None = None,
    scope: KnowledgeScope | None = None,
    category: str | None = None,
    limit: int = 50,
) -> list[KnowledgeResponse]:
    where = ["deleted_at is null"]
    params: dict[str, object] = {"lim": limit}
    if account_id is not None:
        where.append("account_id = cast(:aid as uuid)")
        params["aid"] = account_id
    if account_type is not None:
        where.append("account_type = cast(:at as knowledge_account_type_enum)")
        params["at"] = account_type
    if scope is not None:
        where.append("scope = cast(:sc as knowledge_scope_enum)")
        params["sc"] = scope
    if category is not None:
        where.append("category = :cat")
        params["cat"] = category
    res = await session.execute(
        text(
            f"select {_COLS} from public.knowledge_nodes "
            f"where {' and '.join(where)} order by created_at desc limit :lim"
        ),
        params,
    )
    return [_row_to_response(r) for r in res.all()]


async def get_knowledge(session: AsyncSession, knowledge_id: str) -> KnowledgeResponse | None:
    res = await session.execute(
        text(
            f"select {_COLS} from public.knowledge_nodes "
            "where id = cast(:id as uuid) and deleted_at is null"
        ),
        {"id": knowledge_id},
    )
    row = res.first()
    return None if row is None else _row_to_response(row)


async def create_knowledge(
    session: AsyncSession, *, actor_id: str, data: KnowledgeCreate
) -> KnowledgeResponse | None:
    new_id = str(uuid.uuid4())
    embedding = await _embed_text(data.content_md, input_type="document")
    params: dict[str, object] = {
        "id": new_id,
        "aid": data.account_id,
        "at": data.account_type,
        "sc": data.scope,
        "oeid": data.owner_employee_id,
        "cat": data.category,
        "tt": data.title,
        "cm": data.content_md,
        "tg": data.tags,
        "st": data.source_type,
        "spid": data.source_project_id,
        "cs": data.confidence_score,
        "ia": data.is_anonymized,
    }
    if embedding is not None:
        params["emb"] = _embedding_to_pg_literal(embedding)
        emb_sql = "cast(:emb as extensions.vector)"
    else:
        emb_sql = "null"
    res = await session.execute(
        text(
            f"insert into public.knowledge_nodes "
            f"(id, account_id, account_type, scope, owner_employee_id, category, "
            f"title, content_md, tags, embedding, source_type, source_project_id, "
            f"confidence_score, is_anonymized) "
            f"values (cast(:id as uuid), cast(:aid as uuid), "
            f"cast(:at as knowledge_account_type_enum), "
            f"cast(:sc as knowledge_scope_enum), "
            f"cast(:oeid as uuid), :cat, :tt, :cm, :tg, {emb_sql}, "
            f":st, cast(:spid as uuid), :cs, :ia) "
            f"returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="knowledge.create",
            target_type="knowledge_node",
            actor_type="user",
            actor_id=actor_id,
            target_id=new_id,
            after={
                "account_id": data.account_id,
                "account_type": data.account_type,
                "scope": data.scope,
                "title": data.title,
                "embedded": embedding is not None,
            },
        )
    )
    return await get_knowledge(session, new_id)


async def update_knowledge(
    session: AsyncSession, *, actor_id: str, knowledge_id: str, data: KnowledgeUpdate
) -> KnowledgeResponse | None:
    sets: list[str] = []
    params: dict[str, object] = {"id": knowledge_id}
    if data.title is not None:
        sets.append("title = :tt")
        params["tt"] = data.title
    if data.content_md is not None:
        sets.append("content_md = :cm")
        params["cm"] = data.content_md
        # content_md 変更時は embedding を再計算
        new_embedding = await _embed_text(data.content_md, input_type="document")
        if new_embedding is not None:
            sets.append("embedding = cast(:emb as extensions.vector)")
            params["emb"] = _embedding_to_pg_literal(new_embedding)
    if data.category is not None:
        sets.append("category = :cat")
        params["cat"] = data.category
    if data.tags is not None:
        sets.append("tags = :tg")
        params["tg"] = data.tags
    if data.confidence_score is not None:
        sets.append("confidence_score = :cs")
        params["cs"] = data.confidence_score
    if data.is_anonymized is not None:
        sets.append("is_anonymized = :ia")
        params["ia"] = data.is_anonymized
    if not sets:
        return await get_knowledge(session, knowledge_id)
    sets.append("updated_at = now()")
    res = await session.execute(
        text(
            f"update public.knowledge_nodes set {', '.join(sets)} "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        params,
    )
    if res.scalar_one_or_none() is None:
        return None
    await AuditWriter(session).write(
        AuditEvent(
            action="knowledge.update",
            target_type="knowledge_node",
            actor_type="user",
            actor_id=actor_id,
            target_id=knowledge_id,
            after={k: v for k, v in params.items() if k not in {"id", "emb"}},
        )
    )
    return await get_knowledge(session, knowledge_id)


async def delete_knowledge(session: AsyncSession, *, actor_id: str, knowledge_id: str) -> bool:
    res = await session.execute(
        text(
            "update public.knowledge_nodes set deleted_at = now() "
            "where id = cast(:id as uuid) and deleted_at is null returning id"
        ),
        {"id": knowledge_id},
    )
    if res.scalar_one_or_none() is None:
        return False
    await AuditWriter(session).write(
        AuditEvent(
            action="knowledge.delete",
            target_type="knowledge_node",
            actor_type="user",
            actor_id=actor_id,
            target_id=knowledge_id,
        )
    )
    return True


async def search_knowledge(
    session: AsyncSession,
    *,
    query: str,
    limit: int = 10,
    account_id: str | None = None,
) -> KnowledgeSearchResponse:
    """semantic 検索。

    VOYAGE_API_KEY 設定時は query を embed → cosine similarity (1 - <-> distance)
    で検索。未設定時は content_md / title ilike フォールバック (score=0.5)。
    どちらも RLS で account 不可視は自動 skip。
    """
    where = ["deleted_at is null"]
    params: dict[str, object] = {"lim": limit}
    if account_id is not None:
        where.append("account_id = cast(:aid as uuid)")
        params["aid"] = account_id

    query_emb = await _embed_text(query, input_type="query")
    hits: list[KnowledgeSearchHit] = []
    if query_emb is not None:
        # pgvector cosine: 1 - (a <=> b)、より高い score がより類似
        params["q"] = _embedding_to_pg_literal(query_emb)
        sql = (
            f"select {_COLS}, "
            f"(1 - (embedding <=> cast(:q as extensions.vector))) as similarity "
            f"from public.knowledge_nodes "
            f"where {' and '.join(where)} and embedding is not null "
            f"order by embedding <=> cast(:q as extensions.vector) "
            f"limit :lim"
        )
        res = await session.execute(text(sql), params)
        for r in res.all():
            hits.append(
                KnowledgeSearchHit(
                    knowledge=_row_to_response(r),
                    score=float(r.similarity),
                )
            )
    else:
        params["pat"] = f"%{query}%"
        sql = (
            f"select {_COLS} from public.knowledge_nodes "
            f"where {' and '.join(where)} "
            f"and (content_md ilike :pat or title ilike :pat) "
            f"order by created_at desc limit :lim"
        )
        res = await session.execute(text(sql), params)
        for r in res.all():
            hits.append(KnowledgeSearchHit(knowledge=_row_to_response(r), score=0.5))

    # 検索 hit にあった knowledge は usage_count++ (RLS update_owner で可視範囲のみ)
    if hits:
        hit_ids = [h.knowledge.id for h in hits]
        await session.execute(
            text(
                "update public.knowledge_nodes set usage_count = usage_count + 1 "
                "where id = any(cast(:ids as uuid[])) and deleted_at is null"
            ),
            {"ids": hit_ids},
        )
    return KnowledgeSearchResponse(query=query, hits=hits, total=len(hits))
