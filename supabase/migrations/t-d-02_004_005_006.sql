-- T-D-02: projects / phases / workflow_outputs (E-004, E-005, E-006)
--
-- 信頼源: 04_functional_breakdown/entities.json
-- 関連 RLS: T-D-15 で workspaces / projects policy 配置
-- 依存: T-D-01 (workspaces / users)
--
-- AI 学習 opt-out (F-LEGAL-011): projects.ai_training_optout DEFAULT true。
-- 顧客データを学習に使う実装は絶対にしない (R-T08 致命級設計)。

begin;

-- =============================================================================
-- Enums
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'project_type_enum') then
    create type public.project_type_enum as enum ('client_work', 'internal_product', 'personal');
  end if;
  if not exists (select 1 from pg_type where typname = 'project_status_enum') then
    create type public.project_status_enum as enum ('draft', 'active', 'paused', 'archived');
  end if;
  if not exists (select 1 from pg_type where typname = 'phase_status_enum') then
    create type public.phase_status_enum as enum ('pending', 'in_progress', 'completed', 'skipped');
  end if;
  if not exists (select 1 from pg_type where typname = 'workflow_stage_enum') then
    create type public.workflow_stage_enum as enum (
      'proposal', 'estimate', 'hearing', 'requirements', 'architecture',
      'design', 'breakdown', 'tasks', 'implementation', 'verification', 'delivery'
    );
  end if;
end $$;

-- =============================================================================
-- E-004 projects (workspace_scoped, soft_delete)
-- =============================================================================
create table if not exists public.projects (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references public.workspaces(id) on delete cascade,
  name                 text not null,
  client_name          text,
  project_type         public.project_type_enum not null,
  status               public.project_status_enum not null default 'draft',
  ai_training_optout   boolean not null default true,
  settings             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,
  constraint projects_name_length check (char_length(name) between 1 and 200)
);

comment on table public.projects is
  'E-004 Project — workspace 配下の案件。RLS: workspace member のみ (T-D-15)。';
comment on column public.projects.ai_training_optout is
  'F-LEGAL-011: AI 学習 opt-out。デフォルト true (学習しない)。R-T08 致命級。';
comment on column public.projects.project_type is
  'client_work (受託) / internal_product (自社事業) / personal (個人)';

create index if not exists projects_workspace_id_idx
  on public.projects (workspace_id) where deleted_at is null;
create index if not exists projects_status_idx
  on public.projects (workspace_id, status) where deleted_at is null;

-- =============================================================================
-- E-005 phases (project_scoped via FK)
-- =============================================================================
create table if not exists public.phases (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  "order"       integer not null,
  name          text not null,
  description   text,
  status        public.phase_status_enum not null default 'pending',
  started_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  constraint phases_order_positive check ("order" >= 0),
  unique (project_id, "order")
);

comment on table public.phases is
  'E-005 Phase — project 内の段階。"order" で表示順制御。';

create index if not exists phases_project_id_order_idx
  on public.phases (project_id, "order");

-- =============================================================================
-- E-006 workflow_outputs (project_scoped, soft_delete, versioned)
-- =============================================================================
create table if not exists public.workflow_outputs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  phase_id    uuid references public.phases(id) on delete set null,
  stage       public.workflow_stage_enum not null,
  html_path   text,
  json_path   text,
  md_path     text,
  summary     text,
  version     integer not null default 1,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint workflow_outputs_version_positive check (version >= 1)
);

comment on table public.workflow_outputs is
  'E-006 WorkflowOutput — 各 stage の生成物 (html/json/md パス)。Supabase Storage と連携。';
comment on column public.workflow_outputs.stage is
  'workflow stage: proposal → estimate → hearing → ... → delivery';
comment on column public.workflow_outputs.summary is
  '次工程引き継ぎ用要約。Hermes プロトコル準拠の format で記述。';

create index if not exists workflow_outputs_project_stage_idx
  on public.workflow_outputs (project_id, stage) where deleted_at is null;
create index if not exists workflow_outputs_phase_id_idx
  on public.workflow_outputs (phase_id) where phase_id is not null;

-- =============================================================================
-- updated_at トリガ (T-D-01 で定義済の set_updated_at() を再利用)
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'projects_set_updated_at') then
    create trigger projects_set_updated_at
      before update on public.projects
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'workflow_outputs_set_updated_at') then
    create trigger workflow_outputs_set_updated_at
      before update on public.workflow_outputs
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- =============================================================================
-- RLS enable + default-deny policy (T-D-15 で実 policy に置換予定)
-- =============================================================================
alter table public.projects          enable row level security;
alter table public.phases            enable row level security;
alter table public.workflow_outputs  enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='projects'
      and policyname='projects_default_deny'
  ) then
    create policy projects_default_deny on public.projects
      as restrictive for all to public using (false);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='phases'
      and policyname='phases_default_deny'
  ) then
    create policy phases_default_deny on public.phases
      as restrictive for all to public using (false);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='workflow_outputs'
      and policyname='workflow_outputs_default_deny'
  ) then
    create policy workflow_outputs_default_deny on public.workflow_outputs
      as restrictive for all to public using (false);
  end if;
end $$;

commit;
