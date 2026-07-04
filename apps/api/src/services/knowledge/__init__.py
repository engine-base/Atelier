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
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.embeddings.voyage import VoyageClient, VoyageError
from src.schemas.knowledge import (
    KnowledgeAccountType,
    KnowledgeCreate,
    KnowledgePattern,
    KnowledgePatternResponse,
    KnowledgeResponse,
    KnowledgeScope,
    KnowledgeSearchHit,
    KnowledgeSearchResponse,
    KnowledgeUpdate,
)

_COLS = (
    "id, account_id, account_type, scope, owner_employee_id, parent_id, "
    "visible_in_tree, category, "
    "title, content_md, tags, source_type, source_project_id, "
    "confidence_score, usage_count, is_anonymized, approved_by_user_id, "
    "deleted_at, created_at, updated_at"
)

# 運営デフォルト(platform)ナレッジの account_id は polymorphic 列の非NULL要件を満たす
# だけの固定 sentinel（FK 無し / 読取は account_type='platform' で横断マッチ）。
# migration t-d-09_018_knowledge_platform_default.sql の設計（アプリ層で固定 UUID）に従う。
_PLATFORM_ACCOUNT_SENTINEL = "00000000-0000-0000-0000-000000000000"


def _row_to_response(row: Any) -> KnowledgeResponse:
    return KnowledgeResponse(
        id=str(row.id),
        account_id=str(row.account_id),
        account_type=str(row.account_type),  # type: ignore[arg-type]
        scope=str(row.scope),  # type: ignore[arg-type]
        owner_employee_id=(None if row.owner_employee_id is None else str(row.owner_employee_id)),
        parent_id=(None if row.parent_id is None else str(row.parent_id)),
        visible_in_tree=bool(row.visible_in_tree),
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
    source_project_id: str | None = None,
    parent_id: str | None = None,
    tree_only: bool = False,
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
    if source_project_id is not None:
        where.append("source_project_id = cast(:spid as uuid)")
        params["spid"] = source_project_id
    if parent_id is not None:
        # parent_id 指定時は当該親の直下の子ノードのみ返す（構造ツリー）
        where.append("parent_id = cast(:pid as uuid)")
        params["pid"] = parent_id
    if tree_only:
        # ツリー表示用: 非表示(運営デフォルト等)を除外。検索(RAG)はこのフラグを使わない。
        where.append("visible_in_tree = true")
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
    # platform(運営デフォルト)は account_id を信頼せず sentinel に固定する。
    account_id = _PLATFORM_ACCOUNT_SENTINEL if data.account_type == "platform" else data.account_id
    params: dict[str, object] = {
        "id": new_id,
        "aid": account_id,
        "at": data.account_type,
        "sc": data.scope,
        "oeid": data.owner_employee_id,
        "pid": data.parent_id,
        "vit": data.visible_in_tree,
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
    try:
        res = await session.execute(
            text(
                f"insert into public.knowledge_nodes "
                f"(id, account_id, account_type, scope, owner_employee_id, parent_id, "
                f"visible_in_tree, category, "
                f"title, content_md, tags, embedding, source_type, source_project_id, "
                f"confidence_score, is_anonymized) "
                f"values (cast(:id as uuid), cast(:aid as uuid), "
                f"cast(:at as knowledge_account_type_enum), "
                f"cast(:sc as knowledge_scope_enum), "
                f"cast(:oeid as uuid), cast(:pid as uuid), :vit, :cat, :tt, :cm, :tg, {emb_sql}, "
                f":st, cast(:spid as uuid), :cs, :ia) "
                f"returning id"
            ),
            params,
        )
    except ProgrammingError:
        # RLS with check 違反 (例: member による platform 書込) は 403 相当として None。
        return None
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
                "account_id": account_id,
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
    if data.parent_id is not None:
        sets.append("parent_id = cast(:pid as uuid)")
        params["pid"] = data.parent_id
    if data.visible_in_tree is not None:
        sets.append("visible_in_tree = :vit")
        params["vit"] = data.visible_in_tree
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
        # 運営デフォルト(account_type=platform)は全テナント横断で RAG 参照可。
        # visible_in_tree は検索では無視する(ツリー非表示でも参照される)。
        where.append("(account_id = cast(:aid as uuid) or account_type = 'platform')")
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


# --------------------------------------------------------------------------- #
# T-A-37: ナレッジ昇格 + 横断パターン抽出
# --------------------------------------------------------------------------- #
class PromoteResult:
    """promote_knowledge の結果コード。"""

    SUCCESS = "success"
    NOT_FOUND = "not_found"
    NOT_USER_OWNED = "not_user_owned"
    EMPLOYEE_SPECIFIC = "employee_specific"
    NOT_MEMBER = "not_member"


async def _is_workspace_member(session: AsyncSession, *, user_id: str, workspace_id: str) -> bool:
    """user が workspace の member 以上か (owner / member)。viewer は不可。"""
    res = await session.execute(
        text(
            "select 1 from public.workspace_memberships "
            "where workspace_id = cast(:w as uuid) "
            "and user_id = cast(:u as uuid) "
            "and role in ('owner', 'member')"
        ),
        {"w": workspace_id, "u": user_id},
    )
    return res.first() is not None


async def promote_knowledge(
    session: AsyncSession,
    *,
    actor_id: str,
    knowledge_id: str,
    target_workspace_id: str,
    confidence_score: float | None,
) -> tuple[str, KnowledgeResponse | None]:
    """user-scope ナレッジを workspace common に昇格する。

    制約:
    - 元のナレッジの account_type='user' かつ account_id=actor_id 必須
      (他人の knowledge は昇格不可。RLS が SELECT を許しても自分名義のみ昇格)
    - scope='employee_specific' は不可 (workspace common と整合しない)
    - actor が target_workspace_id の owner/member 必須 (viewer 不可)

    昇格後:
    - account_type='workspace', account_id=target_workspace_id
    - scope='common' 維持、owner_employee_id=null
    - approved_by_user_id=actor_id (昇格承認者)
    - confidence_score: 引数指定で上書き、未指定なら元の値を維持
    - audit_logs に knowledge.promote (before/after)
    """
    res = await session.execute(
        text(
            "select account_id, account_type, scope, confidence_score "
            "from public.knowledge_nodes "
            "where id = cast(:i as uuid) and deleted_at is null"
        ),
        {"i": knowledge_id},
    )
    row = res.first()
    if row is None:
        return PromoteResult.NOT_FOUND, None
    if str(row.scope) == "employee_specific":
        return PromoteResult.EMPLOYEE_SPECIFIC, None
    if str(row.account_type) != "user" or str(row.account_id) != actor_id:
        return PromoteResult.NOT_USER_OWNED, None
    if not await _is_workspace_member(session, user_id=actor_id, workspace_id=target_workspace_id):
        return PromoteResult.NOT_MEMBER, None

    before: dict[str, object] = {
        "account_id": str(row.account_id),
        "account_type": str(row.account_type),
        "scope": str(row.scope),
        "confidence_score": float(row.confidence_score),
    }
    new_conf = confidence_score if confidence_score is not None else float(row.confidence_score)
    upd = await session.execute(
        text(
            "update public.knowledge_nodes set "
            "account_id = cast(:w as uuid), "
            "account_type = 'workspace', "
            "scope = 'common', "
            "owner_employee_id = null, "
            "approved_by_user_id = cast(:a as uuid), "
            "confidence_score = :cs, "
            "updated_at = now() "
            "where id = cast(:i as uuid) and deleted_at is null returning id"
        ),
        {"w": target_workspace_id, "a": actor_id, "cs": new_conf, "i": knowledge_id},
    )
    if upd.scalar_one_or_none() is None:
        return PromoteResult.NOT_FOUND, None

    await AuditWriter(session).write(
        AuditEvent(
            action="knowledge.promote",
            target_type="knowledge_node",
            actor_type="user",
            actor_id=actor_id,
            target_id=knowledge_id,
            before=before,
            after={
                "account_id": target_workspace_id,
                "account_type": "workspace",
                "scope": "common",
                "approved_by_user_id": actor_id,
                "confidence_score": new_conf,
            },
        )
    )
    promoted = await get_knowledge(session, knowledge_id)
    return PromoteResult.SUCCESS, promoted


async def extract_patterns(
    session: AsyncSession,
    *,
    account_id: str | None,
    category: str | None,
    min_occurrences: int,
    limit: int,
) -> KnowledgePatternResponse:
    """共通 tag 集合の凝集で「パターン」を抽出する read-only API。

    RLS で見える knowledge_nodes 全体を対象に、tags が共通する組合せを
    パターンとして集計する。simple な実装として:
      1. 各 knowledge の tags を昇順 sorted tuple として正規化
      2. ↑ をキーに groupby、occurrence_count を計算
      3. min_occurrences を満たすものだけを返す
      4. occurrence_count 降順 → 上位 limit

    各パターンの representative_ids は confidence_score 降順で最大 5 件。
    """
    where = ["deleted_at is null", "tags is not null", "cardinality(tags) > 0"]
    params: dict[str, object] = {}
    if account_id is not None:
        where.append("account_id = cast(:aid as uuid)")
        params["aid"] = account_id
    if category is not None:
        where.append("category = :cat")
        params["cat"] = category

    res = await session.execute(
        text(
            "select id, tags, confidence_score from public.knowledge_nodes "
            f"where {' and '.join(where)}"
        ),
        params,
    )

    # クラスタリング: 正規化 tags tuple → list of (id, confidence)
    buckets: dict[tuple[str, ...], list[tuple[str, float]]] = {}
    for r in res.all():
        raw_tags: list[object] = list(r.tags) if r.tags is not None else []
        tags_list = [str(t) for t in raw_tags]
        if not tags_list:
            continue
        key = tuple(sorted(tags_list))
        buckets.setdefault(key, []).append((str(r.id), float(r.confidence_score)))

    patterns: list[KnowledgePattern] = []
    for key, items in buckets.items():
        if len(items) < min_occurrences:
            continue
        # 代表 id: confidence 降順、tie は id 文字列順
        items.sort(key=lambda x: (-x[1], x[0]))
        rep_ids = [iid for iid, _ in items[:5]]
        avg = sum(c for _, c in items) / len(items)
        patterns.append(
            KnowledgePattern(
                pattern_tags=list(key),
                occurrence_count=len(items),
                representative_ids=rep_ids,
                avg_confidence=avg,
            )
        )

    patterns.sort(key=lambda p: (-p.occurrence_count, -p.avg_confidence, p.pattern_tags))
    return KnowledgePatternResponse(total=len(patterns), patterns=patterns[:limit])
