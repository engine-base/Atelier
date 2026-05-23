-- T-D-15: RLS policies for workspaces / projects (E-002, E-004)
--
-- 信頼源: 04_functional_breakdown/entities.json
-- 関連: F-002 (project), F-003 (workspace), R-T08 (致命級)
-- 依存: T-D-14 (current_user_workspaces() helper 配置済)
--
-- 設計:
--   - workspaces (E-002 account_scoped):
--     SELECT: 自分が所属する workspace のみ
--     INSERT: authenticated user は誰でも (signup 直後の workspace 作成)、
--             ただし owner_user_id = auth.uid() の WITH CHECK で自己制限
--     UPDATE: workspace owner role のみ可
--     DELETE: workspace owner role のみ可 (退会時の workspace 廃止)
--   - projects (E-004 workspace_scoped):
--     SELECT/INSERT/UPDATE/DELETE: workspace member ならアクセス可 (role 細分は
--       Wave 2 で T-A-XX 側の業務 role policy で実施)
--
-- Helper:
--   current_user_workspaces() (T-D-14 で配置済) を再利用。
--   workspace owner 判定は workspace_memberships に直接 JOIN。

begin;

-- =============================================================================
-- E-002 workspaces: default-deny を DROP し account-scoped policies に置換
-- =============================================================================
drop policy if exists workspaces_default_deny on public.workspaces;
drop policy if exists workspaces_select_member on public.workspaces;
drop policy if exists workspaces_insert_self on public.workspaces;
drop policy if exists workspaces_update_owner on public.workspaces;
drop policy if exists workspaces_delete_owner on public.workspaces;

-- SELECT: 自分が所属する workspace のみ閲覧可
create policy workspaces_select_member on public.workspaces
  for select
  to authenticated
  using (id in (select public.current_user_workspaces()));

-- INSERT: authenticated user は workspace 作成可 (owner_user_id = auth.uid())
create policy workspaces_insert_self on public.workspaces
  for insert
  to authenticated
  with check (owner_user_id = auth.uid());

-- UPDATE: workspace owner role のみ可
create policy workspaces_update_owner on public.workspaces
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.workspace_memberships m
      where m.workspace_id = workspaces.id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  )
  with check (
    exists (
      select 1
      from public.workspace_memberships m
      where m.workspace_id = workspaces.id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- DELETE: workspace owner role のみ可
create policy workspaces_delete_owner on public.workspaces
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.workspace_memberships m
      where m.workspace_id = workspaces.id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- =============================================================================
-- E-004 projects: default-deny を DROP し workspace-scoped policies に置換
-- =============================================================================
drop policy if exists projects_default_deny on public.projects;
drop policy if exists projects_select_member on public.projects;
drop policy if exists projects_insert_member on public.projects;
drop policy if exists projects_update_member on public.projects;
drop policy if exists projects_delete_owner on public.projects;

-- SELECT: workspace member は全 project 閲覧可
create policy projects_select_member on public.projects
  for select
  to authenticated
  using (workspace_id in (select public.current_user_workspaces()));

-- INSERT: workspace member (owner / member、viewer は不可)
create policy projects_insert_member on public.projects
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.workspace_memberships m
      where m.workspace_id = projects.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

-- UPDATE: workspace member (owner / member) は project 編集可
create policy projects_update_member on public.projects
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.workspace_memberships m
      where m.workspace_id = projects.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1
      from public.workspace_memberships m
      where m.workspace_id = projects.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

-- DELETE: workspace owner のみ可 (project 削除は破壊的なので owner 限定)
create policy projects_delete_owner on public.projects
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.workspace_memberships m
      where m.workspace_id = projects.workspace_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

commit;
