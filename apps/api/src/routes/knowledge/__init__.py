"""ナレッジ (knowledge_nodes) ルータ (T-A-36)。

S-K01 ナレッジベース画面用。E-018 knowledge_nodes (polymorphic account)
の CRUD + semantic 検索 (Voyage AI embedding + pgvector cosine)。
認証 (401) + RLS (T-D-18, R-T08 致命級) + 404/403。

R-T08: workspace A の user が workspace B の knowledge を query しても
RLS で 0 rows (cross-workspace skip) を必ず実 PostgREST + JWT で検証。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.rate_limit import rate_limit_user
from src.schemas.knowledge import (
    EmbeddingStatusResponse,
    KnowledgeAccountType,
    KnowledgeCandidateApproveRequest,
    KnowledgeCandidateResponse,
    KnowledgeCreate,
    KnowledgeGraphResponse,
    KnowledgePatternRequest,
    KnowledgePatternResponse,
    KnowledgePromoteRequest,
    KnowledgeReferencesResponse,
    KnowledgeResponse,
    KnowledgeScope,
    KnowledgeSearchResponse,
    KnowledgeUpdate,
)
from src.services import knowledge as svc

router = APIRouter(tags=["knowledge"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get(
    "/embedding-status",
    summary="意味検索 (埋め込み) の状態 (GAP-180 — 何で動いていて誰の費用か)",
)
async def get_embedding_status(
    session: SessionDep, _user: UserDep
) -> dict[str, EmbeddingStatusResponse]:
    """意味検索が使えるか / 準備中か / なぜ使えないか を返す。

    使えないときに黙ってキーワード検索へ落ちると、利用者には「精度が落ちた」
    ようにしか見えない。理由と復旧手順を画面に出すための API。
    """
    return {"data": await svc.embedding_status(session)}


@router.post(
    "/embedding-status/prepare",
    summary="意味検索の準備を開始 / 再試行 (GAP-180)",
)
async def post_embedding_prepare(
    session: SessionDep, _user: UserDep
) -> dict[str, EmbeddingStatusResponse]:
    """モデルの読み込みと未埋め込み分の補完を開始する (冪等)。

    完了までは時間がかかるため、ここでは開始した直後の状態を返す。
    """
    return {"data": await svc.prepare_embeddings(session)}


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
            "特定の AI 社員だけのナレッジには、担当の AI 社員の指定が必要です。",
        )
    if body.scope == "common" and body.owner_employee_id is not None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "全体で使うナレッジには、担当の AI 社員を指定できません。",
        )
    created = await svc.create_knowledge(session, actor_id=user.id, data=body)
    if created is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "ナレッジを作る権限がありません。")
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
            status.HTTP_422_UNPROCESSABLE_CONTENT, "検索する言葉を入力してください。"
        )
    limit_raw = body.get("limit", 10)
    if not isinstance(limit_raw, int) or limit_raw < 1 or limit_raw > 50:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "件数は 1〜50 の整数で指定してください。"
        )
    account_id = body.get("account_id")
    account_id_str: str | None = account_id if isinstance(account_id, str) else None
    # GAP-017: project_id 指定でプロジェクト設定 (跨ぎ参照) を適用
    project_id = body.get("project_id")
    project_id_str: str | None = project_id if isinstance(project_id, str) else None
    result = await svc.search_knowledge(
        session,
        query=query,
        limit=limit_raw,
        account_id=account_id_str,
        project_id=project_id_str,
    )
    return {"data": result}


# NOTE: /knowledge/{knowledge_id} より前に登録 (path 捕捉回避 — GAP-011)
@router.get(
    "/knowledge/vault-export",
    summary="Obsidian Vault 書出（Markdown zip — RLS 可視分）",
)
async def export_knowledge_vault(
    session: SessionDep,
    _user: UserDep,
    account_id: Annotated[str, Query()],
) -> Response:
    payload, count = await svc.export_vault(session, account_id=account_id)
    return Response(
        content=payload,
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="atelier-vault.zip"',
            "X-Vault-Nodes": str(count),
        },
    )


# NOTE: /knowledge/{knowledge_id} より前に登録 (path 捕捉回避 — GAP-010)
@router.get("/knowledge/graph", summary="ナレッジグラフ（ナレッジ間リンク構造）")
async def get_knowledge_graph(
    session: SessionDep,
    _user: UserDep,
    account_id: Annotated[str, Query()],
) -> dict[str, KnowledgeGraphResponse]:
    return {"data": await svc.get_graph(session, account_id=account_id)}


# ── GAP-167: ナレッジ候補 (どれを入れるかは人が決める) ─────────────────


@router.get(
    "/knowledge/candidates",
    summary="AI が会話から拾ったナレッジ候補 (GAP-167 — 採用して初めてナレッジになる)",
)
async def list_knowledge_candidates(
    session: SessionDep,
    _user: UserDep,
    status_filter: Annotated[str, Query(alias="status")] = "pending",
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
) -> dict[str, list[KnowledgeCandidateResponse]]:
    from src.services.knowledge import auto_capture

    items = await auto_capture.list_candidates(session, status=status_filter, limit=limit)
    return {
        "data": [
            KnowledgeCandidateResponse(
                id=c.id,
                workspace_id=c.workspace_id,
                project_id=c.project_id,
                title=c.title,
                content_md=c.content_md,
                category=c.category,
                tags=c.tags,
                status=c.status,
                created_at=c.created_at,
            )
            for c in items
        ]
    }


@router.post(
    "/knowledge/candidates/{candidate_id}/approve",
    status_code=status.HTTP_201_CREATED,
    summary="候補を採用してナレッジにする (GAP-167 — 編集して採用も可)",
)
async def approve_knowledge_candidate(
    candidate_id: str,
    body: KnowledgeCandidateApproveRequest,
    session: SessionDep,
    user: UserDep,
) -> dict[str, dict[str, str]]:
    from src.services.knowledge import auto_capture

    try:
        knowledge_id = await auto_capture.approve_candidate(
            session,
            actor_id=user.id,
            candidate_id=candidate_id,
            title=body.title,
            content_md=body.content_md,
            category=body.category,
            tags=body.tags,
        )
    except auto_capture.CandidateError as exc:
        code = status.HTTP_404_NOT_FOUND if exc.code == "not_found" else status.HTTP_409_CONFLICT
        raise HTTPException(code, exc.message) from exc
    return {"data": {"knowledge_id": knowledge_id}}


@router.post(
    "/knowledge/candidates/{candidate_id}/reject",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="候補を却下する (GAP-167 — 同じ題は再提案しない)",
)
async def reject_knowledge_candidate(
    candidate_id: str, session: SessionDep, user: UserDep
) -> Response:
    from src.services.knowledge import auto_capture

    try:
        await auto_capture.reject_candidate(session, actor_id=user.id, candidate_id=candidate_id)
    except auto_capture.CandidateError as exc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, exc.message) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/knowledge/{knowledge_id}", summary="ナレッジ取得")
async def get_knowledge(
    knowledge_id: str, session: SessionDep, _user: UserDep
) -> dict[str, KnowledgeResponse]:
    k = await svc.get_knowledge(session, knowledge_id)
    if k is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のナレッジが見つかりません。")
    return {"data": k}


@router.patch("/knowledge/{knowledge_id}", summary="ナレッジ更新")
async def update_knowledge(
    knowledge_id: str,
    body: KnowledgeUpdate,
    session: SessionDep,
    user: UserDep,
) -> dict[str, KnowledgeResponse]:
    if await svc.get_knowledge(session, knowledge_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のナレッジが見つかりません。")
    updated = await svc.update_knowledge(
        session, actor_id=user.id, knowledge_id=knowledge_id, data=body
    )
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "このナレッジを変更する権限がありません。")
    return {"data": updated}


@router.delete(
    "/knowledge/{knowledge_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="ナレッジ削除（論理）",
)
async def delete_knowledge(knowledge_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_knowledge(session, knowledge_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のナレッジが見つかりません。")
    if not await svc.delete_knowledge(session, actor_id=user.id, knowledge_id=knowledge_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "このナレッジを削除する権限がありません。")


# --------------------------------------------------------------------------- #
# GAP-012: バックリンク (参照元逆引き)
# --------------------------------------------------------------------------- #
@router.get(
    "/knowledge/{knowledge_id}/references",
    summary="ナレッジ参照元一覧（バックリンク）",
)
async def list_knowledge_references(
    knowledge_id: str,
    session: SessionDep,
    _user: UserDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, KnowledgeReferencesResponse]:
    if await svc.get_knowledge(session, knowledge_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のナレッジが見つかりません。")
    return {"data": await svc.list_references(session, knowledge_id=knowledge_id, limit=limit)}


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
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のナレッジが見つかりません。")
    if code == svc.PromoteResult.NOT_USER_OWNED:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "昇格できるのは、自分の個人ナレッジだけです。",
        )
    if code == svc.PromoteResult.EMPLOYEE_SPECIFIC:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "特定の AI 社員だけのナレッジは、全体用に昇格できません。",
        )
    if code == svc.PromoteResult.NOT_MEMBER:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "昇格先のワークスペースのメンバーである必要があります。",
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
