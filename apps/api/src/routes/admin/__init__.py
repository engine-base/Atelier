"""運営 admin ルータ (T-A-43 / T-A-42 / T-A-41)。

T-A-43: GET /admin/audit-logs (監査ログ閲覧)。
T-A-42: GET /admin/skills[/{id}] + /admin/ai-employee-templates[/{id}] (read-only)。
T-A-41: GET /admin/dashboard (集計) + GET /admin/users (所属 workspace 横断メンバー)。
認証 (401) に加え、admin (app_metadata.role=admin) でなければ 403。
閲覧範囲は RLS (T-D-19 / current_user_workspaces()) で scope される。
"""

from __future__ import annotations

from datetime import date as date_type
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from src.dependencies import CurrentUser, get_current_user, get_rls_session
from src.schemas.admin import (
    AcquisitionCreate,
    AcquisitionRecordResponse,
    AcquisitionsResponse,
    AdminCostCreate,
    AdminCostResponse,
    AdminCostsResponse,
    AdminDashboardResponse,
    AdminGoalResponse,
    AdminGoalUpsert,
    AdminMissionResponse,
    AdminPlatformStatsResponse,
    AdminSkillResponse,
    AdminTemplateDeploymentResponse,
    AdminTemplateResponse,
    AdminTemplateUpdate,
    AdminTrendsResponse,
    AdminUserResponse,
    AuditLogResponse,
    BetaFeedbackCreate,
    BetaFeedbackResponse,
    HealthCheckRow,
)
from src.schemas.support import (
    SupportContactItem,
    SupportContactRequest,
    SupportContactResponse,
)
from src.services import admin as svc
from src.services import support as support_svc
from src.services.admin import ops

router = APIRouter(tags=["admin"])

SessionDep = Annotated[AsyncSession, Depends(get_rls_session)]
UserDep = Annotated[CurrentUser, Depends(get_current_user)]


