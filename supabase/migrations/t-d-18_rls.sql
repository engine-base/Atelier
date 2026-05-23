-- T-D-18: RLS policies for knowledge_nodes (E-018)
--
-- 信頼源: 04_functional_breakdown/entities.json#E-018
-- 関連: F-K01 (Knowledge Base / RAG), R-T08 (致命級)
-- 依存: T-D-09 (knowledge_nodes table 配置済), T-D-14 (current_user_workspaces helper)
--
-- 設計:
--   knowledge_nodes は polymorphic account:
--     account_type='workspace' → account_id = workspaces.id
--     account_type='user'      → account_id = users.id (個人用 knowledge)
--   さらに scope:
--     scope='common'           → account 全員共有
--     scope='employee_specific' → 特定 ai_employee 用 (owner_employee_id 必須)
--
-- Policy 設計:
--   - SELECT/INSERT/UPDATE: user_can_see_knowledge_node() helper で判定
--     * account_type='user' なら account_id = auth.uid()
--     * account_type='workspace' なら workspace member 必須
--       (common / employee_specific 両方とも workspace member 全員 可視。
--        scope=employee_specific は ai_employee の knowledge であり workspace
--        member が ai_employee と対話するため、見える前提でよい)
--   - INSERT: 上記 + workspace は member 以上 (viewer 不可)、user は self のみ
--   - DELETE: workspace owner OR self user
--
-- R-T08 要件: workspace A の user が workspace B の knowledge_nodes を query
-- → 0 rows を実 PostgREST + JWT 検証で verify (scripts/verify_rls_isolation.py)

begin;

-- =============================================================================
-- Helper: knowledge_node が現ユーザーに可視か判定
-- =============================================================================
create or replace function public.user_can_see_knowledge_node(
  p_account_type text,
  p_account_id uuid
)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_catalog
as $$
begin
  if p_account_type = 'user' then
    return p_account_id = auth.uid();
  elsif p_account_type = 'workspace' then
    return exists (
      select 1 from public.workspace_memberships
      where workspace_id = p_account_id
        and user_id = auth.uid()
    );
  end if;
  return false;
end;
$$;

comment on function public.user_can_see_knowledge_node(text, uuid) is
  'RLS helper: knowledge_node が現ユーザーに可視か判定。
   account_type=user は self、account_type=workspace は member であれば true。
   SECURITY DEFINER で workspace_memberships への循環参照を回避。';

revoke all on function public.user_can_see_knowledge_node(text, uuid) from public;
grant execute on function public.user_can_see_knowledge_node(text, uuid) to authenticated;

-- =============================================================================
-- Helper: workspace knowledge を write 可能か (member 以上 role)
-- =============================================================================
create or replace function public.user_can_write_knowledge_node(
  p_account_type text,
  p_account_id uuid
)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_catalog
as $$
begin
  if p_account_type = 'user' then
    return p_account_id = auth.uid();
  elsif p_account_type = 'workspace' then
    return exists (
      select 1 from public.workspace_memberships
      where workspace_id = p_account_id
        and user_id = auth.uid()
        and role in ('owner', 'member')
    );
  end if;
  return false;
end;
$$;

comment on function public.user_can_write_knowledge_node(text, uuid) is
  'RLS helper: knowledge_node を write (INSERT/UPDATE) 可能か判定。
   workspace は owner/member role 必須 (viewer 不可)、user は self のみ。';

revoke all on function public.user_can_write_knowledge_node(text, uuid) from public;
grant execute on function public.user_can_write_knowledge_node(text, uuid) to authenticated;

-- =============================================================================
-- Helper: workspace knowledge を delete 可能か (owner role only)
-- =============================================================================
create or replace function public.user_can_delete_knowledge_node(
  p_account_type text,
  p_account_id uuid
)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_catalog
as $$
begin
  if p_account_type = 'user' then
    return p_account_id = auth.uid();
  elsif p_account_type = 'workspace' then
    return exists (
      select 1 from public.workspace_memberships
      where workspace_id = p_account_id
        and user_id = auth.uid()
        and role = 'owner'
    );
  end if;
  return false;
end;
$$;

comment on function public.user_can_delete_knowledge_node(text, uuid) is
  'RLS helper: knowledge_node を delete 可能か判定。
   workspace は owner role 必須 (破壊的なので)、user は self のみ。';

revoke all on function public.user_can_delete_knowledge_node(text, uuid) from public;
grant execute on function public.user_can_delete_knowledge_node(text, uuid) to authenticated;

-- =============================================================================
-- knowledge_nodes RLS: default-deny を DROP し実 policy に置換
-- =============================================================================
drop policy if exists knowledge_nodes_default_deny on public.knowledge_nodes;
drop policy if exists knowledge_nodes_select on public.knowledge_nodes;
drop policy if exists knowledge_nodes_insert on public.knowledge_nodes;
drop policy if exists knowledge_nodes_update on public.knowledge_nodes;
drop policy if exists knowledge_nodes_delete on public.knowledge_nodes;

-- SELECT: account_type に応じて self or workspace member
create policy knowledge_nodes_select on public.knowledge_nodes
  for select
  to authenticated
  using (public.user_can_see_knowledge_node(account_type::text, account_id));

-- INSERT: workspace は member 以上、user は self
create policy knowledge_nodes_insert on public.knowledge_nodes
  for insert
  to authenticated
  with check (public.user_can_write_knowledge_node(account_type::text, account_id));

-- UPDATE: write 権限と同じ + 自分の write 権限を維持する更新のみ許可
create policy knowledge_nodes_update on public.knowledge_nodes
  for update
  to authenticated
  using (public.user_can_write_knowledge_node(account_type::text, account_id))
  with check (public.user_can_write_knowledge_node(account_type::text, account_id));

-- DELETE: workspace owner OR self
create policy knowledge_nodes_delete on public.knowledge_nodes
  for delete
  to authenticated
  using (public.user_can_delete_knowledge_node(account_type::text, account_id));

commit;
