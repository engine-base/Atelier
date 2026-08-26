"""運営ナレッジ管理 ルータ (T-A-50 / F-023) — 運営 admin 専用。

platform(運営デフォルト)ナレッジは RLS 上 service_role のみ書込可
(migration t-d-09_018_knowledge_platform_default.sql 設計)。本ルータは
is_admin gate (403) + service_role セッション (RLS バイパス) で
services.knowledge の CRUD を呼び、account_type=platform を強制する。
通常テナントの /knowledge (RLS) とは独立。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.db.session import shared_session_factory
from src.dependencies import CurrentUser, get_current_user
from src.errors import service_unavailable
from src.schemas.admin_knowledge import AdminKnowledgeCreate
from src.schemas.knowledge import KnowledgeCreate, KnowledgeResponse, KnowledgeUpdate
from src.schemas.knowledge_curation import (
    CurationApproveResponse,
    CurationRunRequest,
    CurationRunStats,
    KnowledgeCurationResponse,
)
from src.services import admin as admin_svc
from src.services import knowledge as kn
from src.services.knowledge import curation as curation_svc

router = APIRouter(tags=["admin-knowledge"])

UserDep = Annotated[CurrentUser, Depends(get_current_user)]

# account_type=platform 時はサービス層が account_id を sentinel に上書きするため、
# ここで渡す値は非NULL要件を満たすだけのプレースホルダ。
_PLATFORM_ACCOUNT_PLACEHOLDER = "00000000-0000-0000-0000-000000000000"


def _service_session_factory() -> async_sessionmaker[AsyncSession]:
    """GAP-197: engine はプロセスに 1 つ。

    以前は event loop ごとに engine を作ってキャッシュしていたが、engine を
    共有にしたのでこの層は不要になった (loop id は再利用されうるので、
    残しておくと死んだ engine を掴み続ける危険がある)。
    """
    return shared_session_factory()


def _require_admin(user: CurrentUser) -> None:
    if not admin_svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")


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
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "運営ナレッジを作成できませんでした。時間をおいて、もう一度お試しください。",
        )
    return {"data": created}


async def _get_platform_or_404(session: AsyncSession, knowledge_id: str) -> KnowledgeResponse:
    existing = await kn.get_knowledge(session, knowledge_id)
    if existing is None or existing.account_type != "platform":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の運営ナレッジが見つかりません。")
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
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の運営ナレッジが見つかりません。")
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
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の運営ナレッジが見つかりません。")


# ── GAP-153: ナレッジ自動キュレーション (運営 AI 裏走 + 匿名化 + 承認ゲート) ──


def _raise_curation(exc: curation_svc.CurationError) -> None:
    if exc.code == "llm_unconfigured":
        raise service_unavailable(exc.code, exc.message) from exc
    if exc.code == "not_found":
        raise HTTPException(status.HTTP_404_NOT_FOUND, exc.message) from exc
    if exc.code in ("not_pending", "security"):
        raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
    raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc


@router.post(
    "/admin/knowledge/curation/run",
    summary="運営 admin: キュレーションバッチ実行 (GAP-153 — 全テナント走査 + 匿名化)",
    responses={503: {"description": "運営側 LLM (ANTHROPIC_API_KEY) 未設定"}},
)
async def run_knowledge_curation(
    body: CurationRunRequest, user: UserDep
) -> dict[str, CurationRunStats]:
    _require_admin(user)
    async with _service_session_factory()() as session:
        try:
            stats = await curation_svc.run_curation(session, actor_id=user.id, limit=body.limit)
        except curation_svc.CurationError as exc:
            _raise_curation(exc)
            raise  # unreachable — 型のため
        await session.commit()
    return {"data": stats}


@router.get(
    "/admin/knowledge/curation",
    summary="運営 admin: キュレーション提案一覧 (GAP-153)",
)
async def list_knowledge_curations(
    user: UserDep,
    status_filter: Annotated[str | None, Query(alias="status")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, list[KnowledgeCurationResponse]]:
    _require_admin(user)
    async with _service_session_factory()() as session:
        items = await curation_svc.list_curations(session, status=status_filter, limit=limit)
    return {"data": items}


@router.post(
    "/admin/knowledge/curation/{curation_id}/approve",
    summary="運営 admin: 提案を承認 → platform ナレッジとして全アカウント共有 (GAP-153)",
    responses={409: {"description": "処理済み / 公開直前リークスキャンで検出"}},
)
async def approve_knowledge_curation(
    curation_id: str, user: UserDep
) -> dict[str, CurationApproveResponse]:
    _require_admin(user)
    async with _service_session_factory()() as session:
        try:
            cur, published = await curation_svc.approve_curation(
                session, actor_id=user.id, curation_id=curation_id
            )
        except curation_svc.CurationError as exc:
            await session.commit()  # security 再判定の rejected_security は記録を残す
            _raise_curation(exc)
            raise
        await session.commit()
    return {"data": CurationApproveResponse(curation=cur, published=published)}


@router.post(
    "/admin/knowledge/curation/{curation_id}/reject",
    summary="運営 admin: 提案を却下 (GAP-153 — 公開しない)",
)
async def reject_knowledge_curation(
    curation_id: str, user: UserDep
) -> dict[str, KnowledgeCurationResponse]:
    _require_admin(user)
    async with _service_session_factory()() as session:
        try:
            rejected = await curation_svc.reject_curation(
                session, actor_id=user.id, curation_id=curation_id
            )
        except curation_svc.CurationError as exc:
            _raise_curation(exc)
            raise
        await session.commit()
    return {"data": rejected}
