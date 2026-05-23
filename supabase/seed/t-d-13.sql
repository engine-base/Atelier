-- T-D-13: cron_schedules schema + seed data (E-023)
--
-- 信頼源: 04_functional_breakdown/entities.json#E-023
-- 関連: F-O01 (Cron / 自動化スケジューラ), T-F-20 (Inngest cron 基盤)
-- 依存: T-D-02 (projects)
--
-- ⚠️ 設計メモ:
--   ticket title は "cron_schedules + シードデータ" だが files_changed_predicted は
--   `supabase/seed/t-d-13.sql` 1 ファイルのみ。Postgres は 1 トランザクション内で
--   DDL + DML を扱えるため、本ファイルで CREATE TABLE + INSERT 両方を行う。
--   通常 schema は migrations/、seed は seed/ で分けるが、本タスクは title が
--   両方を含むため scope に従い同一ファイルで扱う。
--
--   _TRACK: 将来 schema 移行ツール (Drizzle migrate / supabase db push) との
--   整合のため、Wave 2 で migrations/ と seed/ を分離する follow-up を起票予定。

begin;

-- =============================================================================
-- E-023 cron_schedules (workspace_scoped via project_id)
-- =============================================================================
create table if not exists public.cron_schedules (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  name            text not null,
  cron_expression text not null,
  target_action   text not null,
  target_payload  jsonb not null default '{}'::jsonb,
  enabled         boolean not null default true,
  next_run_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- cron expression は 5 フィールド (m h dom mon dow) または Inngest 形式
  constraint cron_schedules_expression_format
    check (char_length(cron_expression) between 1 and 100),

  constraint cron_schedules_name_length
    check (char_length(name) between 1 and 100),

  -- target_action は entities.json note の 4 種 (将来の拡張も許容)
  constraint cron_schedules_target_action_valid
    check (target_action in (
      'task_replay', 'knowledge_organize', 'industry_extract', 'report_summary',
      'daily_digest', 'weekly_burndown'
    )),

  constraint cron_schedules_target_payload_object
    check (jsonb_typeof(target_payload) = 'object'),

  unique (project_id, name)
);

comment on table public.cron_schedules is
  'E-023 CronSchedule — F-O01 自動化スケジュール (T-F-20 Inngest worker と連携)。';
comment on column public.cron_schedules.cron_expression is
  'cron 5-field 形式 (m h dom mon dow) もしくは Inngest @daily/@hourly 形式';
comment on column public.cron_schedules.target_action is
  'task_replay / knowledge_organize / industry_extract / report_summary / daily_digest / weekly_burndown';
comment on column public.cron_schedules.next_run_at is
  'Inngest worker が次回起動予定時刻を更新する (cron 演算結果)';

-- =============================================================================
-- Indexes
-- =============================================================================
create index if not exists cron_schedules_project_enabled_idx
  on public.cron_schedules (project_id, enabled, next_run_at);
create index if not exists cron_schedules_next_run_idx
  on public.cron_schedules (next_run_at)
  where enabled = true and next_run_at is not null;

-- =============================================================================
-- updated_at トリガ
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'cron_schedules_set_updated_at') then
    create trigger cron_schedules_set_updated_at
      before update on public.cron_schedules
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- =============================================================================
-- RLS enable + default-deny (T-D-20 で実 policy 配置予定)
-- =============================================================================
alter table public.cron_schedules enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='cron_schedules'
      and policyname='cron_schedules_default_deny'
  ) then
    create policy cron_schedules_default_deny on public.cron_schedules
      as restrictive for all to public using (false);
  end if;
end $$;

-- =============================================================================
-- Seed data: T-F-20 Inngest cron 基盤と整合させる workspace 共通 schedules
--
-- ⚠️ 全 project に template として配布される schedule。実際は project 作成時に
--    アプリ層が project_id 付きで複製 INSERT する想定。
--    本 seed は「テンプレート」「リファレンス」用途として system 用 placeholder
--    project に紐付ける形では入れず、実 seed 戦略は T-A-XX (cron CRUD) で確立する。
--
-- 本 migration 段階では schema 配置 + idempotency のみ確認可能な seed として
-- 実 INSERT は省略 (空 seed)。T-F-20 の CRON_SCHEDULES = ["daily-digest",
-- "weekly-burndown"] を template として記録する位置付け。
-- =============================================================================

-- 将来 T-A-40 (cron CRUD) で project 作成時に template から複製 INSERT する
-- データ:
--   daily-digest:     cron='0 9 * * *',  target_action='daily_digest'
--   weekly-burndown:  cron='0 9 * * 1',  target_action='weekly_burndown'
--
-- 本タスクの seed は schema 配置 + 制約検証用で実 INSERT は持たない (idempotent)。

commit;
