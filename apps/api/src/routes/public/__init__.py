"""公開ページ (public) ルータ (T-A-44)。

法令 4 ページ (S-PUB01-03 + index) は未認証 (anon ロール session) で公開閲覧。
データ削除請求 (S-PUB04 / F-LEGAL-002) は本人 (authenticated) のみで、未認証は 401。
状態変更 (削除請求) は audit_logs に記録する。
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from src.db.session import create_engine, create_session_factory
from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.public import (
    DataDeletionRequestCreate,
    DataDeletionRequestResponse,
    LegalDocType,
    LegalDocumentResponse,
)
from src.services import public as svc

router = APIRouter(tags=["public"])


@lru_cache(maxsize=1)
def _public_engine() -> AsyncEngine:
    return create_engine()


@lru_cache(maxsize=1)
def _public_session_factory() -> async_sessionmaker[AsyncSession]:
    return create_session_factory(_public_engine())


async def get_public_session() -> AsyncGenerator[AsyncSession, None]:
    """未認証公開エンドポイント用の anon ロール session。

    JWT は不要。接続単位で role=anon に下げ、RLS (public_read 等) が anon として
    評価されるようにする。読み取り専用想定だが対称性のため commit/rollback する。
    """
    factory = _public_session_factory()
    async with factory() as session:
        await session.execute(text("set local role anon"))
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
        else:
            await session.commit()


PublicSessionDep = Annotated[AsyncSession, Depends(get_public_session)]
RlsSessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/public/legal-documents", summary="法令ページ一覧（公開）")
async def list_legal_documents(
    session: PublicSessionDep,
    locale: Annotated[str | None, Query()] = None,
) -> dict[str, list[LegalDocumentResponse]]:
    return {"data": await svc.list_legal_documents(session, locale=locale)}


@router.get("/public/legal-documents/{doc_type}", summary="法令ページ取得（公開）")
async def get_legal_document(
    doc_type: LegalDocType,
    session: PublicSessionDep,
    locale: Annotated[str, Query()] = "ja",
) -> dict[str, LegalDocumentResponse]:
    doc = await svc.get_legal_document(session, doc_type=doc_type, locale=locale)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "legal document not found")
    return {"data": doc}


@router.post(
    "/public/data-deletion-requests",
    status_code=status.HTTP_201_CREATED,
    summary="データ削除請求（本人）",
)
async def create_data_deletion_request(
    body: DataDeletionRequestCreate, session: RlsSessionDep, user: UserDep
) -> dict[str, DataDeletionRequestResponse]:
    created = await svc.create_data_deletion_request(session, actor_id=user.id, data=body)
    return {"data": created}
