# pyright: reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false
"""S-T01 運営ダッシュボードの platform 集計・記録 (GAP-019)。

対象は platform 全体の運営データ (admin_goals / beta_feedback /
acquisition_records / admin_costs + 横断集計)。RLS の workspace scope に
乗らないため、S-T02 skills と同じ構造 — route の is_admin ゲート +
service session (RLS bypass) — でアクセスする。

誠実表示の原則:
  - 集計はすべて実テーブルの実カウント/実計測 (推測の稼働率・創作数値なし)
  - 目標値 (100 社等)・チャネル・コストは運営が明示的に記録した値のみ
  - 健全性は「いま実測できること」(DB latency/サイズ/接続数、bridge presence、
    外部 API の設定有無) だけを返す
"""

from __future__ import annotations

import asyncio
import os
import time
from datetime import date
from functools import lru_cache
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.audit import AuditEvent, AuditWriter
from src.db.session import create_engine, create_session_factory
from src.schemas.admin import (
    AcquisitionChannelCount,
    AcquisitionCreate,
    AcquisitionRecordResponse,
    AcquisitionsResponse,
    AdminCostCreate,
    AdminCostResponse,
    AdminCostsResponse,
    AdminGoalResponse,
    AdminGoalUpsert,
    AdminMissionResponse,
    AdminPlatformStatsResponse,
    AdminTemplateDeploymentResponse,
    AdminTemplateResponse,
    AdminTemplateUpdate,
    AdminTrendPoint,
    AdminTrendsResponse,
    BetaFeedbackCreate,
    BetaFeedbackResponse,
    HealthCheckRow,
)

GOAL_KEY = "acquisition"


def is_uuid(value: str) -> bool:
    """path param の UUID 妥当性 (不正値は 500 ではなく 404 に落とすため)。"""
    import uuid as uuid_mod

    try:
        uuid_mod.UUID(value)
    except ValueError:
        return False
    return True


@lru_cache(maxsize=8)
def _session_factory_for_loop(loop_key: int) -> async_sessionmaker[AsyncSession]:
    """service_role 相当の sessionmaker (RLS バイパス。loop 毎に分離キャッシュ)。"""
    del loop_key
    return create_session_factory(create_engine())


def service_session_factory() -> async_sessionmaker[AsyncSession]:
    return _session_factory_for_loop(id(asyncio.get_running_loop()))


service_session_factory.cache_clear = (  # pyright: ignore[reportAttributeAccessIssue, reportFunctionMemberAccess]
    _session_factory_for_loop.cache_clear
)


async def _audit(
    session: AsyncSession, action: str, actor_id: str, target_id: str, after: dict[str, object]
) -> None:
    await AuditWriter(session).write(
        AuditEvent(
            action=action,
            target_type="platform",
            actor_type="user",
            actor_id=actor_id,
            target_id=target_id,
            after=after,
        )
    )


# --------------------------------------------------------------------------- #
# ① ミッション (admin_goals + 実カウント)
# --------------------------------------------------------------------------- #
def _goal_row(row: Any) -> AdminGoalResponse:
    return AdminGoalResponse(
        id=str(row.id),
        goal_key=str(row.goal_key),
        title=str(row.title),
        target_count=int(row.target_count),
        deadline=row.deadline,
        note=(None if row.note is None else str(row.note)),
        updated_at=row.updated_at,
    )


async def upsert_goal(*, actor_id: str, data: AdminGoalUpsert) -> AdminGoalResponse:
    async with service_session_factory()() as session:
        res = await session.execute(
            text(
                "insert into public.admin_goals (goal_key, title, target_count, deadline, note) "
                "values (:k, :t, :c, :d, :n) "
                "on conflict (goal_key) do update set title = :t, target_count = :c, "
                "deadline = :d, note = :n, updated_at = now() "
                "returning id, goal_key, title, target_count, deadline, note, updated_at"
            ),
            {
                "k": GOAL_KEY,
                "t": data.title,
                "c": data.target_count,
                "d": data.deadline,
                "n": data.note,
            },
        )
        goal = _goal_row(res.one())
        await _audit(
            session,
            "admin.goal.set",
            actor_id,
            goal.id,
            {"target_count": data.target_count, "deadline": str(data.deadline)},
        )
        await session.commit()
        return goal


