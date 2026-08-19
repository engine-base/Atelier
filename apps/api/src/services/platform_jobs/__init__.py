"""プラットフォーム必須ジョブ (GAP-014 — S-O01 法令・運用バックエンド)。

法令対応とデータ整合性の常時稼働ジョブ (SQL のみ・AI 社員/外部 API 不使用):

  - purge_deleted_accounts: 退会 (T-A-05 soft-delete) から 30 日経過した
    アカウントのデータを物理削除する。個人情報保護法に基づく削除義務の実体。
    T-A-05 は「実際のハード削除は worker job が処理する」と規定しながら
    worker が不在だった (パイプ断絶)。
  - run_integrity_check: タスク依存関係・受入条件・モック ID・工程担当の
    矛盾を検出し、検知時は workspace owner の承認待ち (approval_inbox
    type=integrity_alert) に通知する。

いずれも Inngest cron (scheduler.py) から service-role セッションで実行される。
単独実行: python -m src.services.platform_jobs {purge|integrity}
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from src.audit import AuditEvent, AuditWriter
from src.schemas.cron import PlatformJobLastRun, PlatformJobResponse

logger = logging.getLogger(__name__)

_GRACE_DAYS = 30  # T-A-05 _ACCOUNT_GRACE_DAYS と一致 (30 日猶予)


# --------------------------------------------------------------------------- #
# ジョブ台帳 (S-O01 法令・運用バックエンド節の read-only データ源)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class PlatformJobMeta:
    """cron scheduler の 1 ジョブに対する画面表示メタ。"""

    name: str
    category: str  # legal | report | pipeline
    required: bool  # 無効化不可 (法令対応)
    title: str
    description: str
    schedule_label: str  # JST での人間可読ラベル


PLATFORM_JOB_META: tuple[PlatformJobMeta, ...] = (
    PlatformJobMeta(
        name="purge-deleted-accounts",
        category="legal",
        required=True,
        title="退会データを 30 日後に完全削除",
        description=(
            "個人情報保護法に基づく削除義務。退会から 30 日経過したアカウントの"
            "データを物理削除します。"
        ),
        schedule_label="毎日 深夜 0:00 (JST)",
    ),
    PlatformJobMeta(
        name="integrity-check",
        category="legal",
        required=True,
        title="データ整合性チェック",
        description=(
            "タスク依存関係・受入条件・モック ID・工程担当の矛盾を検出。検知時は承認待ちに通知。"
        ),
        schedule_label="毎日 朝 5:00 (JST)",
    ),
    PlatformJobMeta(
        name="user-schedules",
        category="pipeline",
        required=False,
        title="利用者スケジュールの発火",
        description=(
            "各プロジェクトの自動実行を、画面で指定された時刻に実行します "
            "(GAP-179 — 以前は指定時刻が使われていませんでした)。"
        ),
        schedule_label="毎分",
    ),
    PlatformJobMeta(
        name="transcribe-queue",
        category="pipeline",
        required=False,
        title="議事録 transcription キュー消費",
        description="storage DL → Whisper → 結果書込。",
        schedule_label="毎分",
    ),
)


def next_run_utc(cron: str, now: datetime) -> datetime | None:
    """Atelier platform cron が使う部分集合の次回実行 (UTC) を返す。

    対応形: "* * * * *" (毎分) / "M H * * *" (毎日) / "M H * * D" (毎週)。
    それ以外の式は None (偽の次回時刻を出さない)。
    """
    fields = cron.split()
    if len(fields) != 5:
        return None
    minute_f, hour_f, dom_f, month_f, dow_f = fields
    if dom_f != "*" or month_f != "*":
        return None
    base = now.replace(second=0, microsecond=0)
    if minute_f == "*" and hour_f == "*" and dow_f == "*":
        return base + timedelta(minutes=1)
    if not (minute_f.isdigit() and hour_f.isdigit()):
        return None
    candidate = base.replace(minute=int(minute_f), hour=int(hour_f))
    if dow_f == "*":
        if candidate <= now:
            candidate += timedelta(days=1)
        return candidate
    if not dow_f.isdigit():
        return None
    # cron dow: 0=Sun..6=Sat / Python weekday(): 0=Mon..6=Sun
    target_weekday = (int(dow_f) - 1) % 7
    while candidate.weekday() != target_weekday or candidate <= now:
        candidate += timedelta(days=1)
    return candidate


async def list_platform_jobs(session: AsyncSession) -> list[PlatformJobResponse]:
    """S-O01 用 read-only ジョブ一覧 (定義 + 実 cron 式 + 最終実行 + 次回)。

    最終実行は cron_run_history の実データ (RLS: platform 行は authenticated
    可視)。稼働状況を偽装しない — 実行履歴が無ければ last_run は null。
    """
    from src.cron.scheduler import CRON_SCHEDULES

    cron_by_name = {s.name: s.cron for s in CRON_SCHEDULES}
    now = datetime.now(UTC)
    out: list[PlatformJobResponse] = []
    for meta in PLATFORM_JOB_META:
        cron = cron_by_name.get(meta.name)
        if cron is None:  # scheduler に未登録のジョブは出さない (偽装防止)
            continue
        res = await session.execute(
            text(
                "select started_at, finished_at, status, detail "
                "from public.cron_run_history where name = :n "
                "order by started_at desc limit 1"
            ),
            {"n": meta.name},
        )
        row = res.first()
        last_run = (
            None
            if row is None
            else PlatformJobLastRun(
                started_at=row.started_at,
                finished_at=row.finished_at,
                status=str(row.status),  # type: ignore[arg-type]
            )
        )
        out.append(
            PlatformJobResponse(
                name=meta.name,
                category=meta.category,  # type: ignore[arg-type]
                required=meta.required,
                title=meta.title,
                description=meta.description,
                cron=cron,
                schedule_label=meta.schedule_label,
                next_run_at=next_run_utc(cron, now),
                last_run=last_run,
            )
        )
    return out


# --------------------------------------------------------------------------- #
# Job 1: 退会データ 30 日後完全削除
# --------------------------------------------------------------------------- #
async def purge_deleted_accounts(session: AsyncSession) -> dict[str, str]:
    """退会から 30 日経過したユーザーのデータを物理削除する。

    対象: public.users.deleted_at <= now() - 30 days。
    削除順: ① 所有 workspace (projects/tasks/chat 等へ cascade)
            ② external_uploads (FK restrict のため明示削除)
            ③ auth.users 行 (public.users へ cascade。comments.author 等は
               FK set null で匿名化される)。
    audit_logs は法定監査証跡として保持 (削除実行自体も audit に記録)。
    30 日未満 (復活猶予中 T-A-05) は絶対に触らない。

    GAP-182: ついでに自前エラーログ (error_log) の保持期間 30 日も守る
    (放置するとテーブルが無限に太る)。
    """
    res = await session.execute(
        text(
            "select id from public.users "
            "where deleted_at is not null "
            "and deleted_at <= now() - make_interval(days => :g)"
        ),
        {"g": _GRACE_DAYS},
    )
    user_ids = [str(r.id) for r in res.all()]
    purged_workspaces = 0
    for uid in user_ids:
        ws_res = await session.execute(
            text(
                "delete from public.workspaces where owner_user_id = cast(:u as uuid) returning id"
            ),
            {"u": uid},
        )
        purged_workspaces += len(ws_res.all())
        await session.execute(
            text(
                "delete from public.external_uploads where uploaded_by_user_id = cast(:u as uuid)"
            ),
            {"u": uid},
        )
        # audit は削除前に書く (target の存在に依存しない append-only)
        await AuditWriter(session).write(
            AuditEvent(
                action="platform.account.purged",
                target_type="user",
                actor_type="system",
                actor_id="cron:purge-deleted-accounts",
                target_id=uid,
                after={"grace_days": _GRACE_DAYS},
            )
        )
        await session.execute(
            text("delete from auth.users where id = cast(:u as uuid)"),
            {"u": uid},
        )
    if user_ids:
        logger.info("purged %d account(s), %d workspace(s)", len(user_ids), purged_workspaces)

    from src.observability.errors import purge_old_errors

    purged_errors = await purge_old_errors(session, days=30)
    return {
        "status": "ok",
        "name": "purge-deleted-accounts",
        "purged_users": str(len(user_ids)),
        "purged_workspaces": str(purged_workspaces),
        # GAP-182: 自前エラーログの保持期間 (30 日) を同じ掃除ジョブで守る。
        "purged_errors": str(purged_errors),
    }


# --------------------------------------------------------------------------- #
# Job 2: データ整合性チェック
# --------------------------------------------------------------------------- #
_INTEGRITY_CHECKS: tuple[tuple[str, str], ...] = (
    # (check 名, 違反 project_id + 件数を返す SQL)
    (
        "dangling_task_dependency",
        "select t.project_id, count(*) as cnt from public.tasks t, unnest(t.dependencies) dep "
        "where t.deleted_at is null "
        "and not exists (select 1 from public.tasks d where d.id = dep and d.deleted_at is null) "
        "group by t.project_id",
    ),
    (
        "missing_acceptance_criteria",
        "select t.project_id, count(*) as cnt from public.tasks t "
        "where t.deleted_at is null and t.acceptance_criteria_id is not null "
        "and not exists (select 1 from public.acceptance_criteria ac "
        "where ac.id = t.acceptance_criteria_id) group by t.project_id",
    ),
    (
        "missing_mock",
        "select t.project_id, count(*) as cnt from public.tasks t "
        "where t.deleted_at is null and t.mock_id is not null "
        "and not exists (select 1 from public.mocks m where m.id = t.mock_id) "
        "group by t.project_id",
    ),
    (
        "task_phase_project_mismatch",
        "select t.project_id, count(*) as cnt from public.tasks t "
        "join public.phases p on p.id = t.phase_id "
        "where t.deleted_at is null and p.project_id <> t.project_id "
        "group by t.project_id",
    ),
    (
        "phase_assignee_cross_workspace",
        "select p.project_id, count(*) as cnt "
        "from public.phases p "
        "join public.projects pj on pj.id = p.project_id "
        "cross join lateral unnest(p.assigned_employee_ids) emp "
        "where not exists (select 1 from public.ai_employees e "
        "where e.id = emp and e.workspace_id = pj.workspace_id) "
        "group by p.project_id",
    ),
)


async def run_integrity_check(session: AsyncSession) -> dict[str, str]:
    """データ整合性チェック (SQL のみ)。

    検知した違反は project → workspace owner に集約し、pending の
    integrity_alert が無い owner にだけ approval_inbox で通知する
    (毎日の重複通知を避ける)。実行そのものと件数は audit + cron_run_history
    (呼出側 record_run) に残る。
    """
    issues_by_project: dict[str, dict[str, int]] = {}
    for check_name, sql in _INTEGRITY_CHECKS:
        res = await session.execute(text(sql))
        for row in res.all():
            pid = str(row.project_id)
            issues_by_project.setdefault(pid, {})[check_name] = int(row.cnt)

    notified = 0
    if issues_by_project:
        # project → workspace owner (通知先)
        res = await session.execute(
            text(
                "select p.id as project_id, p.name, w.owner_user_id "
                "from public.projects p join public.workspaces w on w.id = p.workspace_id "
                "where p.id = any(cast(:pids as uuid[]))"
            ),
            {"pids": list(issues_by_project.keys())},
        )
        for row in res.all():
            pid = str(row.project_id)
            owner = str(row.owner_user_id)
            counts = issues_by_project[pid]
            # 同一 project の pending integrity_alert が既にあれば重複通知しない
            dup = await session.execute(
                text(
                    "select 1 from public.approval_inbox "
                    "where type = 'integrity_alert' and status = 'pending' "
                    "and target_id = cast(:p as uuid) limit 1"
                ),
                {"p": pid},
            )
            if dup.first() is not None:
                continue
            await session.execute(
                text(
                    "insert into public.approval_inbox "
                    "(user_id, type, target_type, target_id, title, payload) "
                    "values (cast(:u as uuid), 'integrity_alert', 'project', "
                    "cast(:p as uuid), :t, cast(:pl as jsonb))"
                ),
                {
                    "u": owner,
                    "p": pid,
                    "t": f"データ整合性チェック: {row.name} で {sum(counts.values())} 件の矛盾",
                    "pl": json.dumps(counts, ensure_ascii=False),
                },
            )
            notified += 1

    await AuditWriter(session).write(
        AuditEvent(
            action="platform.integrity.checked",
            target_type="platform_job",
            actor_type="system",
            actor_id="cron:integrity-check",
            target_id=None,
            after={
                "projects_with_issues": len(issues_by_project),
                "notified": notified,
            },
        )
    )
    return {
        "status": "ok",
        "name": "integrity-check",
        "projects_with_issues": str(len(issues_by_project)),
        "notified": str(notified),
    }
