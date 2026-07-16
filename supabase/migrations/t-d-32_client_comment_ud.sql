-- =============================================================================
-- t-d-32: client_portal のコメント編集/削除(U/D)を可能にする (t-d-30/31 続き)
--
-- 通しテスト(CRUD)で発見: client のコメント C(作成)/R(閲覧)は t-d-30/31 で通ったが、
-- U(編集)/D(削除)が 500。原因は comments_update_self / comments_delete_self_or_owner の
-- auth.uid() が client セッションの "client:<uuid>" を uuid cast して crash すること。
-- 対応: 既存 policy を safe_auth_uid() に置換(client では null→member 分岐は false で落ちない)、
-- client 自身のコメント(author_invitation_id=自招待)の U/D policy を追加。
-- R-T08: client は自分の author_invitation_id のコメントのみ編集/削除できる(他人/他招待は不可)。
-- =============================================================================

-- member の U/D を client-safe に (auth.uid() → safe_auth_uid())
drop policy if exists comments_update_self on public.comments;
create policy comments_update_self on public.comments
  for update to authenticated
  using (author_user_id = public.safe_auth_uid())
  with check (author_user_id = public.safe_auth_uid());

drop policy if exists comments_delete_self_or_owner on public.comments;
create policy comments_delete_self_or_owner on public.comments
  for delete to authenticated
  using (author_user_id = public.safe_auth_uid());

-- client 自身のコメントの U/D
drop policy if exists comments_update_client on public.comments;
create policy comments_update_client on public.comments
  for update to authenticated
  using (
    public.current_client_invitation_id() is not null
    and author_invitation_id = public.current_client_invitation_id()
  )
  with check (
    public.current_client_invitation_id() is not null
    and author_invitation_id = public.current_client_invitation_id()
  );

drop policy if exists comments_delete_client on public.comments;
create policy comments_delete_client on public.comments
  for delete to authenticated
  using (
    public.current_client_invitation_id() is not null
    and author_invitation_id = public.current_client_invitation_id()
  );
