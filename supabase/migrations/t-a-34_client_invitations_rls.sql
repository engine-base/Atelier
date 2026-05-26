-- T-A-34: client_invitations — members 管理用 RLS policy
--
-- 信頼源: 04_functional_breakdown/entities.json#E-017 + R-T08
-- 背景: client_invitations は T-D-08 で default-deny のみ配置され、authenticated 向け
--   permissive policy が無いため workspace member が招待を管理できない。
--   本 migration で「自 project (= 所属 workspace の project) の招待を CRUD 可」を付与する。
--   クライアント本人経路 (invitation_token_hash claim) の policy は T-D-22 (致命級) 側。
--
-- Idempotency: drop policy if exists → create。

begin;

-- 所属 workspace の project に紐づく招待か (SELECT 可視範囲)
drop policy if exists client_invitations_default_deny on public.client_invitations;
drop policy if exists client_invitations_member_select on public.client_invitations;
drop policy if exists client_invitations_member_insert on public.client_invitations;
drop policy if exists client_invitations_member_update on public.client_invitations;
drop policy if exists client_invitations_member_delete on public.client_invitations;

create policy client_invitations_member_select on public.client_invitations
  for select to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = client_invitations.project_id
        and p.workspace_id in (select public.current_user_workspaces())
    )
  );

-- 作成/更新/削除は workspace owner/member (viewer 不可)
create policy client_invitations_member_insert on public.client_invitations
  for insert to authenticated
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = client_invitations.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy client_invitations_member_update on public.client_invitations
  for update to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = client_invitations.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = client_invitations.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy client_invitations_member_delete on public.client_invitations
  for delete to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = client_invitations.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

commit;
