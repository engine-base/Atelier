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
from src.routes.admin_guard import require_admin
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
    AlertStateEntry,
    AlertStatusResponse,
    AuditLogResponse,
    BetaFeedbackCreate,
    BetaFeedbackResponse,
    ClientErrorReport,
    ErrorLogEntry,
    HealthCheckRow,
    UptimeStatusResponse,
    UptimeTargetStatus,
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


@router.get(
    "/admin/audit-logs", summary="監査ログ閲覧（運営 admin）", dependencies=[Depends(require_admin)]
)
async def list_audit_logs(
    session: SessionDep,
    user: UserDep,
    workspace_id: Annotated[str | None, Query()] = None,
    action: Annotated[str | None, Query()] = None,
    actor_type: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> dict[str, list[AuditLogResponse]]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")
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
@router.get(
    "/admin/skills",
    summary="運営 admin: スキル一覧（全件 / read-only）",
    dependencies=[Depends(require_admin)],
)
async def list_skills(
    user: UserDep,
    include_inactive: Annotated[bool, Query()] = True,
    name: Annotated[str | None, Query()] = None,
) -> dict[str, list[AdminSkillResponse]]:
    # GAP-144: content_md は列 revoke 済 — is_admin gate 後に service 経路で読む
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")
    return {"data": await svc.list_skills_admin(include_inactive=include_inactive, name=name)}


@router.get(
    "/admin/skills/{skill_id}",
    summary="運営 admin: スキル詳細",
    dependencies=[Depends(require_admin)],
)
async def get_skill(skill_id: str, user: UserDep) -> dict[str, AdminSkillResponse]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")
    item = await svc.get_skill_admin(skill_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の能力（スキル）が見つかりません。")
    return {"data": item}


@router.get(
    "/admin/ai-employee-templates",
    summary="運営 admin: AI 社員テンプレ一覧（全件）",
    dependencies=[Depends(require_admin)],
)
async def list_templates(
    session: SessionDep,
    user: UserDep,
    include_inactive: Annotated[bool, Query()] = True,
    department: Annotated[str | None, Query()] = None,
) -> dict[str, list[AdminTemplateResponse]]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")
    return {
        "data": await svc.list_templates_admin(
            session, include_inactive=include_inactive, department=department
        )
    }


@router.get(
    "/admin/ai-employee-templates/{template_id}",
    summary="運営 admin: AI 社員テンプレ詳細",
    dependencies=[Depends(require_admin)],
)
async def get_template(
    template_id: str, session: SessionDep, user: UserDep
) -> dict[str, AdminTemplateResponse]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")
    item = await svc.get_template_admin(session, template_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のテンプレートが見つかりません。")
    return {"data": item}


@router.patch(
    "/admin/ai-employee-templates/{template_id}",
    summary="運営 admin: AI 社員テンプレ部分更新 — 保存で version increment + 全 WS 反映 (GAP-031⑤)",
    dependencies=[Depends(require_admin)],
)
async def update_template(
    template_id: str, body: AdminTemplateUpdate, user: UserDep
) -> dict[str, AdminTemplateResponse]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")
    if not body.model_dump(exclude_unset=True, exclude_none=True):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "変更する項目を 1 つ以上指定してください。"
        )
    item = await ops.update_template(actor_id=user.id, template_id=template_id, data=body)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のテンプレートが見つかりません。")
    return {"data": item}


@router.get(
    "/admin/ai-employee-templates/{template_id}/deployment",
    summary="運営 admin: テンプレの実展開先カウント (GAP-031⑤)",
    dependencies=[Depends(require_admin)],
)
async def get_template_deployment(
    template_id: str, user: UserDep
) -> dict[str, AdminTemplateDeploymentResponse]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")
    item = await ops.get_template_deployment(template_id)
    if item is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のテンプレートが見つかりません。")
    return {"data": item}


# --------------------------------------------------------------------------- #
# T-A-41: 運営 admin dashboard / users
# --------------------------------------------------------------------------- #
@router.get(
    "/admin/dashboard",
    summary="運営 admin: dashboard 集計（admin 所属 workspaces scope）",
    dependencies=[Depends(require_admin)],
)
async def get_dashboard(session: SessionDep, user: UserDep) -> dict[str, AdminDashboardResponse]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")
    return {"data": await svc.admin_dashboard(session)}


@router.get(
    "/admin/users",
    summary="運営 admin: メンバー横断一覧（所属 workspace scope）",
    dependencies=[Depends(require_admin)],
)
async def list_users(
    session: SessionDep,
    user: UserDep,
    workspace_id: Annotated[str | None, Query()] = None,
) -> dict[str, list[AdminUserResponse]]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")
    return {"data": await svc.list_users_admin(session, workspace_id=workspace_id)}


# --------------------------------------------------------------------------- #
# GAP-031⑥: サポート連絡 (S-T04)
# --------------------------------------------------------------------------- #
@router.post(
    "/admin/support-contact",
    summary="運営 admin: ユーザーへサポートメール送信 (GAP-031⑥)",
    dependencies=[Depends(require_admin)],
)
async def send_support_contact(
    body: SupportContactRequest, user: UserDep
) -> dict[str, SupportContactResponse]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")
    result = await support_svc.send_support_contact(
        actor_id=user.id,
        user_id=body.user_id,
        subject=body.subject,
        message=body.message,
    )
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の利用者が見つかりません。")
    return {"data": result}


@router.get(
    "/admin/support-contacts",
    summary="運営 admin: 最近のサポート対応 (audit support.contact 逆引き)",
    dependencies=[Depends(require_admin)],
)
async def list_support_contacts(
    user: UserDep,
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
) -> dict[str, list[SupportContactItem]]:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")
    return {"data": await support_svc.list_recent_contacts(limit=limit)}


# --------------------------------------------------------------------------- #
# GAP-019: S-T01 運営ダッシュボード (mission / trends / channels / health /
# beta FB / costs / platform stats)。platform データは is_admin ゲート +
# service session (services.admin.ops)。
# --------------------------------------------------------------------------- #
def _require_admin(user: CurrentUser) -> None:
    if not svc.is_admin(user):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "この操作は運営のみが行えます。")


@router.get(
    "/admin/mission",
    summary="運営 admin: 事業 KPI ミッション (GAP-019)",
    dependencies=[Depends(require_admin)],
)
async def get_admin_mission(user: UserDep) -> dict[str, AdminMissionResponse]:
    _require_admin(user)
    return {"data": await ops.get_mission()}


@router.put(
    "/admin/goal",
    summary="運営 admin: 獲得目標の記録 (GAP-019)",
    dependencies=[Depends(require_admin)],
)
async def put_admin_goal(body: AdminGoalUpsert, user: UserDep) -> dict[str, AdminGoalResponse]:
    _require_admin(user)
    return {"data": await ops.upsert_goal(actor_id=user.id, data=body)}


@router.get(
    "/admin/trends",
    summary="運営 admin: 週次トレンド実累計 (GAP-019)",
    dependencies=[Depends(require_admin)],
)
async def get_admin_trends(
    user: UserDep,
    days: Annotated[int, Query(ge=7, le=365)] = 90,
) -> dict[str, AdminTrendsResponse]:
    _require_admin(user)
    return {"data": await ops.get_trends(days)}


@router.get(
    "/admin/acquisitions",
    summary="運営 admin: 取得チャネル集計 (GAP-019)",
    dependencies=[Depends(require_admin)],
)
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
    dependencies=[Depends(require_admin)],
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
    dependencies=[Depends(require_admin)],
)
async def delete_admin_acquisition(record_id: str, user: UserDep) -> None:
    _require_admin(user)
    if not await ops.delete_acquisition(actor_id=user.id, record_id=record_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象の獲得記録が見つかりません。")


@router.get(
    "/admin/health",
    summary="運営 admin: プラットフォーム健全性 実計測 (GAP-019)",
    dependencies=[Depends(require_admin)],
)
async def get_admin_health(user: UserDep) -> dict[str, list[HealthCheckRow]]:
    _require_admin(user)
    return {"data": await ops.get_health()}


@router.get(
    "/admin/alerts",
    summary="運営 admin: エラー通知の設定と送信状態 (GAP-194)",
    dependencies=[Depends(require_admin)],
)
async def get_admin_alerts(
    user: UserDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> AlertStatusResponse:
    """「通知が届く状態か」と「実際に送ったか」を返す。

    GAP-182 で記録はできたが誰にも届かなかった。ここで送信先の設定状況を
    そのまま見せる — channels が空なら「どこにも通知できていない」が真実。
    """
    _require_admin(user)
    from src.observability.alerts import list_alert_state
    from src.observability.notify import alert_settings, configured_channels

    cfg = alert_settings()
    rows = await list_alert_state(limit=limit)
    return AlertStatusResponse(
        channels=list(configured_channels(cfg)),
        cooldown_minutes=cfg.cooldown_minutes,
        notify_warnings=cfg.notify_warnings,
        max_delay_minutes=15,
        data=[
            AlertStateEntry(
                fingerprint=r.fingerprint,
                first_seen_at=r.first_seen_at,
                last_notified_at=r.last_notified_at,
                notified_count=r.notified_count,
                reported_errors=r.reported_errors,
                last_status=r.last_status,  # pyright: ignore[reportArgumentType]
                last_detail=r.last_detail,
            )
            for r in rows
        ],
    )


@router.get(
    "/admin/uptime",
    summary="運営 admin: 外形監視の状態 (GAP-195)",
    dependencies=[Depends(require_admin)],
)
async def get_admin_uptime(user: UserDep) -> UptimeStatusResponse:
    """運営インフラの外側から観測した結果を返す。

    自前のエラーログはサーバーが生きている前提でしか書けない。ここは
    GitHub Actions が **API を経由せず直接 Supabase へ** 書いた記録なので、
    サーバーが落ちていた時間もそのまま残る。
    """
    _require_admin(user)
    from src.observability.uptime import summarize

    async with ops.service_session_factory()() as session:
        rows = await summarize(session)
    return UptimeStatusResponse(
        data=[
            UptimeTargetStatus(
                target=r.target,
                ok=r.ok,
                last_checked_at=r.last_checked_at,
                since=r.since,
                availability_24h=r.availability_24h,
                checks_24h=r.checks_24h,
                last_error=r.last_error,
                last_latency_ms=r.last_latency_ms,
            )
            for r in rows
        ],
        interval_minutes=15,
        last_observed_at=max((r.last_checked_at for r in rows), default=None),
    )


@router.get(
    "/admin/errors",
    summary="運営 admin: エラーログ (GAP-182 — 外部 SaaS に送らない自前記録)",
    dependencies=[Depends(require_admin)],
)
async def list_admin_errors(
    user: UserDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    hours: Annotated[int, Query(ge=1, le=720)] = 168,
) -> dict[str, list[ErrorLogEntry]]:
    """直近のエラーを新しい順で返す。

    Sentry (外部 SaaS) を使わない選択にしたため、これが唯一の「本番で何が
    壊れたか」を知る手段。秘匿値はサーバー側でマスク済み。
    """
    _require_admin(user)
    from src.observability.errors import list_errors

    rows = await list_errors(limit=limit, hours=hours)
    return {
        "data": [
            ErrorLogEntry(
                id=r.id,
                occurred_at=r.occurred_at,
                source=r.source,  # pyright: ignore[reportArgumentType]
                level=r.level,  # pyright: ignore[reportArgumentType]
                kind=r.kind,
                message=r.message,
                path=r.path,
                method=r.method,
                status_code=r.status_code,
                fingerprint=r.fingerprint,
                count_24h=r.count_24h,
            )
            for r in rows
        ]
    }


@router.post(
    "/client-errors",
    status_code=status.HTTP_202_ACCEPTED,
    summary="画面側エラーの報告 (GAP-182 — 認証ユーザー)",
)
async def report_client_error(body: ClientErrorReport, user: UserDep) -> dict[str, str]:
    """Next.js 側で起きたエラーを自前のログに残す。

    外部に送らないので、画面が白くなったことに運営が気づける唯一の経路。
    """
    from src.observability.errors import record_error

    await record_error(
        source="web",
        kind=body.kind,
        message=body.message,
        path=body.path,
        stack=body.stack,
        user_id=user.id,
    )
    return {"status": "accepted"}


@router.get(
    "/admin/platform-stats",
    summary="運営 admin: platform 横断統計 (GAP-019)",
    dependencies=[Depends(require_admin)],
)
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


@router.get(
    "/admin/beta-feedback",
    summary="運営 admin: ベータ FB 一覧 (GAP-019)",
    dependencies=[Depends(require_admin)],
)
async def list_beta_feedback(
    user: UserDep,
    status_filter: Annotated[str | None, Query(alias="status", pattern="^(open|resolved)$")] = None,
) -> dict[str, list[BetaFeedbackResponse]]:
    _require_admin(user)
    return {"data": await ops.list_feedback(status_filter)}


@router.post(
    "/admin/beta-feedback/{feedback_id}/resolve",
    summary="運営 admin: ベータ FB を対応済みにする (GAP-019)",
    dependencies=[Depends(require_admin)],
)
async def resolve_beta_feedback(feedback_id: str, user: UserDep) -> dict[str, BetaFeedbackResponse]:
    _require_admin(user)
    resolved = await ops.resolve_feedback(actor_id=user.id, feedback_id=feedback_id)
    if resolved is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "対象のフィードバックが見つからないか、すでに対応済みです。"
        )
    return {"data": resolved}


@router.get(
    "/admin/costs",
    summary="運営 admin: 運営コスト月次一覧 (GAP-019)",
    dependencies=[Depends(require_admin)],
)
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
    dependencies=[Depends(require_admin)],
)
async def record_admin_cost(body: AdminCostCreate, user: UserDep) -> dict[str, AdminCostResponse]:
    _require_admin(user)
    return {"data": await ops.record_cost(actor_id=user.id, data=body)}


@router.delete(
    "/admin/costs/{cost_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="運営 admin: 運営コスト記録の削除 (GAP-019)",
    dependencies=[Depends(require_admin)],
)
async def delete_admin_cost(cost_id: str, user: UserDep) -> None:
    _require_admin(user)
    if not await ops.delete_cost(actor_id=user.id, cost_id=cost_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "対象のコスト記録が見つかりません。")
