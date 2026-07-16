-- =============================================================================
-- t-d-30: client_portal のコメント投稿を可能にする (通しテストで発見したバグ修正)
--
-- 事象: client_portal ユーザー(sub="client:<invitation_id>", role=client_portal)が
-- POST /comments すると 500。原因は (1) user_can_see_comment_target 内の auth.uid() が
-- "client:<uuid>" を uuid にキャストして落ちる、(2) INSERT が author_user_id=auth.uid()
-- を要求する member 専用 RLS しか無く、client 経路の policy が存在しないこと。
--
-- R-T08 (クライアント越境分離) の致命級境界。本 migration は client が「自分の招待の
-- プロジェクト」の target にのみ、comment scope を持つ場合だけ INSERT/SELECT できるよう
-- 厳格にスコープする。越境試験 (別クライアントの target に不可) を必ず通すこと。
-- =============================================================================

-- 1. sub が uuid でない (client:...) 場合に落ちない安全な現ユーザー uid。
create or replace function public.safe_auth_uid()
returns uuid
language sql
stable
set search_path = public, pg_catalog
as $$
  select case
    when coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub'
         ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then ((current_setting('request.jwt.claims', true)::jsonb) ->> 'sub')::uuid
    else null
  end;
$$;

-- 2. 現セッションが client_portal なら招待ID(client:<uuid> の uuid 部)を返す。それ以外は null。
create or replace function public.current_client_invitation_id()
returns uuid
language sql
stable
set search_path = public, pg_catalog
as $$
  select case
    when (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub')
         like 'client:%'
     and split_part((current_setting('request.jwt.claims', true)::jsonb) ->> 'sub', 'client:', 2)
         ~ '^[0-9a-fA-F-]{36}$'
    then split_part((current_setting('request.jwt.claims', true)::jsonb) ->> 'sub', 'client:', 2)::uuid
    else null
  end;
$$;

-- 3. member 判定関数を client-safe に (auth.uid() 直呼びをやめ safe_auth_uid() に)。
--    client セッションでは safe_auth_uid()=null → member としては false を返す(落ちない)。
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
  v_uid uuid;
begin
  v_uid := public.safe_auth_uid();
  if v_uid is null then
    return false;
  end if;
  case p_target_type
    when 'workflow_output' then
      select p.workspace_id into v_workspace_id
      from public.workflow_outputs wo join public.projects p on p.id = wo.project_id
      where wo.id = p_target_id;
    when 'mock' then
      select p.workspace_id into v_workspace_id
      from public.mocks m join public.projects p on p.id = m.project_id
      where m.id = p_target_id;
    when 'task' then
      select p.workspace_id into v_workspace_id
      from public.tasks t join public.projects p on p.id = t.project_id
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
  return coalesce((
    select exists (
      select 1 from public.workspace_memberships
      where workspace_id = v_workspace_id and user_id = v_uid
    )
  ), false);
end;
$$;

-- 4. client が target にアクセスできるか (招待のプロジェクト一致 + scope + 有効期限/失効)。
--    p_scope: 'view' or 'comment'。target の project を解決し、招待の project_id と一致し、
--    招待が失効/期限切れでなく、scopes に p_scope を含む場合のみ true。
create or replace function public.client_can_access_comment_target(
  p_invitation_id uuid,
  p_target_type text,
  p_target_id uuid,
  p_scope text
)
returns boolean
language plpgsql
security definer
stable
set search_path = public, pg_catalog
as $$
declare
  v_target_project uuid;
begin
  if p_invitation_id is null then
    return false;
  end if;
  case p_target_type
    when 'workflow_output' then
      select wo.project_id into v_target_project
      from public.workflow_outputs wo where wo.id = p_target_id;
    when 'mock' then
      select m.project_id into v_target_project
      from public.mocks m where m.id = p_target_id;
    when 'task' then
      select t.project_id into v_target_project
      from public.tasks t where t.id = p_target_id;
    when 'acceptance_criteria' then
      select t.project_id into v_target_project
      from public.acceptance_criteria ac
      join public.tasks t on t.id = ac.task_id
      where ac.id = p_target_id;
    else
      return false;
  end case;
  if v_target_project is null then
    return false;
  end if;
  return exists (
    select 1 from public.client_invitations ci
    where ci.id = p_invitation_id
      and ci.project_id = v_target_project          -- ★越境不可: 招待のプロジェクトのみ
      and ci.revoked_at is null
      and ci.expires_at > now()
      and ci.scopes ? p_scope                        -- scope を持つ場合のみ
  );
end;
$$;

revoke all on function public.safe_auth_uid() from public;
revoke all on function public.current_client_invitation_id() from public;
revoke all on function public.client_can_access_comment_target(uuid, text, uuid, text) from public;
grant execute on function public.safe_auth_uid() to authenticated;
grant execute on function public.current_client_invitation_id() to authenticated;
grant execute on function public.client_can_access_comment_target(uuid, text, uuid, text) to authenticated;

-- 5. client 用 RLS policy を追加 (member policy はそのまま。client は別 policy で許可)。
drop policy if exists comments_select_client on public.comments;
drop policy if exists comments_insert_client on public.comments;

-- SELECT: 自分の招待プロジェクトの target のコメントのみ (view scope)
create policy comments_select_client on public.comments
  for select to authenticated
  using (
    public.current_client_invitation_id() is not null
    and public.client_can_access_comment_target(
      public.current_client_invitation_id(), target_type::text, target_id, 'view')
  );

-- INSERT: 自分名義(author_invitation_id=自招待) かつ 自プロジェクトの target かつ comment scope
create policy comments_insert_client on public.comments
  for insert to authenticated
  with check (
    public.current_client_invitation_id() is not null
    and author_user_id is null
    and author_invitation_id = public.current_client_invitation_id()
    and public.client_can_access_comment_target(
      public.current_client_invitation_id(), target_type::text, target_id, 'comment')
  );
