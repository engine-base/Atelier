"""商談ドキュメント (sales_docs) ルータ (T-A-39)。

S-N01 提案 / 見積 ドラフト管理。E-006 workflow_outputs を stage in
(proposal, estimate) でフィルタする。認証 (401) + RLS (T-D-21) + 404/403。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.sales_docs import (
    SalesDocCreate,
    SalesDocResponse,
    SalesDocType,
    SalesDocUpdate,
)
from src.services import sales_docs as svc

router = APIRouter(tags=["sales-docs"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/sales-docs", summary="商談ドキュメント一覧（提案/見積）")
async def list_sales_docs(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
    doc_type: Annotated[SalesDocType | None, Query()] = None,
) -> dict[str, list[SalesDocResponse]]:
    return {"data": await svc.list_sales_docs(session, project_id=project_id, doc_type=doc_type)}


@router.post("/sales-docs", status_code=status.HTTP_201_CREATED, summary="商談ドキュメント作成")
async def create_sales_doc(
    body: SalesDocCreate, session: SessionDep, user: UserDep
) -> dict[str, SalesDocResponse]:
    created = await svc.create_sales_doc(session, actor_id=user.id, data=body)
    if created is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to create sales doc")
    return {"data": created}


@router.get("/sales-docs/{doc_id}", summary="商談ドキュメント取得")
async def get_sales_doc(
    doc_id: str, session: SessionDep, _user: UserDep
) -> dict[str, SalesDocResponse]:
    doc = await svc.get_sales_doc(session, doc_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "sales doc not found")
    return {"data": doc}


@router.patch("/sales-docs/{doc_id}", summary="商談ドキュメント更新")
async def update_sales_doc(
    doc_id: str, body: SalesDocUpdate, session: SessionDep, user: UserDep
) -> dict[str, SalesDocResponse]:
    if await svc.get_sales_doc(session, doc_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "sales doc not found")
    updated = await svc.update_sales_doc(session, actor_id=user.id, doc_id=doc_id, data=body)
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update sales doc")
    return {"data": updated}


@router.delete(
    "/sales-docs/{doc_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="商談ドキュメント削除（論理）",
)
async def delete_sales_doc(doc_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_sales_doc(session, doc_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "sales doc not found")
    if not await svc.delete_sales_doc(session, actor_id=user.id, doc_id=doc_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to delete sales doc")
