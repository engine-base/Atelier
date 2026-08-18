-- GAP-150: プロジェクトフロー (COO ハブ&スポーク / ステージゲート)
--
-- 経営者承認済み設計:
--   - 案件は決まったフロー (ヒアリング → 提案 → … → 納品) で進むのが基本。
--     「どの社員とも自由に話す」ではなく、COO (executive) が窓口となり
--     現在ステージの担当社員へ繋ぐ・引き継ぐ・完了で戻す。
--   - 強制はソフトゲート (順序外は警告 + 理由付きで越えられる) を既定とし、
--     致命工程 (契約・納品) のみハードゲート (ユーザー確認なしで完了不可)。
--   - スキップ可の工程は理由を記録して飛ばせる (黙って消さない)。
--
-- 状態は最小 3 値 (pending / done / skipped)。「現在のステージ」は
-- 最小 seq の pending として導出する — 遷移状態を持たないことで
-- 差し戻し (done → pending) も単純な update で整合する。

create table if not exists public.project_flow_stages (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  stage_key    text not null,
  seq          integer not null check (seq >= 1),
  title        text not null,
  department   public.ai_employee_department_enum not null,
  status       text not null default 'pending' check (status in ('pending', 'done', 'skipped')),
  skippable    boolean not null default false,
  hard_gate    boolean not null default false,
  skip_reason  text,
  completed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (project_id, stage_key),
  unique (project_id, seq)
);

comment on table public.project_flow_stages is
  'GAP-150: プロジェクト進行フローのステージ。現在ステージ = 最小 seq の pending。';
comment on column public.project_flow_stages.hard_gate is
  '致命工程 (契約・納品等)。完了にユーザーの明示確認 (confirm=true) が必須。スキップ不可。';

create index if not exists project_flow_stages_project_idx
  on public.project_flow_stages (project_id, seq);

alter table public.project_flow_stages enable row level security;

drop policy if exists project_flow_select_member on public.project_flow_stages;
create policy project_flow_select_member on public.project_flow_stages
  for select to authenticated
  using (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

drop policy if exists project_flow_insert_member on public.project_flow_stages;
create policy project_flow_insert_member on public.project_flow_stages
  for insert to authenticated
  with check (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

drop policy if exists project_flow_update_member on public.project_flow_stages;
create policy project_flow_update_member on public.project_flow_stages
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

-- 削除はフローの改竄になるため member には出さない (service 経路のみ)
drop policy if exists project_flow_no_delete on public.project_flow_stages;
create policy project_flow_no_delete on public.project_flow_stages
  as restrictive for delete to authenticated
  using (false);
