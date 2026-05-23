-- T-D-17b: comments DELETE policy — owner moderation を本実装
--
-- T-D-17 で配置した comments_delete_self_or_owner policy には
-- `or exists (select 1 where false)` の placeholder が残っており、
-- workspace owner による moderation 機能がゼロ実装の状態だった。
--
-- 本 migration で:
--   1. user_is_comment_target_owner(target_type, target_id) helper を追加
--   2. comments_delete_self_or_owner policy を本実装に差し替え (DROP + CREATE)
--
-- セキュリティ: SECURITY DEFINER で target が指す workspace を解決し、
-- 現ユーザーがその workspace の 'owner' role であるか判定する。

begin;

-- =============================================================================
-- Helper: comment.target が指す workspace で現ユーザーが owner かを判定
-- =============================================================================
create or replace function public.user_is_comment_target_owner(
  p_target_type text,
  p_target_id uuid
)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_catalog
as $$
declare
  v_workspace_id uuid;
  v_is_owner boolean;
begin
  case p_target_type
    when 'workflow_output' then
      select p.workspace_id into v_workspace_id
      from public.workflow_outputs wo
      join public.projects p on p.id = wo.project_id
      where wo.id = p_target_id;
    when 'mock' then
      select p.workspace_id into v_workspace_id
      from public.mocks m
      join public.projects p on p.id = m.project_id
      where m.id = p_target_id;
    when 'task' then
      select p.workspace_id into v_workspace_id
      from public.tasks t
      join public.projects p on p.id = t.project_id
      where t.id = p_target_id;
    when 'acceptance_criteria' then
      select p.workspace_id into v_workspace_id
      from public.acceptance_criteria ac
      join public.tasks t on t.id = ac.task_id
      join public.projects p on p.id = t.project_id
      where ac.id = p_target_id;
    else
      return false;
  end case;

  if v_workspace_id is null then
    return false;
  end if;

  select exists (
    select 1 from public.workspace_memberships
    where workspace_id = v_workspace_id
      and user_id = auth.uid()
      and role = 'owner'
  ) into v_is_owner;

  return coalesce(v_is_owner, false);
end;
$$;

comment on function public.user_is_comment_target_owner(text, uuid) is
  'RLS helper: comment.target が指す workspace で現ユーザーが owner role か判定。
   SECURITY DEFINER で workspace 解決を bypass。T-D-17 owner moderation 用。';

revoke all on function public.user_is_comment_target_owner(text, uuid) from public;
grant execute on function public.user_is_comment_target_owner(text, uuid) to authenticated;

-- =============================================================================
-- comments_delete_self_or_owner: placeholder を本実装に差し替え
-- =============================================================================
drop policy if exists comments_delete_self_or_owner on public.comments;

create policy comments_delete_self_or_owner on public.comments
  for delete
  to authenticated
  using (
    -- self: 自分のコメントは削除可
    author_user_id = auth.uid()
    -- OR moderation: target が属する workspace の owner role なら削除可
    or public.user_is_comment_target_owner(target_type::text, target_id)
  );

commit;
