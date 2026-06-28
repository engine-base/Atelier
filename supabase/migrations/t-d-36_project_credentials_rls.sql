-- T-D-36 (RLS): project_credentials の行レベルセキュリティ (致命: 越境=0)
--
-- 信頼源: docs/project-vault-design.md
-- tenant 経路: project_credentials → projects → workspace_memberships
-- Helper: current_user_workspaces() (T-D-14 で配置済) を再利用
--
-- 設計:
--   - SELECT: project の workspace member 全員可 (viewer 含む。値は API 層でマスク)
--   - INSERT/UPDATE: workspace owner / member (viewer 不可)
--   - DELETE: workspace owner のみ (破壊的)
--   service_role はバックエンド復号用に RLS をバイパス (role を下げない経路)。

begin;

-- default deny を明示 (RLS 有効 + policy 無し = 全拒否だが、意図を明示)
drop policy if exists project_credentials_select_member on public.project_credentials;
drop policy if exists project_credentials_insert_member on public.project_credentials;
drop policy if exists project_credentials_update_member on public.project_credentials;
drop policy if exists project_credentials_delete_owner on public.project_credentials;

-- SELECT: workspace member 全員 (project 経由)
create policy project_credentials_select_member on public.project_credentials
  for select
  to authenticated
  using (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

-- INSERT: workspace owner / member 限定
create policy project_credentials_insert_member on public.project_credentials
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = project_credentials.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

-- UPDATE: workspace owner / member 限定
create policy project_credentials_update_member on public.project_credentials
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = project_credentials.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1
      from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = project_credentials.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

-- DELETE: workspace owner のみ
create policy project_credentials_delete_owner on public.project_credentials
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = project_credentials.project_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

commit;
