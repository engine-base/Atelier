"""商談ドキュメント (sales_docs) ルータ (T-A-39 / GAP-018)。

S-N01 提案 / 見積 / 業務委託契約 / NDA / 請求書 ドラフト管理。E-006
workflow_outputs を sales stage でフィルタする。認証 (401) + RLS + 404/403。
GAP-018: AI 生成 (トニー + ナレッジ RAG) / PDF 出力 / メール送信 + 送信履歴。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.sales_docs import (
    SalesDocCreate,
    SalesDocGenerateRequest,
    SalesDocResponse,
    SalesDocSendRequest,
    SalesDocSendResponse,
    SalesDocType,
    SalesDocUpdate,
)
from src.services import sales_docs as svc
from src.services.sales_docs import generate as gen_svc
from src.services.sales_docs import pdf as pdf_svc
from src.services.sales_docs import send as send_svc

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


# --------------------------------------------------------------------------- #
# GAP-018: AI 生成 (トニー) / PDF / メール送信 + 送信履歴
# --------------------------------------------------------------------------- #
@router.post(
    "/sales-docs/generate",
    status_code=status.HTTP_201_CREATED,
    summary="営業 AI (トニー) にドラフト生成を依頼 (ナレッジ RAG + 生成トレース — GAP-018)",
    responses={503: {"description": "LLM が未設定"}},
)
async def generate_sales_doc(
    body: SalesDocGenerateRequest, session: SessionDep, user: UserDep
) -> dict[str, SalesDocResponse]:
    try:
        created = await gen_svc.generate(session, actor_id=user.id, data=body)
    except gen_svc.SalesDocGenerateError as exc:
        # GAP-171: Bridge 未接続も 503 — 画面 (GAP-168) が接続フローを出す条件
        if exc.code in ("llm_unconfigured", "bridge_offline"):
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    return {"data": created}


@router.get(
    "/sales-docs/{doc_id}/pdf",
    summary="ドラフトの PDF 出力 (GAP-018)",
    response_class=Response,
)
async def sales_doc_pdf(doc_id: str, session: SessionDep, _user: UserDep) -> Response:
    doc = await svc.get_sales_doc(session, doc_id)
    if doc is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "sales doc not found")
    body = doc.summary or ""
    if not body.strip():
        raise HTTPException(status.HTTP_409_CONFLICT, "sales doc has no content")
    label = gen_svc.DOC_TYPE_LABEL.get(doc.doc_type, doc.doc_type)
    title = (body.splitlines()[0].lstrip("# ").strip() if body else "") or label
    created = doc.created_at.strftime("%Y-%m-%d")
    pdf_bytes = pdf_svc.render_pdf(
        title=title,
        meta_line=f"{label} · v{doc.version} · {created} 作成 · AI 補助ドラフト (人間レビュー前)",
        body=body,
    )
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="sales-doc-{doc.doc_type}-v{doc.version}.pdf"'
        },
    )


@router.post(
    "/sales-docs/{doc_id}/send",
    status_code=status.HTTP_201_CREATED,
    summary="ドラフトをクライアントへメール送信 (dry_run 明示 — GAP-018)",
)
async def send_sales_doc(
    doc_id: str, body: SalesDocSendRequest, session: SessionDep, user: UserDep
) -> dict[str, SalesDocSendResponse]:
    sent = await send_svc.send_doc(session, actor_id=user.id, doc_id=doc_id, data=body)
    if sent is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "sales doc not found")
    return {"data": sent}


@router.get("/sales-docs/{doc_id}/sends", summary="送信履歴 (GAP-018)")
async def list_sales_doc_sends(
    doc_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[SalesDocSendResponse]]:
    if await svc.get_sales_doc(session, doc_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "sales doc not found")
    return {"data": await send_svc.list_sends(session, doc_id)}
