-- T-D-06: acceptance_criteria / task_executions (E-014, E-013)
--
-- 信頼源: 04_functional_breakdown/entities.json#E-013, E-014
-- 関連: F-J02 (実行履歴 / verification 結果)
-- 依存: T-D-05 (tasks)
--
-- 作成順:
--   1. enum (task_execution_status_enum)
--   2. acceptance_criteria (E-014) — tasks.acceptance_criteria_id の forward ref を解消
--   3. task_executions (E-013) — tasks.id への FK
--   4. ALTER public.tasks ADD CONSTRAINT — acceptance_criteria_id FK 後付け
--
-- AC items の JSON 構造:
--   [{id: text, text: text, tier: 'structural'|'functional'|'regression',
--     passed: bool, evidence: text|null}, ...]

begin;

-- =============================================================================
-- Enum
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_execution_status_enum') then
    create type public.task_execution_status_enum as enum (
      'running', 'succeeded', 'failed', 'cancelled', 'timeout'
    );
  end if;
end $$;

-- =============================================================================
-- E-014 acceptance_criteria (workspace_scoped via task→project)
-- task_id UNIQUE で 1 task : 1 AC を強制 (version で履歴は items の中で管理)
-- =============================================================================
create table if not exists public.acceptance_criteria (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null unique references public.tasks(id) on delete cascade,
  html_path  text not null,
  items      jsonb not null default '[]'::jsonb,
  version    integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint acceptance_criteria_version_positive check (version >= 1),
  constraint acceptance_criteria_items_array check (jsonb_typeof(items) = 'array')
);

comment on table public.acceptance_criteria is
  'E-014 AcceptanceCriteria — task ごとの 3-tier AC (structural/functional/regression)。';
comment on column public.acceptance_criteria.items is
  '[{id, text, tier(structural|functional|regression), passed, evidence}, ...]';

create index if not exists acceptance_criteria_task_idx
  on public.acceptance_criteria (task_id);

-- =============================================================================
-- E-013 task_executions (workspace_scoped via task→project)
-- task の各実行履歴。score / pass_rate は 0.000-1.000 numeric(4,3)。
-- =============================================================================
create table if not exists public.task_executions (
  id                       uuid primary key default gen_random_uuid(),
  task_id                  uuid not null references public.tasks(id) on delete cascade,
  started_at               timestamptz not null,
  completed_at             timestamptz,
  score                    numeric(4,3),
  ac_pass_rate             numeric(4,3),
  test_pass_rate           numeric(4,3),
  verification_score       numeric(4,3),
  retry_count              integer not null default 0,
  claude_code_session_id   text,
  status                   public.task_execution_status_enum not null,
  logs_storage_path        text,
  error_summary            text,
  created_at               timestamptz not null default now(),
  constraint task_executions_retry_count_range
    check (retry_count between 0 and 3),
  constraint task_executions_score_range
    check (score is null or (score >= 0 and score <= 1)),
  constraint task_executions_ac_pass_rate_range
    check (ac_pass_rate is null or (ac_pass_rate >= 0 and ac_pass_rate <= 1)),
  constraint task_executions_test_pass_rate_range
    check (test_pass_rate is null or (test_pass_rate >= 0 and test_pass_rate <= 1)),
  constraint task_executions_verification_score_range
    check (verification_score is null or (verification_score >= 0 and verification_score <= 1)),
  constraint task_executions_completed_after_started
    check (completed_at is null or completed_at >= started_at)
);

comment on table public.task_executions is
  'E-013 TaskExecution — task の実行履歴。1 task : N executions (retry / re-run 含む)。';
comment on column public.task_executions.score is '総合スコア 0.000-1.000';
comment on column public.task_executions.claude_code_session_id is
  'Claude Code セッション ID。Bridge dispatcher が記録、後追いログ取得用。';
comment on column public.task_executions.status is
  'running / succeeded / failed / cancelled / timeout';

create index if not exists task_executions_task_id_idx
  on public.task_executions (task_id, started_at desc);
create index if not exists task_executions_status_idx
  on public.task_executions (status, started_at desc)
  where status in ('running', 'failed');

-- =============================================================================
-- T-D-05 forward reference 解消: tasks.acceptance_criteria_id への FK 追加
--   tasks.mock_id は T-D-07 (mocks) で別途 ALTER 予定
-- =============================================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'tasks_acceptance_criteria_id_fkey'
  ) then
    alter table public.tasks
      add constraint tasks_acceptance_criteria_id_fkey
      foreign key (acceptance_criteria_id)
      references public.acceptance_criteria(id)
      on delete set null;
  end if;
end $$;

-- =============================================================================
-- updated_at トリガ (acceptance_criteria のみ。task_executions は updated_at なし)
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'acceptance_criteria_set_updated_at') then
    create trigger acceptance_criteria_set_updated_at
      before update on public.acceptance_criteria
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- =============================================================================
-- RLS enable + default-deny (T-D-16 で実 policy に置換予定)
-- =============================================================================
alter table public.acceptance_criteria enable row level security;
alter table public.task_executions     enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='acceptance_criteria'
      and policyname='acceptance_criteria_default_deny'
  ) then
    create policy acceptance_criteria_default_deny on public.acceptance_criteria
      as restrictive for all to public using (false);
  end if;
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='task_executions'
      and policyname='task_executions_default_deny'
  ) then
    create policy task_executions_default_deny on public.task_executions
      as restrictive for all to public using (false);
  end if;
end $$;

commit;
