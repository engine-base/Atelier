"""運営ナレッジ管理 ルータ (T-A-50 / F-023) — 運営 admin 専用。

platform(運営デフォルト)ナレッジは RLS 上 service_role のみ書込可
(migration t-d-09_018_knowledge_platform_default.sql 設計)。本ルータは
is_admin gate (403) + service_role セッション (RLS バイパス) で
services.knowledge の CRUD を呼び、account_type=platform を強制する。
通常テナントの /knowledge (RLS) とは独立。
"""

from __future__ import annotations

from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.db.session import create_engine, create_session_factory
from src.dependencies import CurrentUser, get_current_user
from src.schemas.admin_knowledge import AdminKnowledgeCreate
from src.schemas.knowledge import KnowledgeCreate, KnowledgeResponse, KnowledgeUpdate
from src.services import admin as admin_svc
from src.services import knowledge as kn

router = APIRouter(tags=["admin-knowledge"])

UserDep = Annotated[CurrentUser, Depends(get_current_user)]

# account_type=platform 時はサービス層が account_id を sentinel に上書きするため、
# ここで渡す値は非NULL要件を満たすだけのプレースホルダ。
_PLATFORM_ACCOUNT_PLACEHOLDER = "00000000-0000-0000-0000-000000000000"


@lru_cache(maxsize=1)
def _service_session_factory() -> async_sessionmaker[AsyncSession]:
    """service_role 相当の sessionmaker。RLS バイパス用 (role を下げない)。"""
    return create_session_factory(create_engine())


def _require_admin(user: CurrentUser) -> None:
    if not admin_svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")


@router.get("/admin/knowledge", summary="運営 admin: 運営デフォルトナレッジ一覧（全件）")
async def list_platform_knowledge(
    user: UserDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, list[KnowledgeResponse]]:
    _require_admin(user)
    async with _service_session_factory()() as session:
        items = await kn.list_knowledge(session, account_type="platform", limit=limit)
    return {"data": items}


@router.post(
    "/admin/knowledge",
    status_code=status.HTTP_201_CREATED,
    summary="運営 admin: 運営デフォルトナレッジ作成",
)
async def create_platform_knowledge(
    body: AdminKnowledgeCreate, user: UserDep
) -> dict[str, KnowledgeResponse]:
    _require_admin(user)
    data = KnowledgeCreate(
        account_id=_PLATFORM_ACCOUNT_PLACEHOLDER,
        account_type="platform",
        scope="common",
        category=body.category,
        title=body.title,
        content_md=body.content_md,
        tags=body.tags,
        parent_id=body.parent_id,
        visible_in_tree=body.visible_in_tree,
        confidence_score=body.confidence_score,
    )
    async with _service_session_factory()() as session:
        created = await kn.create_knowledge(session, actor_id=user.id, data=data)
        await session.commit()
    if created is None:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "failed to create platform knowledge"
        )
    return {"data": created}


async def _get_platform_or_404(session: AsyncSession, knowledge_id: str) -> KnowledgeResponse:
    existing = await kn.get_knowledge(session, knowledge_id)
    if existing is None or existing.account_type != "platform":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "platform knowledge not found")
    return existing


@router.patch("/admin/knowledge/{knowledge_id}", summary="運営 admin: 運営ナレッジ編集")
async def update_platform_knowledge(
    knowledge_id: str, body: KnowledgeUpdate, user: UserDep
) -> dict[str, KnowledgeResponse]:
    _require_admin(user)
    async with _service_session_factory()() as session:
        await _get_platform_or_404(session, knowledge_id)
        updated = await kn.update_knowledge(
            session, actor_id=user.id, knowledge_id=knowledge_id, data=body
        )
        await session.commit()
    if updated is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "platform knowledge not found")
    return {"data": updated}


@router.delete(
    "/admin/knowledge/{knowledge_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="運営 admin: 運営ナレッジ削除",
)
async def delete_platform_knowledge(knowledge_id: str, user: UserDep) -> None:
    _require_admin(user)
    async with _service_session_factory()() as session:
        await _get_platform_or_404(session, knowledge_id)
        ok = await kn.delete_knowledge(session, actor_id=user.id, knowledge_id=knowledge_id)
        await session.commit()
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "platform knowledge not found")
