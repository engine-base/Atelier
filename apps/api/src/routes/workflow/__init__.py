"""工程ワークフロー (phases) ルータ (T-A-20)。

/workflow/phases[/{id}]。認証 (401) + RLS (T-D-21) + 404/403。
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.workflow import (
    ConsistencyCheckResponse,
    ImpactAnalysisRequest,
    ImpactAnalysisResponse,
    ImpactApplyResponse,
    PhaseCreate,
    PhaseProposalApproveResponse,
    PhaseProposalCreate,
    PhaseProposalResponse,
    PhaseResponse,
    PhaseSeedRequest,
    PhaseTaskStatsResponse,
    PhaseUpdate,
)
from src.services import workflow as svc
from src.services.workflow import impact as impact_svc
from src.services.workflow import proposals as proposals_svc

router = APIRouter(tags=["workflow"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/workflow/phases", summary="工程一覧")
async def list_phases(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str | None, Query()] = None,
) -> dict[str, list[PhaseResponse]]:
    return {"data": await svc.list_phases(session, project_id=project_id)}


@router.post("/workflow/phases", status_code=status.HTTP_201_CREATED, summary="工程作成")
async def create_phase(
    body: PhaseCreate, session: SessionDep, user: UserDep
) -> dict[str, PhaseResponse]:
    return {"data": await svc.create_phase(session, actor_id=user.id, data=body)}


@router.post(
    "/workflow/phases/seed",
    status_code=status.HTTP_201_CREATED,
    summary="工程一括投入 (canonical 9)",
)
async def seed_phases(
    body: PhaseSeedRequest, session: SessionDep, user: UserDep
) -> dict[str, list[PhaseResponse]]:
    return {
        "data": await svc.seed_default_phases(session, actor_id=user.id, project_id=body.project_id)
    }


@router.get("/workflow/phases/{phase_id}", summary="工程詳細")
async def get_phase(phase_id: str, session: SessionDep, _user: UserDep) -> dict[str, PhaseResponse]:
    ph = await svc.get_phase(session, phase_id)
    if ph is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "phase not found")
    return {"data": ph}


@router.patch("/workflow/phases/{phase_id}", summary="工程遷移・更新")
async def update_phase(
    phase_id: str, body: PhaseUpdate, session: SessionDep, user: UserDep
) -> dict[str, PhaseResponse]:
    if await svc.get_phase(session, phase_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "phase not found")
    try:
        updated = await svc.update_phase(session, actor_id=user.id, phase_id=phase_id, data=body)
    except svc.WorkflowError as e:
        # GAP-004: 他 WS 社員の割当等は 422 (入力不正)
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, e.message) from e
    if updated is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to update phase")
    return {"data": updated}


@router.delete(
    "/workflow/phases/{phase_id}", status_code=status.HTTP_204_NO_CONTENT, summary="工程削除"
)
async def delete_phase(phase_id: str, session: SessionDep, user: UserDep) -> None:
    if await svc.get_phase(session, phase_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "phase not found")
    if not await svc.delete_phase(session, actor_id=user.id, phase_id=phase_id):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no permission to delete phase")


# --------------------------------------------------------------------------- #
# GAP-022: AI 提案フェーズ (ジャービス) + F-IMP01 影響範囲解析 + phase 別集計
# --------------------------------------------------------------------------- #
@router.get("/workflow/phase-proposals", summary="フェーズ提案一覧 (GAP-022)")
async def list_phase_proposals(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str, Query()],
) -> dict[str, list[PhaseProposalResponse]]:
    return {"data": await proposals_svc.list_for_project(session, project_id)}


@router.post(
    "/workflow/phase-proposals",
    status_code=status.HTTP_201_CREATED,
    summary="COO AI (ジャービス) に次フェーズを提案してもらう (GAP-022 — 明示操作起点)",
    responses={503: {"description": "LLM が未設定"}},
)
async def create_phase_proposal(
    body: PhaseProposalCreate, session: SessionDep, user: UserDep
) -> dict[str, PhaseProposalResponse]:
    try:
        created = await proposals_svc.propose(session, actor_id=user.id, project_id=body.project_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except proposals_svc.PhaseProposalError as exc:
        if exc.code == "llm_unconfigured":
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, exc.message) from exc
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message) from exc
    if created is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "project not found")
    return {"data": created}


@router.post(
    "/workflow/phase-proposals/{proposal_id}/approve",
    summary="フェーズ提案を承認 → 実フェーズを確定 (GAP-022)",
)
async def approve_phase_proposal(
    proposal_id: str, session: SessionDep, user: UserDep
) -> dict[str, PhaseProposalApproveResponse]:
    try:
        result = await proposals_svc.approve(session, actor_id=user.id, proposal_id=proposal_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "phase proposal not found")
    proposal, phase = result
    return {"data": PhaseProposalApproveResponse(proposal=proposal, phase=phase)}


@router.post(
    "/workflow/phase-proposals/{proposal_id}/reject",
    summary="フェーズ提案を却下 (フェーズは作られない — GAP-022)",
)
async def reject_phase_proposal(
    proposal_id: str, session: SessionDep, user: UserDep
) -> dict[str, PhaseProposalResponse]:
    try:
        rejected = await proposals_svc.reject(session, actor_id=user.id, proposal_id=proposal_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    if rejected is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "phase proposal not found")
    return {"data": rejected}


@router.post(
    "/workflow/impact-analysis",
    status_code=status.HTTP_201_CREATED,
    summary="F-IMP01: タスク移動の影響範囲解析 (dependencies 推移的走査 — GAP-022)",
)
async def analyze_impact(
    body: ImpactAnalysisRequest, session: SessionDep, user: UserDep
) -> dict[str, ImpactAnalysisResponse]:
    try:
        result = await impact_svc.analyze(
            session, actor_id=user.id, task_id=body.task_id, target_phase_id=body.target_phase_id
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "task or phase not found")
    return {"data": result}


@router.post(
    "/workflow/impact-analysis/{analysis_id}/apply",
    summary="解析結果を承認して適用 — 実移動 + 完了済影響のリファクタ自動起票 (F-CUC02)",
)
async def apply_impact(
    analysis_id: str, session: SessionDep, user: UserDep
) -> dict[str, ImpactApplyResponse]:
    try:
        result = await impact_svc.apply(session, actor_id=user.id, analysis_id=analysis_id)
    except ValueError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "impact analysis not found")
    return {"data": result}


@router.get(
    "/workflow/phase-task-stats",
    summary="phase 別タスク集計 (total/done/awaiting/スコア平均 — GAP-022)",
)
async def phase_task_stats(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str, Query()],
) -> dict[str, list[PhaseTaskStatsResponse]]:
    return {"data": await impact_svc.task_stats(session, project_id)}


@router.get(
    "/workflow/impact-stats",
    summary="F-IMP01 実行回数 (本日) + 依存整合性チェック (GAP-022)",
)
async def impact_stats(
    session: SessionDep,
    _user: UserDep,
    project_id: Annotated[str, Query()],
) -> dict[str, dict[str, object]]:
    count = await impact_svc.today_count(session, project_id)
    check: ConsistencyCheckResponse = await impact_svc.consistency(session, project_id)
    return {
        "data": {
            "today_count": count,
            "consistency_ok": check.ok,
            "dangling_count": check.dangling_count,
        }
    }
