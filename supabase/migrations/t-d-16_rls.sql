-- T-D-16: RLS policies for tasks / task_executions / acceptance_criteria
--          (E-012, E-013, E-014)
--
-- 信頼源: 04_functional_breakdown/entities.json
-- 関連: F-018 (Task 管理), R-T08 (致命級)
-- 依存: T-D-05 (tasks), T-D-06 (executions / acceptance_criteria)
--
-- 設計:
--   tenant 経路: tasks → projects → workspaces (project_id → workspace_id 経由で
--   workspace member 判定)。task_executions と acceptance_criteria は tasks 経由で
--   間接的に workspace 判定。
--
--   - SELECT: workspace member 全員可
--   - INSERT/UPDATE: workspace owner / member (viewer 不可)
--   - DELETE: workspace owner のみ (破壊的)
--
-- Helper: T-D-14 で配置済 current_user_workspaces() を再利用

begin;

-- =============================================================================
-- E-012 tasks (workspace_scoped via project_id)
-- =============================================================================
drop policy if exists tasks_default_deny on public.tasks;
drop policy if exists tasks_select_member on public.tasks;
drop policy if exists tasks_insert_member on public.tasks;
drop policy if exists tasks_update_member on public.tasks;
drop policy if exists tasks_delete_owner on public.tasks;

-- SELECT: workspace member 全員可 (task は project 経由で workspace と紐付く)
create policy tasks_select_member on public.tasks
  for select
  to authenticated
  using (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

-- INSERT: workspace owner / member 限定 (viewer 不可)
create policy tasks_insert_member on public.tasks
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = tasks.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

-- UPDATE: workspace owner / member 限定
create policy tasks_update_member on public.tasks
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = tasks.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1
      from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = tasks.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

-- DELETE: workspace owner のみ可
create policy tasks_delete_owner on public.tasks
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = tasks.project_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- =============================================================================
-- E-013 task_executions (workspace_scoped via tasks → projects)
-- task_executions は historical 履歴。append-only (UPDATE / DELETE は管理者用途)
-- =============================================================================
drop policy if exists task_executions_default_deny on public.task_executions;
drop policy if exists task_executions_select_member on public.task_executions;
drop policy if exists task_executions_insert_member on public.task_executions;
drop policy if exists task_executions_update_owner on public.task_executions;
drop policy if exists task_executions_delete_owner on public.task_executions;

-- SELECT: workspace member 全員可
create policy task_executions_select_member on public.task_executions
  for select
  to authenticated
  using (
    task_id in (
      select t.id from public.tasks t
      join public.projects p on p.id = t.project_id
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

-- INSERT: workspace owner / member (実行記録の追加)
create policy task_executions_insert_member on public.task_executions
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.tasks t
      join public.projects p on p.id = t.project_id
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where t.id = task_executions.task_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

-- UPDATE: workspace owner のみ (実行履歴の修正は管理権限)
create policy task_executions_update_owner on public.task_executions
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.tasks t
      join public.projects p on p.id = t.project_id
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where t.id = task_executions.task_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  )
  with check (
    exists (
      select 1
      from public.tasks t
      join public.projects p on p.id = t.project_id
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where t.id = task_executions.task_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- DELETE: workspace owner のみ (履歴削除は破壊的)
create policy task_executions_delete_owner on public.task_executions
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.tasks t
      join public.projects p on p.id = t.project_id
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where t.id = task_executions.task_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- =============================================================================
-- E-014 acceptance_criteria (workspace_scoped via tasks → projects)
-- =============================================================================
drop policy if exists acceptance_criteria_default_deny on public.acceptance_criteria;
drop policy if exists acceptance_criteria_select_member on public.acceptance_criteria;
drop policy if exists acceptance_criteria_insert_member on public.acceptance_criteria;
drop policy if exists acceptance_criteria_update_member on public.acceptance_criteria;
drop policy if exists acceptance_criteria_delete_owner on public.acceptance_criteria;

-- SELECT: workspace member 全員可
create policy acceptance_criteria_select_member on public.acceptance_criteria
  for select
  to authenticated
  using (
    task_id in (
      select t.id from public.tasks t
      join public.projects p on p.id = t.project_id
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

-- INSERT: workspace owner / member
create policy acceptance_criteria_insert_member on public.acceptance_criteria
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.tasks t
      join public.projects p on p.id = t.project_id
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where t.id = acceptance_criteria.task_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

-- UPDATE: workspace owner / member
create policy acceptance_criteria_update_member on public.acceptance_criteria
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.tasks t
      join public.projects p on p.id = t.project_id
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where t.id = acceptance_criteria.task_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1
      from public.tasks t
      join public.projects p on p.id = t.project_id
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where t.id = acceptance_criteria.task_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

-- DELETE: workspace owner のみ
create policy acceptance_criteria_delete_owner on public.acceptance_criteria
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.tasks t
      join public.projects p on p.id = t.project_id
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where t.id = acceptance_criteria.task_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

commit;
