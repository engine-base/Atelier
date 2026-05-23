-- T-D-05: tasks (E-012, Hermes v3.1 互換 31 フィールド)
--
-- 信頼源: 04_functional_breakdown/entities.json#E-012
-- 関連: F-018 (タスク管理), F-DISP01 (Dispatcher Bridge)
-- 依存: T-D-02 (projects / phases), T-D-03 (ai_employees)
--
-- Hermes 互換の最重要 entity。kanban 6 列モデル (lifecycle_stage) で表示し、
-- Dispatcher (T-F-28) の kanban_tools が move / block / assign を行う。
--
-- 注意:
--   acceptance_criteria_id, mock_id は forward reference (テーブル未作成)。
--   T-D-06 で acceptance_criteria, T-D-07 で mocks を作成するため、本 migration
--   では FK 制約を deferred で配置せず、後追い ALTER で付ける運用とする。
--   (CIRCULAR DEPENDENCY 回避)

begin;

-- =============================================================================
-- Enums (E-012 専用)
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_type_enum') then
    create type public.task_type_enum as enum (
      'foundation', 'screen', 'feature', 'verification', 'infrastructure'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'task_status_enum') then
    -- coarse status (lifecycle_stage は別軸の細粒度 Hermes 6 列)
    create type public.task_status_enum as enum (
      'pending', 'in_progress', 'completed', 'cancelled'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'task_priority_enum') then
    create type public.task_priority_enum as enum (
      'low', 'medium', 'high', 'urgent'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'task_lifecycle_enum') then
    -- Hermes 6 列 (UI: 準備中/着手可/実装中/要対応/承認待ち/完了)
    create type public.task_lifecycle_enum as enum (
      'triage', 'ready', 'in_progress', 'blocked', 'awaiting', 'done'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'task_dispatch_enum') then
    -- Bridge worker プロセス低レベル状態 (lifecycle_stage と独立)
    create type public.task_dispatch_enum as enum (
      'queued', 'spawning', 'running', 'completing', 'dead', 'reclaimed'
    );
  end if;
end $$;

-- =============================================================================
-- E-012 tasks (workspace_scoped via project_id, soft_delete)
-- =============================================================================
create table if not exists public.tasks (
  -- 識別 & 階層
  id                          uuid primary key default gen_random_uuid(),
  project_id                  uuid not null references public.projects(id) on delete cascade,
  phase_id                    uuid references public.phases(id) on delete set null,
  parent_task_id              uuid references public.tasks(id) on delete set null,

  -- 表示
  category                    text not null,
  title                       text not null,
  description                 text,

  -- 分類
  type                        public.task_type_enum not null,
  estimated_hours             integer not null,

  -- 依存関係 (アプリ層で整合性、配列の FK 制約は付かない)
  dependencies                uuid[] not null default array[]::uuid[],
  prerequisites               uuid[] not null default array[]::uuid[],
  blocks                      uuid[] not null default array[]::uuid[],

  -- 関連 entity (forward ref: acceptance_criteria_id / mock_id は別 migration で
  -- ALTER 付与。本 migration では NULL 許容のみ宣言)
  acceptance_criteria_id      uuid,
  mock_id                     uuid,
  spec_html_path              text,
  assigned_employee_id        uuid references public.ai_employees(id) on delete set null,

  -- 状態 (coarse / fine 2 軸)
  status                      public.task_status_enum not null default 'pending',
  priority                    public.task_priority_enum not null default 'medium',
  lifecycle_stage             public.task_lifecycle_enum not null default 'triage',
  auto_advance_allowed        boolean not null default true,

  -- ファイル mutex (衝突回避用、Dispatcher が参照)
  files_changed               text[] not null default array[]::text[],

  -- 履歴管理
  origin_type                 text not null default 'initial_decomposition',

  -- Hermes 互換 (kanban_complete / kanban_block で記録)
  summary                     text,
  metadata                    jsonb not null default '{}'::jsonb,
  blocked_reason              text,
  retry_count                 integer not null default 0,

  -- Bridge worker 状態 (F-DISP01 / F-BRIDGE01)
  worktree_path               text,
  dispatch_status             public.task_dispatch_enum,
  worker_pid                  integer,
  worker_started_at           timestamptz,
  worker_last_heartbeat_at    timestamptz,

  -- timestamps + soft delete
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  deleted_at                  timestamptz,

  constraint tasks_estimated_hours_range
    check (estimated_hours between 1 and 24),
  constraint tasks_retry_count_range
    check (retry_count between 0 and 3),
  constraint tasks_origin_type_valid
    check (origin_type in (
      'initial_decomposition', 'refactor', 'scope_change_auto', 'manual_added'
    )),
  constraint tasks_no_self_dependency
    check (parent_task_id is null or parent_task_id <> id),
  constraint tasks_title_length
    check (char_length(title) between 1 and 200)
);

comment on table public.tasks is
  'E-012 Task — Hermes v3.1 互換 31 フィールド。kanban 6 列 (lifecycle_stage) で表示。';
comment on column public.tasks.lifecycle_stage is
  'Hermes 6 列: triage(準備中) / ready(着手可) / in_progress(実装中) / blocked(要対応) / awaiting(承認待ち) / done(完了)';
comment on column public.tasks.dispatch_status is
  'Bridge worker PTY プロセスの低レベル状態。lifecycle_stage と独立、PID ポーリング用。';
comment on column public.tasks.dependencies is '必須属性 (アプリ層で整合性担保)';
comment on column public.tasks.files_changed is '衝突回避用。Dispatcher が file mutex に使用';
comment on column public.tasks.retry_count is 'F-DISP01 サーキットブレーカ。3 超過で Blocked 固定';
comment on column public.tasks.origin_type is
  'initial_decomposition / refactor / scope_change_auto / manual_added';

-- =============================================================================
-- Indexes (kanban / dispatcher / RLS で頻繁にアクセス)
-- =============================================================================
create index if not exists tasks_project_lifecycle_idx
  on public.tasks (project_id, lifecycle_stage) where deleted_at is null;
create index if not exists tasks_assigned_employee_idx
  on public.tasks (assigned_employee_id, lifecycle_stage)
  where assigned_employee_id is not null and deleted_at is null;
create index if not exists tasks_parent_idx
  on public.tasks (parent_task_id) where parent_task_id is not null;
create index if not exists tasks_dispatch_active_idx
  on public.tasks (dispatch_status, worker_last_heartbeat_at)
  where dispatch_status in ('running', 'completing');
create index if not exists tasks_priority_idx
  on public.tasks (project_id, priority, lifecycle_stage)
  where deleted_at is null and lifecycle_stage in ('triage', 'ready');

-- =============================================================================
-- updated_at トリガ (T-D-01 set_updated_at() 再利用)
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'tasks_set_updated_at') then
    create trigger tasks_set_updated_at
      before update on public.tasks
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- =============================================================================
-- RLS enable + default-deny (T-D-16 で workspace member policy に置換予定)
-- =============================================================================
alter table public.tasks enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='tasks' and policyname='tasks_default_deny'
  ) then
    create policy tasks_default_deny on public.tasks
      as restrictive for all to public using (false);
  end if;
end $$;

commit;
