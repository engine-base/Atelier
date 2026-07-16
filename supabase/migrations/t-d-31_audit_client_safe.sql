-- =============================================================================
-- t-d-31: audit_logs の RLS を client_portal セッションで安全にする (t-d-30 続き)
--
-- t-d-30 で comments のクライアント経路は通ったが、comment.create の audit 書込が
-- audit_logs_insert_self policy 内の auth.uid() で "client:<uuid>" を uuid cast し 500。
-- ここでも safe_auth_uid() を使い、クライアント自身の audit(actor_id='client:<inv>')の
-- self-insert を許可する。SELECT も client-safe に。
-- append-only / workspace scope は維持。
-- =============================================================================

drop policy if exists audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (
    (actor_type = 'user' and actor_id = public.safe_auth_uid()::text)
    or (public.current_client_invitation_id() is not null
        and actor_id = 'client:' || public.current_client_invitation_id()::text)
    or (workspace_id is not null and workspace_id in (select public.current_user_workspaces()))
  );

drop policy if exists audit_logs_insert_self on public.audit_logs;
create policy audit_logs_insert_self on public.audit_logs
  for insert to authenticated
  with check (
    actor_type = 'user'
    and (
      actor_id = public.safe_auth_uid()::text
      or (public.current_client_invitation_id() is not null
          and actor_id = 'client:' || public.current_client_invitation_id()::text)
    )
    and (workspace_id is null or workspace_id in (select public.current_user_workspaces()))
  );
