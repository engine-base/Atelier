-- GAP-022: S-F02 AI 提案フェーズ + F-IMP01 影響範囲解析のバックエンド。
--
-- ① phase_proposals — COO AI (ジャービス) による次フェーズ提案
--    (モックの .phase-card.proposed の実体)。pending → approved (実 phases 行を
--    確定 / approved_phase_id) or rejected。運用ルール「フェーズ追加は AI 提案
--    のみ」に従い、1 プロジェクトにつき pending は 1 件。
-- ② impact_analyses — F-IMP01 実行ログ (タスク移動の影響範囲解析)。
--    統計「F-IMP01 実行回数（本日）」の実データ源。apply で移動 + 完了タスク
--    影響時のリファクタタスク自動起票 (F-CUC02, origin_type='refactor')。
--
-- RLS は project → workspace_memberships で member のみ。
-- 冪等: if not exists / duplicate_object 吸収で再適用可能。

create table if not exists public.phase_proposals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  description text,
  reason text not null,
  proposed_order integer not null check (proposed_order >= 0),
  proposed_by text not null default 'jarvis',
  model text,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  approved_phase_id uuid references public.phases(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists phase_proposals_project_idx
  on public.phase_proposals (project_id, created_at);

create unique index if not exists phase_proposals_pending_unique
  on public.phase_proposals (project_id)
  where status = 'pending';

alter table public.phase_proposals enable row level security;

do $$ begin
  create policy phase_proposals_member_select on public.phase_proposals
    for select to authenticated
    using (
      exists (
        select 1 from public.projects p
        join public.workspace_memberships m on m.workspace_id = p.workspace_id
        where p.id = phase_proposals.project_id and m.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy phase_proposals_member_insert on public.phase_proposals
    for insert to authenticated
    with check (
      exists (
        select 1 from public.projects p
        join public.workspace_memberships m on m.workspace_id = p.workspace_id
        where p.id = phase_proposals.project_id and m.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy phase_proposals_member_update on public.phase_proposals
    for update to authenticated
    using (
      exists (
        select 1 from public.projects p
        join public.workspace_memberships m on m.workspace_id = p.workspace_id
        where p.id = phase_proposals.project_id and m.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;

create table if not exists public.impact_analyses (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  target_phase_id uuid not null references public.phases(id) on delete cascade,
  affected_task_ids uuid[] not null default '{}'::uuid[],
  affected_done_task_ids uuid[] not null default '{}'::uuid[],
  applied boolean not null default false,
  refactor_task_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  applied_at timestamptz
);

create index if not exists impact_analyses_project_idx
  on public.impact_analyses (project_id, created_at);

alter table public.impact_analyses enable row level security;

do $$ begin
  create policy impact_analyses_member_select on public.impact_analyses
    for select to authenticated
    using (
      exists (
        select 1 from public.projects p
        join public.workspace_memberships m on m.workspace_id = p.workspace_id
        where p.id = impact_analyses.project_id and m.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy impact_analyses_member_insert on public.impact_analyses
    for insert to authenticated
    with check (
      exists (
        select 1 from public.projects p
        join public.workspace_memberships m on m.workspace_id = p.workspace_id
        where p.id = impact_analyses.project_id and m.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;

do $$ begin
  create policy impact_analyses_member_update on public.impact_analyses
    for update to authenticated
    using (
      exists (
        select 1 from public.projects p
        join public.workspace_memberships m on m.workspace_id = p.workspace_id
        where p.id = impact_analyses.project_id and m.user_id = auth.uid()
      )
    );
exception when duplicate_object then null; end $$;
