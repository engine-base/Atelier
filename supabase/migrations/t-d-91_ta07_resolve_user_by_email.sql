-- T-A-07: WS メンバー管理の前提 helper 関数
--
-- 背景: users の RLS は users_select_self (自分のみ) のため、
--   (a) メンバー一覧で他メンバーの email/display_name が読めない
--   (b) 招待時に email から user_id を解決できない (未所属ユーザーは不可視)
--   この 2 つを membership-gated / 限定返却の SECURITY DEFINER 関数で解消する。
--
-- セキュリティ:
--   - workspace_member_details は「呼び出し元が当該 workspace の member」のときのみ
--     行を返す (current_user_workspaces() で gate)。非メンバーには 0 行。
--   - resolve_user_id_by_email は user_id (uuid) のみ返す (PII は返さない)。招待フローでのみ
--     呼ばれ、実際の membership 追加は RLS (owner) で別途 enforce される。
--
-- Idempotency: create or replace function。

begin;

-- ---------------------------------------------------------------------------
-- recursion fix: workspace_memberships の insert/update/delete policy が
-- workspace_memberships 自身を WITH CHECK/USING の副問合せで参照しており、
-- INSERT/UPDATE 時に "infinite recursion detected in policy" を起こす
-- (T-D-14 の既知バグ。bootstrap トリガは SECURITY DEFINER で回避していた)。
-- SECURITY DEFINER の is_workspace_owner() に置換して再帰を解消する (意味は不変)。
-- ---------------------------------------------------------------------------
create or replace function public.is_workspace_owner(p_workspace_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.workspace_memberships
    where workspace_id = p_workspace_id and user_id = auth.uid() and role = 'owner'
  )
$$;

grant execute on function public.is_workspace_owner(uuid) to authenticated;

drop policy if exists workspace_memberships_insert_owner on public.workspace_memberships;
create policy workspace_memberships_insert_owner on public.workspace_memberships
  for insert to authenticated
  with check (public.is_workspace_owner(workspace_id));

drop policy if exists workspace_memberships_update_owner on public.workspace_memberships;
create policy workspace_memberships_update_owner on public.workspace_memberships
  for update to authenticated
  using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

drop policy if exists workspace_memberships_delete_owner_or_self on public.workspace_memberships;
create policy workspace_memberships_delete_owner_or_self on public.workspace_memberships
  for delete to authenticated
  using (user_id = auth.uid() or public.is_workspace_owner(workspace_id));

create or replace function public.workspace_member_details(p_workspace_id uuid)
returns table (
  user_id uuid,
  email text,
  display_name text,
  role public.workspace_member_role_enum,
  joined_at timestamptz
)
language sql
security definer
stable
set search_path = public, pg_catalog
as $$
  select m.user_id, u.email, u.display_name, m.role, m.joined_at
  from public.workspace_memberships m
  join public.users u on u.id = m.user_id
  where m.workspace_id = p_workspace_id
    and p_workspace_id in (select public.current_user_workspaces())
  order by m.joined_at
$$;

comment on function public.workspace_member_details(uuid) is
  'T-A-07: 呼び出し元が member の workspace のメンバー詳細 (email/name/role) を返す。'
  ' users RLS (self-only) を definer で回避するが workspace membership で gate。';

create or replace function public.resolve_user_id_by_email(p_email text)
returns uuid
language sql
security definer
stable
set search_path = public, pg_catalog
as $$
  select id from public.users where email = p_email and deleted_at is null limit 1
$$;

comment on function public.resolve_user_id_by_email(text) is
  'T-A-07: 招待 (email) → user_id 解決用。user_id のみ返す。membership 追加は RLS(owner) で enforce。';

grant execute on function public.workspace_member_details(uuid) to authenticated;
grant execute on function public.resolve_user_id_by_email(text) to authenticated;

commit;