@router.get("/admin/audit-logs", summary="監査ログ閲覧（運営 admin）")
async def list_audit_logs(
    session: SessionDep,
    user: UserDep,
    workspace_id: Annotated[str | None, Query()] = None,
    action: Annotated[str | None, Query()] = None,
    actor_type: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> dict[str, list[AuditLogResponse]]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    items = await svc.list_audit_logs(
        session,
        workspace_id=workspace_id,
        action=action,
        actor_type=actor_type,
        limit=limit,
    )
    return {"data": items}


# --------------------------------------------------------------------------- #
# T-A-42: 運営 admin スキル + AI 社員テンプレ管理
# (skills は read-only 閲覧 + 再取込。テンプレは GAP-031⑤ scope expand で
#  部分更新 (PATCH) + 実展開先カウントを提供)
# --------------------------------------------------------------------------- #
@router.get("/admin/skills", summary="運営 admin: スキル一覧（全件 / read-only）")
async def list_skills(
    session: SessionDep,
    user: UserDep,
    include_inactive: Annotated[bool, Query()] = True,
    name: Annotated[str | None, Query()] = None,
) -> dict[str, list[AdminSkillResponse]]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    return {
        "data": await svc.list_skills_admin(session, include_inactive=include_inactive, name=name)
    }


@router.get("/admin/skills/{skill_id}", summary="運営 admin: スキル詳細")
async def get_skill(
    skill_id: str, session: SessionDep, user: UserDep
) -> dict[str, AdminSkillResponse]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    item = await svc.get_skill_admin(session, skill_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "skill not found")
    return {"data": item}


@router.get(
    "/admin/ai-employee-templates",
    summary="運営 admin: AI 社員テンプレ一覧（全件）",
)
async def list_templates(
    session: SessionDep,
    user: UserDep,
    include_inactive: Annotated[bool, Query()] = True,
    department: Annotated[str | None, Query()] = None,
) -> dict[str, list[AdminTemplateResponse]]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    return {
        "data": await svc.list_templates_admin(
            session, include_inactive=include_inactive, department=department
        )
    }


@router.get(
    "/admin/ai-employee-templates/{template_id}",
    summary="運営 admin: AI 社員テンプレ詳細",
)
async def get_template(
    template_id: str, session: SessionDep, user: UserDep
) -> dict[str, AdminTemplateResponse]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    item = await svc.get_template_admin(session, template_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")
    return {"data": item}


@router.patch(
    "/admin/ai-employee-templates/{template_id}",
    summary="運営 admin: AI 社員テンプレ部分更新 — 保存で version increment + 全 WS 反映 (GAP-031⑤)",
)
async def update_template(
    template_id: str, body: AdminTemplateUpdate, user: UserDep
) -> dict[str, AdminTemplateResponse]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    if not body.model_dump(exclude_unset=True, exclude_none=True):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "at least one field is required")
    item = await ops.update_template(actor_id=user.id, template_id=template_id, data=body)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")
    return {"data": item}


@router.get(
    "/admin/ai-employee-templates/{template_id}/deployment",
    summary="運営 admin: テンプレの実展開先カウント (GAP-031⑤)",
)
async def get_template_deployment(
    template_id: str, user: UserDep
) -> dict[str, AdminTemplateDeploymentResponse]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    item = await ops.get_template_deployment(template_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "template not found")
    return {"data": item}


# --------------------------------------------------------------------------- #
# T-A-41: 運営 admin dashboard / users
# --------------------------------------------------------------------------- #
@router.get(
    "/admin/dashboard",
    summary="運営 admin: dashboard 集計（admin 所属 workspaces scope）",
)
async def get_dashboard(session: SessionDep, user: UserDep) -> dict[str, AdminDashboardResponse]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    return {"data": await svc.admin_dashboard(session)}


@router.get(
    "/admin/users",
    summary="運営 admin: メンバー横断一覧（所属 workspace scope）",
)
async def list_users(
    session: SessionDep,
    user: UserDep,
    workspace_id: Annotated[str | None, Query()] = None,
) -> dict[str, list[AdminUserResponse]]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    return {"data": await svc.list_users_admin(session, workspace_id=workspace_id)}


# --------------------------------------------------------------------------- #
# GAP-031⑥: サポート連絡 (S-T04)
# --------------------------------------------------------------------------- #
@router.post(
    "/admin/support-contact",
    summary="運営 admin: ユーザーへサポートメール送信 (GAP-031⑥)",
)
async def send_support_contact(
    body: SupportContactRequest, user: UserDep
) -> dict[str, SupportContactResponse]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    result = await support_svc.send_support_contact(
        actor_id=user.id,
        user_id=body.user_id,
        subject=body.subject,
        message=body.message,
    )
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "user not found")
    return {"data": result}


@router.get(
    "/admin/support-contacts",
    summary="運営 admin: 最近のサポート対応 (audit support.contact 逆引き)",
)
async def list_support_contacts(
    user: UserDep,
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
) -> dict[str, list[SupportContactItem]]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")
    return {"data": await support_svc.list_recent_contacts(limit=limit)}


# --------------------------------------------------------------------------- #
# GAP-019: S-T01 運営ダッシュボード (mission / trends / channels / health /
# beta FB / costs / platform stats)。platform データは is_admin ゲート +
# service session (services.admin.ops)。
# --------------------------------------------------------------------------- #
def _require_admin(user: CurrentUser) -> None:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin privilege required")


@router.get("/admin/mission", summary="運営 admin: 事業 KPI ミッション (GAP-019)")
async def get_admin_mission(user: UserDep) -> dict[str, AdminMissionResponse]:
    _require_admin(user)
    return {"data": await ops.get_mission()}


@router.put("/admin/goal", summary="運営 admin: 獲得目標の記録 (GAP-019)")
async def put_admin_goal(body: AdminGoalUpsert, user: UserDep) -> dict[str, AdminGoalResponse]:
    _require_admin(user)
    return {"data": await ops.upsert_goal(actor_id=user.id, data=body)}


@router.get("/admin/trends", summary="運営 admin: 週次トレンド実累計 (GAP-019)")
async def get_admin_trends(
    user: UserDep,
    days: Annotated[int, Query(ge=7, le=365)] = 90,
) -> dict[str, AdminTrendsResponse]:
    _require_admin(user)
    return {"data": await ops.get_trends(days)}


