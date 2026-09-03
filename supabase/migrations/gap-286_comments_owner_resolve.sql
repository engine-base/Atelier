-- =============================================================================
-- GAP-286 (通し B 派生 / G-14): workspace owner は他人 (メンバー / クライアント)
-- のコメントを解決 (status) できる。
--
-- これまで update は comments_update_self (自分のコメントのみ) だけだったため、
-- メンバーが付けたコメントを owner が resolved にできず (403)、そのメンバーを
-- 除名した後は誰も解決できずに未解決が永久に残った。削除には t-d-17b で
-- owner モデレーション (user_is_comment_target_owner) が既にあるので、
-- update にも同じ helper で owner 条件を足す。
-- =============================================================================
begin;

drop policy if exists comments_update_owner on public.comments;
create policy comments_update_owner on public.comments
  for update
  to authenticated
  using (public.user_is_comment_target_owner(target_type::text, target_id))
  with check (public.user_is_comment_target_owner(target_type::text, target_id));

commit;
