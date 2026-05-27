-- T-A-06: workspace 作成時の owner membership 自動ブートストラップ
--
-- 信頼源: R-T08 / T-D-14 (workspace_memberships RLS)
-- 背景:
--   workspace_memberships_insert_owner policy は「既に owner である」ことを要求するため、
--   authenticated user が workspace を新規作成しても自分の owner membership を
--   RLS 経由で挿入できない (鶏卵問題)。その結果 current_user_workspaces() に乗らず
--   作成直後の workspace が本人から不可視になる。
--   これを解消するため、workspaces INSERT 時に owner membership を自動作成する
--   SECURITY DEFINER トリガを置く (Supabase の標準ブートストラップパターン)。
--
-- Idempotency: create or replace function + トリガ存在チェック。

begin;

create or replace function public.bootstrap_workspace_owner_membership()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  insert into public.workspace_memberships (workspace_id, user_id, role)
  values (new.id, new.owner_user_id, 'owner')
  on conflict (workspace_id, user_id) do nothing;
  return new;
end;
$$;

comment on function public.bootstrap_workspace_owner_membership() is
  'workspaces INSERT 時に owner_user_id の owner membership を自動作成 (RLS bootstrap)。';

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'workspaces_bootstrap_owner_membership'
  ) then
    create trigger workspaces_bootstrap_owner_membership
      after insert on public.workspaces
      for each row execute function public.bootstrap_workspace_owner_membership();
  end if;
end $$;

commit;
