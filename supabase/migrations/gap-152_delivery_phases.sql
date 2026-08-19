-- GAP-152: 段階的フェーズ (経営者すり合わせ 2026-08-18)
--
--   「スナップショットもだし、段階的にフェーズとして進める。成果物は確定的に
--    なればそれ以上の追加はつけられない。追加は次フェーズ (フェーズ2以降) でやる。
--    プロジェクト内でも切り替えられたら。追加の見積もりを分けて考慮できるし、
--    開発も追加分の依存やタスクを分けて考えられる」
--
-- 設計:
--   - delivery_phases = 納品単位のフェーズ (フェーズ1, 2, …)。既存の phases
--     テーブル (工程 = hearing/要件定義…) とは別概念なので新設する。
--   - 各プロジェクトに active はちょうど 1 つ (partial unique)。確定 (freeze) で
--     frozen になり、次フェーズが active として作られる。
--   - 成果物 (workflow_outputs)・モック (mocks)・タスク (tasks)・フロー
--     (project_flow_stages) は作成時に active フェーズをスタンプ。凍結後の
--     フェーズには新規行が入らない (スタンプは常に active) = スナップショット。
--   - フローはフェーズごとに 1 周 (project_flow_stages の一意キーを
--     (project, phase, stage) に変更)。

create table if not exists public.delivery_phases (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  seq         integer not null check (seq >= 1),
  name        text not null check (char_length(name) between 1 and 100),
  status      text not null default 'active' check (status in ('active', 'frozen')),
  note        text,
  frozen_at   timestamptz,
  frozen_by   uuid references public.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id, seq)
);

comment on table public.delivery_phases is
  'GAP-152: 納品単位のフェーズ (フェーズ1..N)。frozen = 確定済み (成果物凍結)。工程 (phases) とは別概念。';

-- active はプロジェクトにちょうど 1 つ
create unique index if not exists delivery_phases_active_uq
  on public.delivery_phases (project_id) where status = 'active';

alter table public.delivery_phases enable row level security;

drop policy if exists delivery_phases_select_member on public.delivery_phases;
create policy delivery_phases_select_member on public.delivery_phases
  for select to authenticated
  using (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

drop policy if exists delivery_phases_insert_member on public.delivery_phases;
create policy delivery_phases_insert_member on public.delivery_phases
  for insert to authenticated
  with check (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

drop policy if exists delivery_phases_update_member on public.delivery_phases;
create policy delivery_phases_update_member on public.delivery_phases
  for update to authenticated
  using (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  )
  with check (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

-- 削除は履歴 (確定スナップショット) の改竄になるため member には出さない
drop policy if exists delivery_phases_no_delete on public.delivery_phases;
create policy delivery_phases_no_delete on public.delivery_phases
  as restrictive for delete to authenticated
  using (false);

-- ── フェーズ紐付け列 ────────────────────────────────────────────────
alter table public.mocks
  add column if not exists delivery_phase_id uuid references public.delivery_phases(id) on delete set null;
alter table public.workflow_outputs
  add column if not exists delivery_phase_id uuid references public.delivery_phases(id) on delete set null;
alter table public.tasks
  add column if not exists delivery_phase_id uuid references public.delivery_phases(id) on delete set null;
alter table public.project_flow_stages
  add column if not exists delivery_phase_id uuid references public.delivery_phases(id) on delete set null;

create index if not exists mocks_delivery_phase_idx on public.mocks (delivery_phase_id);
create index if not exists workflow_outputs_delivery_phase_idx on public.workflow_outputs (delivery_phase_id);
create index if not exists tasks_delivery_phase_idx on public.tasks (delivery_phase_id);

-- ── 既存データの backfill: 全プロジェクトにフェーズ1 (active) を用意し、
--    既存の成果物・モック・タスク・フローをフェーズ1 に帰属させる ─────
insert into public.delivery_phases (project_id, seq, name, status)
select p.id, 1, 'フェーズ1', 'active'
from public.projects p
where not exists (select 1 from public.delivery_phases dp where dp.project_id = p.id);

update public.project_flow_stages fs
set delivery_phase_id = dp.id
from public.delivery_phases dp
where dp.project_id = fs.project_id and dp.seq = 1 and fs.delivery_phase_id is null;

update public.mocks m
set delivery_phase_id = dp.id
from public.delivery_phases dp
where dp.project_id = m.project_id and dp.seq = 1 and m.delivery_phase_id is null;

update public.workflow_outputs wo
set delivery_phase_id = dp.id
from public.delivery_phases dp
where dp.project_id = wo.project_id and dp.seq = 1 and wo.delivery_phase_id is null;

update public.tasks t
set delivery_phase_id = dp.id
from public.delivery_phases dp
where dp.project_id = t.project_id and dp.seq = 1 and t.delivery_phase_id is null;

-- ── フローの一意キーをフェーズ内スコープへ (フェーズごとに 1 周) ─────
alter table public.project_flow_stages alter column delivery_phase_id set not null;
alter table public.project_flow_stages
  drop constraint if exists project_flow_stages_project_id_seq_key;
alter table public.project_flow_stages
  drop constraint if exists project_flow_stages_project_id_stage_key_key;
create unique index if not exists project_flow_stages_phase_seq_uq
  on public.project_flow_stages (project_id, delivery_phase_id, seq);
create unique index if not exists project_flow_stages_phase_stage_uq
  on public.project_flow_stages (project_id, delivery_phase_id, stage_key);
