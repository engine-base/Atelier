-- T-D-101: decisions (S-F01 確定事項 / 未確認タブのバックエンド)
--
-- 信頼源: 06_mockups/workflow/S-F01-flow.html (確定事項 / 未確認タブ)
-- 背景: モック S-F01 は工程ごとの「確定事項」(decision log) と「未確認」
--   (未解決事項) を主コンテンツとするが、対応するエンティティが存在せず
--   フロントが配線できなかった (design-audit ラウンド1で判明した gap)。
-- 設計:
--   - status='decided'    : 確定事項。reflected_to に反映先を記録
--   - status='unresolved' : 未確認事項。resolve_note に解決予定フェーズ/時期を記録
--   - decided_by は AI 社員 (nullable)。with_user=true は「+ あなた」表示
--   - project_id → workspace_scoped RLS (workflow_outputs と同型)

begin;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'decision_status_enum') then
    create type public.decision_status_enum as enum ('decided', 'unresolved');
  end if;
end $$;

create table if not exists public.decisions (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  phase_id      uuid references public.phases(id) on delete set null,
  status        public.decision_status_enum not null default 'decided',
  body          text not null,
  reflected_to  text,
  resolve_note  text,
  decided_by    uuid references public.ai_employees(id) on delete set null,
  with_user     boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint decisions_body_length check (char_length(body) between 1 and 2000)
);

comment on table public.decisions is
  'S-F01 確定事項/未確認。工程ごとの decision log (status=decided) と未解決事項 (status=unresolved)。';
comment on column public.decisions.reflected_to is
  '確定事項の反映先 (例: screens.json · functional-breakdown.html)';
comment on column public.decisions.resolve_note is
  '未確認事項の解決予定 (例: 解決すべきフェーズ: product-strategy)';

create index if not exists decisions_project_phase_idx
  on public.decisions (project_id, phase_id, created_at desc)
  where deleted_at is null;

-- ============================================================================
-- RLS (workflow_outputs と同型: project_id → workspace_scoped)
-- ============================================================================
alter table public.decisions enable row level security;

drop policy if exists decisions_select_member on public.decisions;
drop policy if exists decisions_insert_member on public.decisions;
drop policy if exists decisions_update_member on public.decisions;
drop policy if exists decisions_delete_owner on public.decisions;

create policy decisions_select_member on public.decisions
  for select
  to authenticated
  using (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

create policy decisions_insert_member on public.decisions
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = decisions.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy decisions_update_member on public.decisions
  for update
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = decisions.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = decisions.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy decisions_delete_owner on public.decisions
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = decisions.project_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

grant select, insert, update, delete on public.decisions to authenticated;

commit;
