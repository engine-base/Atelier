-- T-D-96: cron_schedules — authenticated 向け RLS policy (T-A-40 の欠落補完)
--
-- 信頼源: 04_functional_breakdown/entities.json (project_scoped) + R-T08
-- 背景: 実DB検証 (apps/web/.qa/RESULTS-2026-07-04-realdb.md) で cron_schedules が
--   default_deny のみで authenticated policy が存在せず、API (get_rls_session 経由) の
--   CRUD が全て RLS 違反になることが発覚 (test_cron ×5)。
-- パターンは tasks (t-d-16_rls.sql) の project 経由 workspace membership を踏襲。
--
-- Idempotency: drop policy if exists → create。

begin;

-- restrictive な default_deny を撤去 (permissive policy 追加に伴い他テーブルの house パターンに合わせる)
drop policy if exists cron_schedules_default_deny on public.cron_schedules;

drop policy if exists cron_schedules_select_member on public.cron_schedules;
drop policy if exists cron_schedules_insert_member on public.cron_schedules;
drop policy if exists cron_schedules_update_member on public.cron_schedules;
drop policy if exists cron_schedules_delete_member on public.cron_schedules;
drop policy if exists cron_schedules_delete_owner on public.cron_schedules;

-- SELECT: workspace member 全員可
create policy cron_schedules_select_member on public.cron_schedules
  for select
  to authenticated
  using (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

-- INSERT / UPDATE / DELETE: workspace owner / member 限定 (viewer 不可)
create policy cron_schedules_insert_member on public.cron_schedules
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = cron_schedules.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy cron_schedules_update_member on public.cron_schedules
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = cron_schedules.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1
      from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = cron_schedules.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

-- DELETE: owner 限定 (member の delete は 0 行 → route が 403 を返す)
create policy cron_schedules_delete_owner on public.cron_schedules
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = cron_schedules.project_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

commit;
