"""ナレッジ (knowledge_nodes) ルータ (T-A-36)。

S-K01 ナレッジベース画面用。E-018 knowledge_nodes (polymorphic account)
の CRUD + semantic 検索 (Voyage AI embedding + pgvector cosine)。
認証 (401) + RLS (T-D-18, R-T08 致命級) + 404/403。

R-T08: workspace A の user が workspace B の knowledge を query しても
RLS で 0 rows (cross-workspace skip) を必ず実 PostgREST + JWT で検証。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.rate_limit import rate_limit_user
from src.schemas.knowledge import (
    KnowledgeAccountType,
    KnowledgeCreate,
    KnowledgePatternRequest,
    KnowledgePatternResponse,
    KnowledgePromoteRequest,
    KnowledgeResponse,
    KnowledgeScope,
    KnowledgeSearchResponse,
    KnowledgeUpdate,
)
from src.services import knowledge as svc

router = APIRouter(tags=["knowledge"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/knowledge", summary="ナレッジ一覧")
async def list_knowledge(
    session: SessionDep,
    _user: UserDep,
    account_id: Annotated[str | None, Query()] = None,
    account_type: Annotated[KnowledgeAccountType | None, Query()] = None,
    scope: Annotated[KnowledgeScope | None, Query()] = None,
    source_project_id: Annotated[str | None, Query()] = None,
    parent_id: Annotated[str | None, Query()] = None,
    tree_only: Annotated[bool, Query()] = False,
    category: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, list[KnowledgeResponse]]:
    return {
        "data": await svc.list_knowledge(
            session,
            account_id=account_id,
            account_type=account_type,
            scope=scope,
            source_project_id=source_project_id,
            parent_id=parent_id,
            tree_only=tree_only,
            category=category,
            limit=limit,
        )
    }


@router.post("/knowledge", status_code=status.HTTP_201_CREATED, summary="ナレッジ作成")
async def create_knowledge(
    body: KnowledgeCreate, session: SessionDep, user: UserDep
) -> dict[str, KnowledgeResponse]:
    if body.scope == "employee_specific" and body.owner_employee_id is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "scope=employee_specific requires owner_employee_id",
        )
    if body.scope == "common" and body.owner_employee_id is not None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "scope=common must not set owner_employee_id",
        )
    created = await svc.create_knowledge(session, actor_id=user.id, data=body)
    if created is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to create knowledge")
    return {"data": created}


@router.post(
    "/knowledge/search",
    summary="ナレッジ semantic 検索 (Voyage embedding + cosine)",
    dependencies=[Depends(rate_limit_user(60))],  # x-rate-limit: 60/min/user
)
async def search_knowledge(
    body: dict[str, object],
    session: SessionDep,
    _user: UserDep,
) -> dict[str, KnowledgeSearchResponse]:
    query = body.get("query")
    if not isinstance(query, str) or not query.strip():
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "query (non-empty string) required"
        )
    limit_raw = body.get("limit", 10)
    if not isinstance(limit_raw, int) or limit_raw < 1 or limit_raw > 50:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "limit must be int in [1, 50]")
    account_id = body.get("account_id")
    account_id_str: str | None = account_id if isinstance(account_id, str) else None
    result = await svc.search_knowledge(
        session, query=query, limit=limit_raw, account_id=account_id_str
    )
    return {"data": result}


@router.get("/knowledge/{knowledge_id}", summary="ナレッジ取得")
async def get_knowledge(
    knowledge_id: str, session: SessionDep, _user: UserDep
) -> dict[str, KnowledgeResponse]:
    k = await svc.get_knowledge(session, knowledge_id)
    if k is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "knowledge not found")
    return {"data": k}


@router.patch("/knowledge/{knowledge_id}", summary="ナレッジ更新")
async def update_knowledge(
    knowledge_id: str,
    body: KnowledgeUpdate,
    session: SessionDep,
    user: UserDep,
) -> dict[str, KnowledgeResponse]:
    if await svc.get_knowledge(session, knowledge_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "knowledge not found")
    updated = await svc.update_knowledge(
        session, actor_id=user.id, knowledge_id=knowledge_id, data=body
    )
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update knowledge")
    return {"data": updated}


@router.delete(
    "/knowledge/{knowledge_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="ナレッジ削除（論理）",
)
async def delete_knowledge(knowledge_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_knowledge(session, knowledge_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "knowledge not found")
    if not await svc.delete_knowledge(session, actor_id=user.id, knowledge_id=knowledge_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to delete knowledge")


# --------------------------------------------------------------------------- #
# T-A-37: ナレッジ昇格 + 横断パターン抽出
# --------------------------------------------------------------------------- #
@router.post(
    "/knowledge/{knowledge_id}/promote",
    summary="ナレッジ昇格（user → workspace common）",
)
async def promote_knowledge(
    knowledge_id: str,
    body: KnowledgePromoteRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, KnowledgeResponse]:
    code, promoted = await svc.promote_knowledge(
        session,
        actor_id=user.id,
        knowledge_id=knowledge_id,
        target_workspace_id=body.target_workspace_id,
        confidence_score=body.confidence_score,
    )
    if code == svc.PromoteResult.NOT_FOUND:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "knowledge not found")
    if code == svc.PromoteResult.NOT_USER_OWNED:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "only your own user-scope knowledge can be promoted",
        )
    if code == svc.PromoteResult.EMPLOYEE_SPECIFIC:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "scope=employee_specific cannot be promoted to common",
        )
    if code == svc.PromoteResult.NOT_MEMBER:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "you must be a member of the target workspace to promote",
        )
    assert promoted is not None
    return {"data": promoted}


@router.post(
    "/knowledge/patterns/extract",
    summary="横断パターン抽出（共通タグ集合の凝集 / read-only）",
)
async def extract_patterns(
    body: KnowledgePatternRequest,
    session: SessionDep,
    _user: UserDep,
) -> dict[str, KnowledgePatternResponse]:
    return {
        "data": await svc.extract_patterns(
            session,
            account_id=body.account_id,
            category=body.category,
            min_occurrences=body.min_occurrences,
            limit=body.limit,
        )
    }
