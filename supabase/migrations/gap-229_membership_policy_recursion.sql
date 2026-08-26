-- GAP-229: workspace_memberships の書き込みポリシーが自己参照で必ず落ちる
--
-- 実測 (2026-08-26 / 通し J31-01「メンバーを招待する」):
--
--   insert into public.workspace_memberships ... (owner の RLS セッション)
--   → ERROR: infinite recursion detected in policy for relation "workspace_memberships"
--
-- **メンバー招待・ロール変更・メンバー削除が全滅**していた (画面は
-- 「サーバーでエラーが発生しました。」の 500)。環境依存ではなく Postgres の
-- 仕様による確定的な失敗なので、本番でも同じように落ちる。
--
-- 原因: INSERT/UPDATE/DELETE ポリシーの owner 判定が **同じ表への
-- インライン副問い合わせ** (from public.workspace_memberships m ...) だった。
-- 自分の表を参照するポリシーは、Postgres が再帰とみなして即エラーにする。
--
-- 皮肉なことに、同じファイル (t-d-14) の SELECT ポリシーは
-- current_user_workspaces() (SECURITY DEFINER) を使っていて、コメントに
-- 「workspace_memberships への直接 query が RLS policy 内で展開されると
--  再帰になる」と**理由まで書いてあった**。SELECT だけ直して、
-- 書き込み 3 本に同じ穴を残していた。
--
-- 修正: owner 判定を SECURITY DEFINER の関数に出す (SELECT と同じ手当て)。
-- 関数の所有者 (postgres) は RLS の対象外なので再帰しない。
-- **is_workspace_owner は t-d-15 で既に存在し、他の表のポリシーは全部これを
-- 使っていた** — workspace_memberships 自身のポリシーだけが使っていなかった。
-- 冪等: create or replace + drop/create policy。

begin;

create or replace function public.is_workspace_owner(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1
    from public.workspace_memberships
    where workspace_id = p_workspace_id
      and user_id = auth.uid()
      and role = 'owner'
  )
$$;

comment on function public.is_workspace_owner(uuid) is
  'GAP-229: RLS ポリシー内から workspace owner か判定する (SECURITY DEFINER で再帰回避)。';

revoke all on function public.is_workspace_owner(uuid) from public;
grant execute on function public.is_workspace_owner(uuid) to authenticated;

-- INSERT: workspace owner のみメンバー追加可
drop policy if exists workspace_memberships_insert_owner on public.workspace_memberships;
create policy workspace_memberships_insert_owner on public.workspace_memberships
  for insert
  to authenticated
  with check (public.is_workspace_owner(workspace_id));

-- UPDATE: workspace owner のみ role 変更可
drop policy if exists workspace_memberships_update_owner on public.workspace_memberships;
create policy workspace_memberships_update_owner on public.workspace_memberships
  for update
  to authenticated
  using (public.is_workspace_owner(workspace_id))
  with check (public.is_workspace_owner(workspace_id));

-- DELETE: workspace owner OR self (退会)
drop policy if exists workspace_memberships_delete_owner_or_self on public.workspace_memberships;
create policy workspace_memberships_delete_owner_or_self on public.workspace_memberships
  for delete
  to authenticated
  using (
    user_id = auth.uid()
    or public.is_workspace_owner(workspace_id)
  );

commit;
