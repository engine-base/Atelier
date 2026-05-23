-- T-D-14: RLS policies for users / workspace_memberships (E-001, E-003)
--
-- 信頼源: 04_functional_breakdown/entities.json + R-T08 (致命級)
-- 関連: F-001 (workspace 基盤), R-T08 (クライアント別 JWT 完全分離)
-- 依存: T-D-01 (default-deny policy 配置済)
--
-- 設計:
--   - users (E-001 self-scoped): auth.uid() = id で完全 self-scoped
--   - workspace_memberships (E-003 workspace_scoped):
--     - SELECT: 自分が所属する workspace の全 membership 可視
--     - INSERT/UPDATE/DELETE: workspace owner role のみ可、self DELETE は許可
--
-- セキュリティ:
--   - SECURITY DEFINER helper function で recursive policy を回避
--   - auth.uid() = null (anon role) は全 deny (default-deny で担保)
--   - UNWANTED 検証: workspace A user → workspace B membership 0 rows

begin;

-- =============================================================================
-- Helper: 現ユーザーが所属する workspace_id 集合を返す
--   SECURITY DEFINER + STABLE で RLS evaluation 中の循環参照を回避。
--   workspace_memberships への直接 query が RLS policy 内で展開されると
--   無限ループになるため、definer 関数でバイパスする (RLS bypass は本関数内のみ)。
-- =============================================================================
create or replace function public.current_user_workspaces()
returns setof uuid
language sql
security definer
stable
set search_path = public, pg_catalog
as $$
  select workspace_id
  from public.workspace_memberships
  where user_id = auth.uid()
$$;

comment on function public.current_user_workspaces() is
  'RLS helper: 現ユーザー (auth.uid()) が所属する workspace_id 集合を返す。
   SECURITY DEFINER で循環参照を回避。R-T08 致命級設計。';

-- helper は authenticated role のみ実行可
revoke all on function public.current_user_workspaces() from public;
grant execute on function public.current_user_workspaces() to authenticated;

-- =============================================================================
-- E-001 users: default-deny を DROP し、self-scoped policies に置換
-- (idempotency: 全 policy を DROP IF EXISTS してから再 CREATE)
-- =============================================================================
drop policy if exists users_default_deny on public.users;
drop policy if exists users_select_self on public.users;
drop policy if exists users_insert_self on public.users;
drop policy if exists users_update_self on public.users;
drop policy if exists users_delete_self on public.users;

-- SELECT: 自分自身のみ (entities.json#E-001 "self-scoped" 厳守)
create policy users_select_self on public.users
  for select
  to authenticated
  using (auth.uid() = id);

-- INSERT: auth signup 時に user 自身が自分の row を作成
create policy users_insert_self on public.users
  for insert
  to authenticated
  with check (auth.uid() = id);

-- UPDATE: 自分の row のみ更新可
create policy users_update_self on public.users
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- DELETE: 自分のアカウントのみ削除可 (退会フロー、F-LEGAL-002)
create policy users_delete_self on public.users
  for delete
  to authenticated
  using (auth.uid() = id);

-- =============================================================================
-- E-003 workspace_memberships: default-deny を DROP し workspace-scoped に置換
-- (idempotency)
-- =============================================================================
drop policy if exists workspace_memberships_default_deny on public.workspace_memberships;
drop policy if exists workspace_memberships_select on public.workspace_memberships;
drop policy if exists workspace_memberships_insert_owner on public.workspace_memberships;
drop policy if exists workspace_memberships_update_owner on public.workspace_memberships;
drop policy if exists workspace_memberships_delete_owner_or_self on public.workspace_memberships;

-- SELECT: 自分が所属する workspace の全 membership を閲覧可
--   (workspace 内のメンバーは互いの存在を見られる)
create policy workspace_memberships_select on public.workspace_memberships
  for select
  to authenticated
  using (
    workspace_id in (select public.current_user_workspaces())
  );

-- INSERT: workspace owner のみメンバー追加可
create policy workspace_memberships_insert_owner on public.workspace_memberships
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.workspace_memberships m
      where m.workspace_id = workspace_memberships.workspace_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- UPDATE: workspace owner のみ role 変更可 (self update は禁止 — owner からの剥奪を防ぐ)
create policy workspace_memberships_update_owner on public.workspace_memberships
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.workspace_memberships m
      where m.workspace_id = workspace_memberships.workspace_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  )
  with check (
    exists (
      select 1
      from public.workspace_memberships m
      where m.workspace_id = workspace_memberships.workspace_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- DELETE: workspace owner OR self (退会)
create policy workspace_memberships_delete_owner_or_self on public.workspace_memberships
  for delete
  to authenticated
  using (
    user_id = auth.uid()  -- 自分の membership は削除可 (退会)
    or exists (
      select 1
      from public.workspace_memberships m
      where m.workspace_id = workspace_memberships.workspace_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

commit;
