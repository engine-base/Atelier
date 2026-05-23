-- T-D-17: RLS policies for chat / mocks / comments / approval_inbox
--          (E-010, E-011, E-015, E-016, E-019)
--
-- 信頼源: 04_functional_breakdown/entities.json
-- 依存: T-D-04 (chat), T-D-07 (mocks, comments), T-D-10 (approval_inbox)
--
-- 設計:
--   - chat_threads / chat_messages: project_id 経由で workspace_scoped
--   - mocks: project_id 経由で workspace_scoped
--   - comments: polymorphic target_type で 4 種類の target を持つ
--     - target_type='workflow_output' → workflow_outputs.project_id
--     - target_type='mock'            → mocks.project_id
--     - target_type='task'            → tasks.project_id
--     - target_type='acceptance_criteria' → acceptance_criteria.task_id → tasks.project_id
--     → polymorphic 判定は SECURITY DEFINER 関数で集約
--   - approval_inbox: user_scoped (user_id = auth.uid())

begin;

-- =============================================================================
-- Helper: comment が指す target が現ユーザーの workspace 内かを判定
-- =============================================================================
create or replace function public.user_can_see_comment_target(
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
  v_authorized boolean;
begin
  -- target_type ごとに workspace_id を解決
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

  -- ユーザーが該当 workspace に所属しているか
  select exists (
    select 1 from public.workspace_memberships
    where workspace_id = v_workspace_id
      and user_id = auth.uid()
  ) into v_authorized;

  return coalesce(v_authorized, false);
end;
$$;

comment on function public.user_can_see_comment_target(text, uuid) is
  'RLS helper: comment.target_type/target_id に基づき現ユーザーが workspace
   member として見られるかを判定。SECURITY DEFINER で workspace 解決を bypass。';

revoke all on function public.user_can_see_comment_target(text, uuid) from public;
grant execute on function public.user_can_see_comment_target(text, uuid) to authenticated;

-- =============================================================================
-- E-010 chat_threads (project_id → workspace_scoped)
-- =============================================================================
drop policy if exists chat_threads_default_deny on public.chat_threads;
drop policy if exists chat_threads_select_member on public.chat_threads;
drop policy if exists chat_threads_insert_member on public.chat_threads;
drop policy if exists chat_threads_update_member on public.chat_threads;
drop policy if exists chat_threads_delete_owner on public.chat_threads;

create policy chat_threads_select_member on public.chat_threads
  for select to authenticated
  using (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

create policy chat_threads_insert_member on public.chat_threads
  for insert to authenticated
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = chat_threads.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy chat_threads_update_member on public.chat_threads
  for update to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = chat_threads.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = chat_threads.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy chat_threads_delete_owner on public.chat_threads
  for delete to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = chat_threads.project_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- =============================================================================
-- E-011 chat_messages (thread_id → chat_threads → projects → workspaces)
-- =============================================================================
drop policy if exists chat_messages_default_deny on public.chat_messages;
drop policy if exists chat_messages_select_member on public.chat_messages;
drop policy if exists chat_messages_insert_member on public.chat_messages;
drop policy if exists chat_messages_update_member on public.chat_messages;
drop policy if exists chat_messages_delete_owner on public.chat_messages;

create policy chat_messages_select_member on public.chat_messages
  for select to authenticated
  using (
    thread_id in (
      select t.id from public.chat_threads t
      join public.projects p on p.id = t.project_id
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

create policy chat_messages_insert_member on public.chat_messages
  for insert to authenticated
  with check (
    exists (
      select 1 from public.chat_threads t
      join public.projects p on p.id = t.project_id
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where t.id = chat_messages.thread_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy chat_messages_update_member on public.chat_messages
  for update to authenticated
  using (
    exists (
      select 1 from public.chat_threads t
      join public.projects p on p.id = t.project_id
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where t.id = chat_messages.thread_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1 from public.chat_threads t
      join public.projects p on p.id = t.project_id
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where t.id = chat_messages.thread_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy chat_messages_delete_owner on public.chat_messages
  for delete to authenticated
  using (
    exists (
      select 1 from public.chat_threads t
      join public.projects p on p.id = t.project_id
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where t.id = chat_messages.thread_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- =============================================================================
-- E-015 mocks (project_id → workspace_scoped)
-- =============================================================================
drop policy if exists mocks_default_deny on public.mocks;
drop policy if exists mocks_select_member on public.mocks;
drop policy if exists mocks_insert_member on public.mocks;
drop policy if exists mocks_update_member on public.mocks;
drop policy if exists mocks_delete_owner on public.mocks;

create policy mocks_select_member on public.mocks
  for select to authenticated
  using (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

create policy mocks_insert_member on public.mocks
  for insert to authenticated
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = mocks.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy mocks_update_member on public.mocks
  for update to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = mocks.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = mocks.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy mocks_delete_owner on public.mocks
  for delete to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = mocks.project_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- =============================================================================
-- E-016 comments (polymorphic target via user_can_see_comment_target helper)
-- =============================================================================
drop policy if exists comments_default_deny on public.comments;
drop policy if exists comments_select_member on public.comments;
drop policy if exists comments_insert_member on public.comments;
drop policy if exists comments_update_self on public.comments;
drop policy if exists comments_delete_self_or_owner on public.comments;

-- SELECT: target が見える workspace member であれば閲覧可
create policy comments_select_member on public.comments
  for select to authenticated
  using (public.user_can_see_comment_target(target_type::text, target_id));

-- INSERT: target が見える member、かつ author_user_id = auth.uid() (自分名義のみ)
create policy comments_insert_member on public.comments
  for insert to authenticated
  with check (
    public.user_can_see_comment_target(target_type::text, target_id)
    and author_user_id = auth.uid()
  );

-- UPDATE: 自分の comment のみ編集可
create policy comments_update_self on public.comments
  for update to authenticated
  using (author_user_id = auth.uid())
  with check (author_user_id = auth.uid());

-- DELETE: 自分の comment OR workspace owner (モデレーション)
create policy comments_delete_self_or_owner on public.comments
  for delete to authenticated
  using (
    author_user_id = auth.uid()
    or exists (
      -- target_type ごとに workspace 解決して owner 判定
      -- 簡易: helper 内で owner role を判定する別 helper を使うのが本来だが、
      -- ここでは self DELETE のみ許可し、moderation は service_role 経由とする
      select 1 where false
    )
  );

-- =============================================================================
-- E-019 approval_inbox (user_scoped)
-- =============================================================================
drop policy if exists approval_inbox_default_deny on public.approval_inbox;
drop policy if exists approval_inbox_select_self on public.approval_inbox;
drop policy if exists approval_inbox_insert_self on public.approval_inbox;
drop policy if exists approval_inbox_update_self on public.approval_inbox;
drop policy if exists approval_inbox_delete_self on public.approval_inbox;

create policy approval_inbox_select_self on public.approval_inbox
  for select to authenticated
  using (user_id = auth.uid());

-- INSERT: システム経由でも自分宛は許可 (将来 service_role bypass で system 挿入)
create policy approval_inbox_insert_self on public.approval_inbox
  for insert to authenticated
  with check (user_id = auth.uid());

-- UPDATE: 自分宛のみ approve/reject 可
create policy approval_inbox_update_self on public.approval_inbox
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- DELETE: 自分宛のみ削除可 (履歴整理)
create policy approval_inbox_delete_self on public.approval_inbox
  for delete to authenticated
  using (user_id = auth.uid());

commit;