@router.get("/admin/acquisitions", summary="運営 admin: 取得チャネル集計 (GAP-019)")
async def list_admin_acquisitions(
    user: UserDep,
    days: Annotated[int | None, Query(ge=1, le=3650)] = None,
) -> dict[str, AcquisitionsResponse]:
    _require_admin(user)
    return {"data": await ops.list_acquisitions(days)}


@router.post(
    "/admin/acquisitions",
    status_code=status.HTTP_201_CREATED,
    summary="運営 admin: 取得チャネルの記録 (GAP-019)",
)
async def record_admin_acquisition(
    body: AcquisitionCreate, user: UserDep
) -> dict[str, AcquisitionRecordResponse]:
    _require_admin(user)
    return {"data": await ops.record_acquisition(actor_id=user.id, data=body)}


@router.delete(
    "/admin/acquisitions/{record_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="運営 admin: 取得チャネル記録の削除 (GAP-019)",
)
async def delete_admin_acquisition(record_id: str, user: UserDep) -> None:
    _require_admin(user)
    if not await ops.delete_acquisition(actor_id=user.id, record_id=record_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "acquisition record not found")


@router.get("/admin/health", summary="運営 admin: プラットフォーム健全性 実計測 (GAP-019)")
async def get_admin_health(user: UserDep) -> dict[str, list[HealthCheckRow]]:
    _require_admin(user)
    return {"data": await ops.get_health()}


@router.get("/admin/platform-stats", summary="運営 admin: platform 横断統計 (GAP-019)")
async def get_admin_platform_stats(user: UserDep) -> dict[str, AdminPlatformStatsResponse]:
    _require_admin(user)
    return {"data": await ops.get_platform_stats()}


@router.post(
    "/beta-feedback",
    status_code=status.HTTP_201_CREATED,
    summary="ベータ FB を投稿 (認証ユーザー — GAP-019)",
)
async def create_beta_feedback(
    body: BetaFeedbackCreate, user: UserDep
) -> dict[str, BetaFeedbackResponse]:
    return {"data": await ops.create_feedback(user_id=user.id, data=body)}


@router.get("/admin/beta-feedback", summary="運営 admin: ベータ FB 一覧 (GAP-019)")
async def list_beta_feedback(
    user: UserDep,
    status_filter: Annotated[str | None, Query(alias="status", pattern="^(open|resolved)$")] = None,
) -> dict[str, list[BetaFeedbackResponse]]:
    _require_admin(user)
    return {"data": await ops.list_feedback(status_filter)}


@router.post(
    "/admin/beta-feedback/{feedback_id}/resolve",
    summary="運営 admin: ベータ FB を対応済みにする (GAP-019)",
)
async def resolve_beta_feedback(feedback_id: str, user: UserDep) -> dict[str, BetaFeedbackResponse]:
    _require_admin(user)
    resolved = await ops.resolve_feedback(actor_id=user.id, feedback_id=feedback_id)
    if resolved is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "feedback not found or already resolved")
    return {"data": resolved}


@router.get("/admin/costs", summary="運営 admin: 運営コスト月次一覧 (GAP-019)")
async def list_admin_costs(
    user: UserDep,
    month: Annotated[date_type | None, Query()] = None,
) -> dict[str, AdminCostsResponse]:
    _require_admin(user)
    return {"data": await ops.list_costs(month or date_type.today())}


@router.post(
    "/admin/costs",
    status_code=status.HTTP_201_CREATED,
    summary="運営 admin: 運営コストの記録 (GAP-019)",
)
async def record_admin_cost(body: AdminCostCreate, user: UserDep) -> dict[str, AdminCostResponse]:
    _require_admin(user)
    return {"data": await ops.record_cost(actor_id=user.id, data=body)}


@router.delete(
    "/admin/costs/{cost_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="運営 admin: 運営コスト記録の削除 (GAP-019)",
)
async def delete_admin_cost(cost_id: str, user: UserDep) -> None:
    _require_admin(user)
    if not await ops.delete_cost(actor_id=user.id, cost_id=cost_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "cost record not found")
