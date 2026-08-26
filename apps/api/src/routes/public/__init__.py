"""公開ページ (public) ルータ (T-A-44)。

法令 4 ページ (S-PUB01-03 + index) は未認証 (anon ロール session) で公開閲覧。
データ削除請求 (S-PUB04 / F-LEGAL-002) は本人 (authenticated) のみで、未認証は 401。
状態変更 (削除請求) は audit_logs に記録する。
"""

from __future__ import annotations

import os
from collections.abc import AsyncGenerator
from functools import lru_cache
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from src.db.session import create_engine, create_session_factory
from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.public import (
    BridgeLatestResponse,
    ConsentAcceptRequest,
    ConsentStatusListResponse,
    ConsentStatusResponse,
    DataDeletionRequestCreate,
    DataDeletionRequestResponse,
    LegalDocType,
    LegalDocumentResponse,
)
from src.services import consents as consent_svc
from src.services import public as svc
from src.user_messages import user_detail

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
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の法務文書が見つかりません。")
    return {"data": doc}


@router.get("/me/consents", summary="同意状況（GAP-206 — 再同意が要るか）")
async def get_my_consents(
    session: RlsSessionDep,
    user: UserDep,
) -> dict[str, ConsentStatusListResponse]:
    """自分の同意状況を返す。

    **これが無かったせいで**、規約を新しくしても「誰が旧版のままか」が
    分からず、再同意を求めようがなかった (GAP-188/204 で足した条項が
    旧版に同意したままの利用者には効きにくい状態だった)。
    """
    rows = await consent_svc.consent_status(session, user_id=user.id)
    items = [
        ConsentStatusResponse(
            doc_type=r.doc_type,
            current_version=r.current_version,
            accepted_version=r.accepted_version,
            needs_consent=r.needs_consent,
        )
        for r in rows
    ]
    return {
        "data": ConsentStatusListResponse(
            items=items, needs_consent=any(i.needs_consent for i in items)
        )
    }


@router.post("/me/consents", summary="現行版へ同意する（GAP-206）")
async def accept_my_consent(
    body: ConsentAcceptRequest,
    session: RlsSessionDep,
    user: UserDep,
    request: Request,
) -> dict[str, ConsentStatusResponse]:
    """現行版への同意を記録する。**旧版の記録は消さない**（append-only）。

    表示中の版が古い場合は 409 で拒否する — 読んでいない文面に同意させない。
    """
    try:
        status_row = await consent_svc.accept_current(
            session,
            user_id=user.id,
            doc_type=body.doc_type,
            version=body.version,
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    except consent_svc.ConsentError as exc:
        if exc.code == "version_mismatch":
            raise HTTPException(status.HTTP_409_CONFLICT, user_detail(exc)) from exc
        raise HTTPException(status.HTTP_400_BAD_REQUEST, user_detail(exc)) from exc
    return {
        "data": ConsentStatusResponse(
            doc_type=status_row.doc_type,
            current_version=status_row.current_version,
            accepted_version=status_row.accepted_version,
            needs_consent=status_row.needs_consent,
        )
    }


@router.get("/public/bridge-latest", summary="Bridge 最新版情報（公開）")
async def get_bridge_latest() -> dict[str, BridgeLatestResponse]:
    """GAP-135: Bridge の更新チェック用フィード。

    DB は使わず deploy 時の環境変数で配信する (リリース = env 更新のみ):
      ATELIER_BRIDGE_LATEST_VERSION      最新版 (未設定なら 0.1.0 = 更新なし)
      ATELIER_BRIDGE_DOWNLOAD_URL_MAC    .dmg の URL
      ATELIER_BRIDGE_DOWNLOAD_URL_WIN    installer .exe の URL
      ATELIER_BRIDGE_DOWNLOAD_URL_LINUX  AppImage の URL
    """
    version = os.environ.get("ATELIER_BRIDGE_LATEST_VERSION", "").strip() or "0.1.0"
    download_urls: dict[str, str] = {}
    for key, env_key in (
        ("mac", "ATELIER_BRIDGE_DOWNLOAD_URL_MAC"),
        ("win", "ATELIER_BRIDGE_DOWNLOAD_URL_WIN"),
        ("linux", "ATELIER_BRIDGE_DOWNLOAD_URL_LINUX"),
    ):
        value = os.environ.get(env_key, "").strip()
        if value != "":
            download_urls[key] = value
    return {"data": BridgeLatestResponse(version=version, download_urls=download_urls)}


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