async def get_mission() -> AdminMissionResponse:
    async with service_session_factory()() as session:
        g = await session.execute(
            text(
                "select id, goal_key, title, target_count, deadline, note, updated_at "
                "from public.admin_goals where goal_key = :k"
            ),
            {"k": GOAL_KEY},
        )
        goal_row = g.first()
        counts = await session.execute(
            text(
                "select count(*) as total, "
                "count(*) filter (where created_at >= now() - interval '30 days') as added_30d "
                "from public.workspaces where deleted_at is null"
            )
        )
        c = counts.one()
        goal = None if goal_row is None else _goal_row(goal_row)
        resp = AdminMissionResponse(
            goal=goal, current_count=int(c.total), added_30d=int(c.added_30d)
        )
        if goal is not None:
            remaining = max(0, goal.target_count - resp.current_count)
            today = date.today()
            months_left = max(
                0,
                (goal.deadline.year - today.year) * 12 + (goal.deadline.month - today.month),
            )
            resp.remaining = remaining
            resp.months_left = months_left
            resp.needed_per_month = remaining if months_left == 0 else -(-remaining // months_left)
        return resp


# --------------------------------------------------------------------------- #
# ② トレンド (週次の実累計)
# --------------------------------------------------------------------------- #
async def get_trends(days: int) -> AdminTrendsResponse:
    async with service_session_factory()() as session:
        res = await session.execute(
            text(
                "with weeks as ( "
                "  select generate_series( "
                "    date_trunc('week', now() - make_interval(days => :days)), "
                "    date_trunc('week', now()), interval '1 week') as w "
                ") "
                "select w::date as week_start, "
                "(select count(*) from public.workspaces ws "
                " where ws.deleted_at is null and ws.created_at < w + interval '1 week') as workspaces, "
                "(select count(*) from public.projects p "
                " where p.deleted_at is null and p.created_at < w + interval '1 week') as projects "
                "from weeks order by w"
            ),
            {"days": days},
        )
        points = [
            AdminTrendPoint(
                week_start=r.week_start, workspaces=int(r.workspaces), projects=int(r.projects)
            )
            for r in res.all()
        ]
        # 課金は未導入 — MRR は実額 0 (ベータ無料運用)。推測の売上は返さない。
        return AdminTrendsResponse(points=points, billing_enabled=False, mrr_yen=0)


# --------------------------------------------------------------------------- #
# ③ 取得チャネル (acquisition_records)
# --------------------------------------------------------------------------- #
def _acq_row(row: Any) -> AcquisitionRecordResponse:
    return AcquisitionRecordResponse(
        id=str(row.id),
        channel=str(row.channel),
        note=str(row.note),
        occurred_on=row.occurred_on,
        created_at=row.created_at,
    )


async def list_acquisitions(days: int | None) -> AcquisitionsResponse:
    async with service_session_factory()() as session:
        where = (
            ""
            if days is None
            else "where occurred_on >= current_date - make_interval(days => :days) "
        )
        params: dict[str, object] = {} if days is None else {"days": days}
        agg = await session.execute(
            text(
                # 別名は cnt にする — "count" だと Row 属性アクセスが tuple.count
                # メソッドに解決され int(メソッド) で実行時 TypeError になる
                f"select channel, count(*) as cnt from public.acquisition_records {where}"
                "group by channel order by cnt desc"
            ),
            params,
        )
        recent = await session.execute(
            text(
                f"select id, channel, note, occurred_on, created_at "
                f"from public.acquisition_records {where}"
                "order by occurred_on desc, created_at desc limit 10"
            ),
            params,
        )
        channels = [
            AcquisitionChannelCount(channel=str(r.channel), count=int(r.cnt)) for r in agg.all()
        ]
        return AcquisitionsResponse(
            channels=channels,
            recent=[_acq_row(r) for r in recent.all()],
            total=sum(c.count for c in channels),
        )


async def record_acquisition(
    *, actor_id: str, data: AcquisitionCreate
) -> AcquisitionRecordResponse:
    async with service_session_factory()() as session:
        res = await session.execute(
            text(
                "insert into public.acquisition_records (channel, note, occurred_on) "
                "values (:c, :n, coalesce(cast(:d as date), current_date)) "
                "returning id, channel, note, occurred_on, created_at"
            ),
            {"c": data.channel, "n": data.note or "", "d": data.occurred_on},
        )
        rec = _acq_row(res.one())
        await _audit(
            session, "admin.acquisition.record", actor_id, rec.id, {"channel": data.channel}
        )
        await session.commit()
        return rec


async def delete_acquisition(*, actor_id: str, record_id: str) -> bool:
    if not is_uuid(record_id):
        return False
    async with service_session_factory()() as session:
        res = await session.execute(
            text(
                "delete from public.acquisition_records where id = cast(:id as uuid) returning id"
            ),
            {"id": record_id},
        )
        if res.first() is None:
            return False
        await _audit(session, "admin.acquisition.delete", actor_id, record_id, {})
        await session.commit()
        return True


# --------------------------------------------------------------------------- #
# ④ プラットフォーム健全性 (実計測のみ)
# --------------------------------------------------------------------------- #
async def get_health() -> list[HealthCheckRow]:
    rows: list[HealthCheckRow] = []
    async with service_session_factory()() as session:
        t0 = time.perf_counter()
        await session.execute(text("select 1"))
        latency_ms = (time.perf_counter() - t0) * 1000
        rows.append(
            HealthCheckRow(
                name="API ↔ DB 接続",
                status="ok" if latency_ms < 250 else "warn",
                detail=f"DB roundtrip {latency_ms:.0f}ms (実測)",
                meta="正常" if latency_ms < 250 else "遅延あり",
            )
        )
        db = await session.execute(
            text(
                "select pg_database_size(current_database()) as size, "
                "(select count(*) from pg_stat_activity where datname = current_database()) as conns, "
                "(select setting::int from pg_settings where name = 'max_connections') as max_conns"
            )
        )
        d = db.one()
        size_mb = int(d.size) / (1024 * 1024)
        conn_ratio = int(d.conns) / max(1, int(d.max_conns))
        rows.append(
            HealthCheckRow(
                name="PostgreSQL",
                status="ok" if conn_ratio < 0.8 else "warn",
                detail=f"DB {size_mb:.0f} MB · 接続数 {int(d.conns)} / {int(d.max_conns)}",
                meta="正常" if conn_ratio < 0.8 else "接続数逼迫",
            )
        )
        disp = await session.execute(
            text(
                "select "
                "(select count(*) from public.tasks where dispatch_status = 'queued' and deleted_at is null) as queued, "
                "(select count(*) from public.task_executions where status = 'running') as running, "
                "(select count(*) from public.bridge_workers "
                " where last_seen_at >= now() - interval '90 seconds') as workers"
            )
        )
        dp = disp.one()
        rows.append(
            HealthCheckRow(
                name="ディスパッチャ / Bridge",
                status="ok" if int(dp.workers) > 0 or int(dp.queued) == 0 else "warn",
                detail=f"接続 Bridge {int(dp.workers)} · 実行中 {int(dp.running)} · キュー待ち {int(dp.queued)}",
                meta="正常"
                if int(dp.workers) > 0 or int(dp.queued) == 0
                else "Bridge 未接続でキューあり",
            )
        )
    # GAP-178: AI 実行経路と「誰の費用か」を運営画面に出す。
    # env をサーバーで読まないと分からない状態を作らない (設定ミスに気づけるように)。
    from src.services.chat_sse.llm_route import resolve_llm_route

    route = resolve_llm_route()
    rows.append(
        HealthCheckRow(
            name="AI 実行経路 / 費用の出どころ",
            status="ok" if route.is_user_subscription and not route.warnings else "warn",
            detail=f"{route.payer} — {route.reason}"
            + ("｜" + " / ".join(route.warnings) if route.warnings else ""),
            meta="本人サブスク" if route.is_user_subscription else "運営負担あり",
        )
    )

    # 外部 API は「設定の有無」という事実のみ (稼働率の推測はしない)
    externals = (
        ("Anthropic API キー (既定では未使用 — GAP-175)", "ANTHROPIC_API_KEY"),
        ("Voyage AI (埋め込み)", "VOYAGE_API_KEY"),
        ("Resend (メール)", "ATELIER_EMAIL_API_KEY"),
        ("Supabase Storage", "ATELIER_SUPABASE_ADMIN_API_URL"),
    )
    for name, env in externals:
        configured = bool(os.environ.get(env))
        rows.append(
            HealthCheckRow(
                name=name,
                status="ok" if configured else "warn",
                detail="API キー設定済" if configured else f"{env} 未設定",
                meta="設定済" if configured else "未設定",
            )
        )
    return rows


# --------------------------------------------------------------------------- #
# ⑤ ベータ FB (beta_feedback)
# --------------------------------------------------------------------------- #
def _fb_row(row: Any) -> BetaFeedbackResponse:
    return BetaFeedbackResponse(
        id=str(row.id),
        email=str(row.email),
        category=str(row.category),
        content=str(row.content),
        status=str(row.status),
        created_at=row.created_at,
        resolved_at=row.resolved_at,
    )


async def create_feedback(*, user_id: str, data: BetaFeedbackCreate) -> BetaFeedbackResponse:
    async with service_session_factory()() as session:
        em = await session.execute(
            text("select email from public.users where id = cast(:u as uuid)"),
            {"u": user_id},
        )
        email = str(em.scalar_one_or_none() or "")
        res = await session.execute(
            text(
                "insert into public.beta_feedback (user_id, email, category, content) "
                "values (cast(:u as uuid), :e, :c, :t) "
                "returning id, email, category, content, status, created_at, resolved_at"
            ),
            {"u": user_id, "e": email, "c": data.category, "t": data.content},
        )
        fb = _fb_row(res.one())
        await _audit(session, "beta.feedback.create", user_id, fb.id, {"category": data.category})
        await session.commit()
        return fb


async def list_feedback(status_filter: str | None) -> list[BetaFeedbackResponse]:
    async with service_session_factory()() as session:
        where = "" if status_filter is None else "where status = :st "
        params: dict[str, object] = {} if status_filter is None else {"st": status_filter}
        res = await session.execute(
            text(
                "select id, email, category, content, status, created_at, resolved_at "
                f"from public.beta_feedback {where}order by created_at desc limit 50"
            ),
            params,
        )
        return [_fb_row(r) for r in res.all()]


async def resolve_feedback(*, actor_id: str, feedback_id: str) -> BetaFeedbackResponse | None:
    if not is_uuid(feedback_id):
        return None
    async with service_session_factory()() as session:
        res = await session.execute(
            text(
                "update public.beta_feedback set status = 'resolved', resolved_at = now() "
                "where id = cast(:id as uuid) and status = 'open' "
                "returning id, email, category, content, status, created_at, resolved_at"
            ),
            {"id": feedback_id},
        )
        row = res.first()
        if row is None:
            return None
        fb = _fb_row(row)
        await _audit(session, "beta.feedback.resolve", actor_id, fb.id, {})
        await session.commit()
        return fb


# --------------------------------------------------------------------------- #
# ⑥ 運営コスト (admin_costs)
# --------------------------------------------------------------------------- #
def _cost_row(row: Any) -> AdminCostResponse:
    return AdminCostResponse(
        id=str(row.id),
        month=row.month,
        name=str(row.name),
        description=str(row.description),
        amount_yen=int(row.amount_yen),
    )


async def list_costs(month: date) -> AdminCostsResponse:
    first = month.replace(day=1)
    async with service_session_factory()() as session:
        res = await session.execute(
            text(
                "select id, month, name, description, amount_yen from public.admin_costs "
                "where month = cast(:m as date) order by created_at"
            ),
            {"m": first},
        )
        items = [_cost_row(r) for r in res.all()]
        return AdminCostsResponse(
            month=first, items=items, total_yen=sum(i.amount_yen for i in items)
        )


async def record_cost(*, actor_id: str, data: AdminCostCreate) -> AdminCostResponse:
    async with service_session_factory()() as session:
        res = await session.execute(
            text(
                "insert into public.admin_costs (month, name, description, amount_yen) "
                "values (cast(:m as date), :n, :d, :a) "
                "returning id, month, name, description, amount_yen"
            ),
            {
                "m": data.month.replace(day=1),
                "n": data.name,
                "d": data.description or "",
                "a": data.amount_yen,
            },
        )
        cost = _cost_row(res.one())
        await _audit(
            session, "admin.cost.record", actor_id, cost.id, {"amount_yen": data.amount_yen}
        )
        await session.commit()
        return cost


async def delete_cost(*, actor_id: str, cost_id: str) -> bool:
    if not is_uuid(cost_id):
        return False
    async with service_session_factory()() as session:
        res = await session.execute(
            text("delete from public.admin_costs where id = cast(:id as uuid) returning id"),
            {"id": cost_id},
        )
        if res.first() is None:
            return False
        await _audit(session, "admin.cost.delete", actor_id, cost_id, {})
        await session.commit()
        return True


# --------------------------------------------------------------------------- #
# ⑦ platform 横断統計 (KPI bento 拡張)
# --------------------------------------------------------------------------- #
async def get_platform_stats() -> AdminPlatformStatsResponse:
    async with service_session_factory()() as session:
        res = await session.execute(
            text(
                "select "
                "(select count(*) from public.task_executions "
                " where started_at >= now() - interval '30 days') as exec30, "
                "(select avg(score) from public.task_executions "
                " where started_at >= now() - interval '30 days' and score is not null) as avg_score, "
                "(select count(*) from public.beta_feedback) as fb_total, "
                "(select count(*) from public.beta_feedback where status = 'open') as fb_open, "
                "(select count(*) from public.bridge_workers "
                " where last_seen_at >= now() - interval '90 seconds') as bridges, "
                "(select count(*) from public.users where deleted_at is null) as users_total, "
                "(select count(*) from public.users "
                " where deleted_at >= now() - interval '30 days') as users_deleted, "
                "(select count(*) from public.workspaces "
                " where deleted_at is null and created_at >= now() - interval '30 days') as ws30"
            )
        )
        r = res.one()
        return AdminPlatformStatsResponse(
            task_executions_30d=int(r.exec30),
            avg_score_30d=(None if r.avg_score is None else round(float(r.avg_score), 2)),
            beta_feedback_total=int(r.fb_total),
            beta_feedback_open=int(r.fb_open),
            bridge_connected=int(r.bridges),
            users_total=int(r.users_total),
            users_deleted_30d=int(r.users_deleted),
            workspaces_added_30d=int(r.ws30),
        )


# --------------------------------------------------------------------------- #
# GAP-031⑤: S-T03 AI 社員テンプレ編集 (T-A-42 scope expand)。
# ai_employee_templates は RESTRICTIVE no_update のため service session で更新。
# 保存 = version 自動 increment。全 WS の ai_employees.template_id 参照経由で
# テンプレ保存が即時反映される (「保存して全 WS 反映」の実体)。
# --------------------------------------------------------------------------- #
_TPL_FIELD_SQL: dict[str, str] = {
    "default_display_name": "default_display_name = :default_display_name",
    "department": "department = cast(:department as ai_employee_department_enum)",
    "role": "role = cast(:role as ai_employee_role_enum)",
    "system_prompt": "system_prompt = :system_prompt",
    "specialty": "specialty = :specialty",
    "default_skills": "default_skills = cast(:default_skills as uuid[])",
    "default_knowledge_cats": "default_knowledge_cats = cast(:default_knowledge_cats as text[])",
}


async def update_template(
    *, actor_id: str, template_id: str, data: AdminTemplateUpdate
) -> AdminTemplateResponse | None:
    """部分更新 + version 自動 increment + audit template.update。

    返り値 None = テンプレ不在。未指定フィールドは変更しない (呼出側で
    「1 フィールド以上」を検証済みの前提)。
    """
    from src.services.admin import TPL_COLS, tpl_to_response  # 同一パッケージ内共有

    if not is_uuid(template_id):
        return None
    changed = data.model_dump(exclude_unset=True, exclude_none=True)
    set_sql = [_TPL_FIELD_SQL[k] for k in changed]
    async with service_session_factory()() as session:
        res = await session.execute(
            text(
                "update public.ai_employee_templates set "
                + ", ".join([*set_sql, "version = version + 1", "updated_at = now()"])
                + f" where id = cast(:template_id as uuid) returning {TPL_COLS}"
            ),
            {**changed, "template_id": template_id},
        )
        row = res.first()
        if row is None:
            return None
        updated = tpl_to_response(row)
        await _audit(
            session,
            "template.update",
            actor_id,
            template_id,
            {"fields": sorted(changed), "version": updated.version},
        )
        await session.commit()
        return updated


async def get_template_deployment(template_id: str) -> AdminTemplateDeploymentResponse | None:
    """実展開先: ai_employees.template_id を参照する現役 (archived=false) 社員の実カウント。"""
    if not is_uuid(template_id):
        return None
    async with service_session_factory()() as session:
        exists = await session.execute(
            text("select 1 from public.ai_employee_templates where id = cast(:i as uuid)"),
            {"i": template_id},
        )
        if exists.first() is None:
            return None
        res = await session.execute(
            text(
                "select count(*) as employees, count(distinct workspace_id) as workspaces "
                "from public.ai_employees "
                "where template_id = cast(:i as uuid) and archived = false"
            ),
            {"i": template_id},
        )
        r = res.one()
        return AdminTemplateDeploymentResponse(
            template_id=template_id,
            workspace_count=int(r.workspaces),
            employee_count=int(r.employees),
        )
