"""成果物 (workflow_outputs) ルータ (T-A-21 / GAP-023)。

/outputs[/{id}]。認証 (401) + RLS (T-D-21) + 404。read が中心。
書込は「編集 = ドキュメント AI (スティーブ) への修正依頼」(revise) と
コメント起点の AI 修正提案 (fix-proposal) の承認/却下のみ。
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.outputs import (
    FixProposalApproveResponse,
    FixProposalResponse,
    OutputAnchorResponse,
    OutputResponse,
    OutputReviseRequest,
)
from src.schemas.storage import ContentUrlResponse
from src.services import outputs as svc
from src.services.outputs import fix_proposals as fix_svc
from src.services.outputs import revise as revise_svc
from src.storage_signing import StorageSigningError, create_signed_download_url

router = APIRouter(tags=["outputs"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/outputs", summary="成果物一覧")
async def list_outputs(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
    phase_id: Annotated[str | None, Query()] = None,
    stage: Annotated[str | None, Query()] = None,
) -> dict[str, list[OutputResponse]]:
    return {
        "data": await svc.list_outputs(
            session, project_id=project_id, phase_id=phase_id, stage=stage
        )
    }


@router.get("/outputs/{output_id}", summary="成果物取得")
async def get_output(
    output_id: str, session: SessionDep, _user: UserDep
) -> dict[str, OutputResponse]:
    out = await svc.get_output(session, output_id)
    if out is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    return {"data": out}


@router.get(
    "/outputs/{output_id}/content-url",
    summary="成果物の署名付き閲覧 URL (format=html/json/md)",
    responses={503: {"description": "storage backend が未設定"}},
)
async def get_output_content_url(
    output_id: str,
    session: SessionDep,
    _user: UserDep,
    format: Annotated[Literal["html", "json", "md"], Query()] = "html",
) -> dict[str, ContentUrlResponse]:
    """RLS で可視な output の format 別パスに対する署名付き閲覧 URL を返す。

    GAP-023: S-G01 の HTML/JSON/MD タブ + DL の実体。該当 format が未生成なら
    409 (存在しない版を偽装しない)。
    """
    out = await svc.get_output(session, output_id)
    if out is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    # T-A-58: 要求された format の属性だけを参照する。
    # 旧実装は 3 属性を eager に辞書化していたため、未要求 format の列が無い行
    # (部分投影のクエリ結果や実カラム形状に満たないオブジェクト) で AttributeError
    # になっていた。format は Literal で検証済みなので属性名は安全に組み立てられる。
    path: str | None = getattr(out, f"{format}_path", None)
    if path is None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"output has no rendered {format.upper()} yet"
        )
    try:
        url = await create_signed_download_url(path)
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    return {"data": ContentUrlResponse(url=url)}


@router.get("/outputs/{output_id}/versions", summary="成果物のバージョン履歴")
async def list_output_versions(
    output_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[OutputResponse]]:
    """同一チェーン (project + stage + phase) のバージョンを version 昇順で返す。"""
    versions = await svc.list_versions(session, output_id)
    if not versions:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    return {"data": versions}


@router.get(
    "/outputs/{output_id}/anchors",
    summary="成果物 HTML 内の id 付き要素 (コメント対象位置の候補)",
    responses={503: {"description": "storage backend が未設定"}},
)
async def list_output_anchors(
    output_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[OutputAnchorResponse]]:
    """実 HTML を取得して id 属性を抽出する — 推測の位置候補は返さない。"""
    out = await svc.get_output(session, output_id)
    if out is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    if out.html_path is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "output has no rendered HTML yet")
    try:
        html = await revise_svc.download_html(out.html_path)
    except revise_svc.OutputReviseError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    return {"data": revise_svc.extract_anchors(html)}


def _raise_revise_error(exc: revise_svc.OutputReviseError) -> None:
    if exc.code == "llm_unconfigured":
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
    if exc.code == "too_large":
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, exc.message) from exc
    if exc.code == "no_html":
        raise HTTPException(status.HTTP_409_CONFLICT, exc.message) from exc
    raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc


@router.post(
    "/outputs/{output_id}/revise",
    status_code=status.HTTP_201_CREATED,
    summary="編集 = ドキュメント AI (スティーブ) への修正依頼 → 新バージョン生成 (GAP-023)",
    responses={503: {"description": "LLM または storage が未設定"}},
)
async def revise_output(
    output_id: str, body: OutputReviseRequest, session: SessionDep, user: UserDep
) -> dict[str, OutputResponse]:
    try:
        created = await revise_svc.revise_output(
            session, actor_id=user.id, output_id=output_id, instruction=body.instruction
        )
    except revise_svc.OutputReviseError as exc:
        _raise_revise_error(exc)
        raise  # unreachable — 型のため
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    return {"data": created}


@router.get("/outputs/{output_id}/fix-proposals", summary="AI 修正提案一覧 (GAP-023)")
async def list_output_fix_proposals(
    output_id: str, session: SessionDep, _user: UserDep
) -> dict[str, list[FixProposalResponse]]:
    if await svc.get_output(session, output_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "output not found")
    return {"data": await fix_svc.list_for_output(session, output_id)}


@router.post(
    "/comments/{comment_id}/fix-proposal",
    status_code=status.HTTP_201_CREATED,
    summary="コメントへの AI (スティーブ) 修正提案を生成 (GAP-023)",
    responses={503: {"description": "LLM または storage が未設定"}},
)
async def create_fix_proposal(
    comment_id: str, session: SessionDep, user: UserDep
) -> dict[str, FixProposalResponse]:
    try:
        created = await fix_svc.propose(session, actor_id=user.id, comment_id=comment_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except revise_svc.OutputReviseError as exc:
        _raise_revise_error(exc)
        raise
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    if created is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "comment not found or not a workflow_output comment"
        )
    return {"data": created}


@router.post(
    "/output-fix-proposals/{proposal_id}/approve",
    summary="AI 修正提案を承認 → 提案を適用した新バージョンを生成 (GAP-023)",
    responses={503: {"description": "LLM または storage が未設定"}},
)
async def approve_fix_proposal(
    proposal_id: str, session: SessionDep, user: UserDep
) -> dict[str, FixProposalApproveResponse]:
    try:
        result = await fix_svc.approve(session, actor_id=user.id, proposal_id=proposal_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except revise_svc.OutputReviseError as exc:
        _raise_revise_error(exc)
        raise
    except StorageSigningError as exc:
        if exc.code == "storage_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "fix proposal not found")
    proposal, new_output = result
    return {"data": FixProposalApproveResponse(proposal=proposal, new_output=new_output)}


@router.post(
    "/output-fix-proposals/{proposal_id}/reject",
    summary="AI 修正提案を却下 (文書は不変) (GAP-023)",
)
async def reject_fix_proposal(
    proposal_id: str, session: SessionDep, user: UserDep
) -> dict[str, FixProposalResponse]:
    try:
        rejected = await fix_svc.reject(session, actor_id=user.id, proposal_id=proposal_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    if rejected is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "fix proposal not found")
    return {"data": rejected}
