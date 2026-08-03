-- GAP-013: cron 実行履歴 (S-O01 の実行履歴テーブルのデータ源)
--
-- 現存する実実行 = プラットフォーム Inngest cron (daily-digest / weekly-burndown /
-- transcribe-queue) + 単独 transcribe worker。project cron_schedules の実行エンジンは
-- T-F-20 未配線のため、schedule_id/project_id は将来の per-schedule 実行用に nullable。
-- detail にはテナントデータを入れない (件数などの運用メタのみ)。
--
-- Idempotency: create if not exists / drop policy if exists → create。

begin;

create table if not exists public.cron_run_history (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  schedule_id uuid references public.cron_schedules(id) on delete set null,
  project_id uuid references public.projects(id) on delete cascade,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'success', 'error')),
  detail jsonb not null default '{}'::jsonb
);

create index if not exists cron_run_history_name_started_idx
  on public.cron_run_history (name, started_at desc);
create index if not exists cron_run_history_project_idx
  on public.cron_run_history (project_id, started_at desc);

alter table public.cron_run_history enable row level security;

drop policy if exists cron_run_history_select_member on public.cron_run_history;

-- SELECT: platform 行 (project_id null — 運用メタのみ) は authenticated 全員可、
-- project 行は所属 workspace member のみ (cron_schedules と同型)。
create policy cron_run_history_select_member on public.cron_run_history
  for select
  to authenticated
  using (
    project_id is null
    or project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

-- INSERT/UPDATE は service (worker / cron handler) のみ — authenticated への
-- 書込 policy は作らない (API 経由の改竄不可)。

commit;
