-- =============================================================================
-- GAP-273 (通し J36-07 / G-14): 削除済み (deleted_at) のワークスペース配下は
-- 全経路で見えない・触れない。
--
-- これまで current_user_workspaces() は membership だけを見ていたため、WS を
-- 削除 (soft-delete) しても配下の projects / ai_employees / tasks … は
-- 58 本の RLS policy すべてで「所属 WS」として通り続け、一覧・詳細が 200 で
-- 読めた。helper 1 か所で workspaces.deleted_at を見れば全 policy に効く。
--
-- 復元 (30 日以内) は owner_user_id 経由の別経路で扱う (この helper を通さない)。
-- =============================================================================
begin;

create or replace function public.current_user_workspaces()
returns setof uuid
language sql
security definer
stable
set search_path = public, pg_catalog
as $$
  select m.workspace_id
  from public.workspace_memberships m
  join public.workspaces w on w.id = m.workspace_id and w.deleted_at is null
  where m.user_id = auth.uid()
$$;

comment on function public.current_user_workspaces() is
  'RLS helper: 現ユーザー (auth.uid()) が所属する **削除されていない** workspace_id 集合。
   SECURITY DEFINER で循環参照を回避。R-T08 致命級設計。GAP-273 で deleted_at を除外。';

revoke all on function public.current_user_workspaces() from public;
grant execute on function public.current_user_workspaces() to authenticated;

commit;
