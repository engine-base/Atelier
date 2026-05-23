-- T-D-21: RLS policies for ai_employees / ai_employee_templates / skills /
--          phases / workflow_outputs (E-007, E-008, E-009, E-005, E-006)
--
-- 信頼源: 04_functional_breakdown/entities.json
-- 関連: R-T08 (致命級 越境試験)
-- 依存: T-D-03 (ai_employees/templates/skills 配置済), T-D-14 (current_user_workspaces)
--       T-D-02 (phases/workflow_outputs 配置済、default-deny は T-D-02 で設置)
--
-- 設計:
--
-- E-007 ai_employees (workspace_scoped):
--   - SELECT: workspace member
--   - INSERT/UPDATE: workspace owner/member (viewer 不可)
--   - DELETE: workspace owner のみ
--
-- E-008 ai_employee_templates (global, admin only):
--   - SELECT: all authenticated (template は読み取り共有)
--   - INSERT/UPDATE/DELETE: deny — service_role bypass 経由のみ (admin オペレーション)
--
-- E-009 skills (global, admin only):
--   - SELECT: all authenticated (skills は読み取り共有)
--   - INSERT/UPDATE/DELETE: deny — service_role bypass 経由のみ
--
-- E-005 phases (project_id → workspace_scoped):
--   - SELECT: workspace member
--   - INSERT/UPDATE: workspace owner/member
--   - DELETE: workspace owner のみ
--
-- E-006 workflow_outputs (project_id → workspace_scoped, soft_delete):
--   - SELECT: workspace member
--   - INSERT/UPDATE: workspace owner/member
--   - DELETE: workspace owner のみ
--
-- R-T08 致命級: scripts/verify_rls_isolation.py パターンで越境試験を別途実施。

begin;

-- =============================================================================
-- E-007 ai_employees (workspace_scoped)
-- =============================================================================
drop policy if exists ai_employees_default_deny on public.ai_employees;
drop policy if exists ai_employees_select_member on public.ai_employees;
drop policy if exists ai_employees_insert_member on public.ai_employees;
drop policy if exists ai_employees_update_member on public.ai_employees;
drop policy if exists ai_employees_delete_owner on public.ai_employees;

create policy ai_employees_select_member on public.ai_employees
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspaces()));

create policy ai_employees_insert_member on public.ai_employees
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = ai_employees.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy ai_employees_update_member on public.ai_employees
  for update
  to authenticated
  using (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = ai_employees.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = ai_employees.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy ai_employees_delete_owner on public.ai_employees
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = ai_employees.workspace_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- =============================================================================
-- E-008 ai_employee_templates (global, admin only)
--   読み: 全 authenticated 可 (template 一覧表示用)
--   書き: deny → service_role bypass 経由のみ
-- =============================================================================
drop policy if exists ai_employee_templates_default_deny on public.ai_employee_templates;
drop policy if exists ai_employee_templates_select_all on public.ai_employee_templates;
drop policy if exists ai_employee_templates_no_insert on public.ai_employee_templates;
drop policy if exists ai_employee_templates_no_update on public.ai_employee_templates;
drop policy if exists ai_employee_templates_no_delete on public.ai_employee_templates;

create policy ai_employee_templates_select_all on public.ai_employee_templates
  for select
  to authenticated
  using (true);

-- 書き込み禁止 (admin/service_role bypass のみ)
create policy ai_employee_templates_no_insert on public.ai_employee_templates
  as restrictive
  for insert
  to authenticated
  with check (false);

create policy ai_employee_templates_no_update on public.ai_employee_templates
  as restrictive
  for update
  to authenticated
  using (false)
  with check (false);

create policy ai_employee_templates_no_delete on public.ai_employee_templates
  as restrictive
  for delete
  to authenticated
  using (false);

-- =============================================================================
-- E-009 skills (global, admin only)
--   読み: 全 authenticated 可
--   書き: deny → service_role bypass 経由のみ
-- =============================================================================
drop policy if exists skills_default_deny on public.skills;
drop policy if exists skills_select_all on public.skills;
drop policy if exists skills_no_insert on public.skills;
drop policy if exists skills_no_update on public.skills;
drop policy if exists skills_no_delete on public.skills;

create policy skills_select_all on public.skills
  for select
  to authenticated
  using (true);

create policy skills_no_insert on public.skills
  as restrictive
  for insert
  to authenticated
  with check (false);

create policy skills_no_update on public.skills
  as restrictive
  for update
  to authenticated
  using (false)
  with check (false);

create policy skills_no_delete on public.skills
  as restrictive
  for delete
  to authenticated
  using (false);

-- =============================================================================
-- E-005 phases (project_id → workspace_scoped)
-- =============================================================================
drop policy if exists phases_default_deny on public.phases;
drop policy if exists phases_select_member on public.phases;
drop policy if exists phases_insert_member on public.phases;
drop policy if exists phases_update_member on public.phases;
drop policy if exists phases_delete_owner on public.phases;

create policy phases_select_member on public.phases
  for select
  to authenticated
  using (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

create policy phases_insert_member on public.phases
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = phases.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy phases_update_member on public.phases
  for update
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = phases.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = phases.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy phases_delete_owner on public.phases
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = phases.project_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- =============================================================================
-- E-006 workflow_outputs (project_id → workspace_scoped)
-- =============================================================================
drop policy if exists workflow_outputs_default_deny on public.workflow_outputs;
drop policy if exists workflow_outputs_select_member on public.workflow_outputs;
drop policy if exists workflow_outputs_insert_member on public.workflow_outputs;
drop policy if exists workflow_outputs_update_member on public.workflow_outputs;
drop policy if exists workflow_outputs_delete_owner on public.workflow_outputs;

create policy workflow_outputs_select_member on public.workflow_outputs
  for select
  to authenticated
  using (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

create policy workflow_outputs_insert_member on public.workflow_outputs
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = workflow_outputs.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy workflow_outputs_update_member on public.workflow_outputs
  for update
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = workflow_outputs.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = workflow_outputs.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy workflow_outputs_delete_owner on public.workflow_outputs
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = workflow_outputs.project_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

commit;
