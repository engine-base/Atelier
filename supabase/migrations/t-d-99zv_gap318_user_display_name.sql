-- =============================================================================
-- GAP-318: 「誰が書いたか」が **他人の分だけ空になる** のを直す。
--
-- public.users の SELECT は users_select_self (auth.uid() = id) だけなので、
-- コメント一覧などが `left join public.users` で表示名を引いても、**自分以外は
-- 必ず NULL** になっていた。GAP-226 で author_name を返すようにしたのに、
-- 実際に効くのは自分の書き込みだけで、同僚の発言は「名前なし」のまま。
-- 1 案件に書き手が 2 人いると誰の発言か区別できない (GAP-226 が直そうとした状態)。
--
-- users の RLS を緩めると email まで見えてしまうため、**表示名だけ**を返す
-- security definer 関数を置き、呼び出し側 (comments / project_credentials) は
-- join ではなくこの関数を使う。開示範囲は「自分」または「同じ workspace の人」。
-- =============================================================================
begin;

create or replace function public.user_display_name(p_user_id uuid)
returns text
language sql
security definer
stable
set search_path = public, pg_catalog
as $$
  select u.display_name
  from public.users u
  where u.id = p_user_id
    and u.deleted_at is null
    and (
      u.id = auth.uid()
      or exists (
        select 1
        from public.workspace_memberships m
        where m.user_id = u.id
          and m.workspace_id in (select public.current_user_workspaces())
      )
    )
$$;

comment on function public.user_display_name(uuid) is
  'GAP-318: 表示名だけを返す (email は返さない)。開示は自分または同じ workspace の人に限る。
   users_select_self のままだと「同僚の書き込みの名前が全部 NULL」になるため。';

revoke all on function public.user_display_name(uuid) from public;
grant execute on function public.user_display_name(uuid) to authenticated;

commit;
