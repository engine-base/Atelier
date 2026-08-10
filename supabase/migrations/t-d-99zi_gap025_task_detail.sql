-- GAP-025: S-I02 タスク詳細の未描画要素群のバックエンド。
--
-- ① tasks.verifier_employee_id — 「検証担当」メタの実体 (AI 社員 FK)。
-- ② task_execution_tests — テストケース単位の結果 (Bridge complete が記録、
--    S-I02 テスト結果タブの実体)。RLS は execution → task → project →
--    workspace_memberships で member のみ可視。INSERT policy は置かない
--    (書込は Bridge の service session のみ — API 改竄不可)。
--
-- 冪等: if not exists で再適用可能。

alter table public.tasks
  add column if not exists verifier_employee_id uuid
    references public.ai_employees(id) on delete set null;

comment on column public.tasks.verifier_employee_id is
  'GAP-025: 検証担当 AI 社員 (S-I02 メタ行。未設定は「未割当」表示)';

create table if not exists public.task_execution_tests (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references public.task_executions(id) on delete cascade,
  name text not null,
  file text,
  status text not null check (status in ('pass', 'fail', 'skip')),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists task_execution_tests_execution_idx
  on public.task_execution_tests (execution_id, created_at);

alter table public.task_execution_tests enable row level security;

do $$ begin
  create policy task_execution_tests_member_select on public.task_execution_tests
    for select to authenticated
    using (
      exists (
        select 1 from public.task_executions te
        join public.tasks t on t.id = te.task_id
        join public.projects p on p.id = t.project_id
        join public.workspace_memberships m on m.workspace_id = p.workspace_id
        where te.id = task_execution_tests.execution_id
          and m.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;
