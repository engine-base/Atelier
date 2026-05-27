-- T-D-31: RLS 越境試験 — workspace 分離（基本）(R-T08)
--
-- 信頼源: 04_functional_breakdown/entities.json + R-T08 (致命級)
-- 依存: T-D-14 (users/memberships RLS) / T-D-15 (workspaces/projects RLS) /
--       T-D-16 (tasks RLS) / T-D-17 (chat/mocks/comments RLS)
--
-- 形式: self-verifying migration。適用時に 2 workspace / 2 user の fixture を
--   service-role 相当 (migration 実行ロール = RLS bypass) で seed し、authenticated
--   ロール + 各 user の JWT claims に切替えて「他 workspace の行が 0 件」を assert する。
--   違反時は RAISE EXCEPTION → トランザクション abort で fixture も巻き戻る。
--   成功時は fixture を削除して net-zero (冪等・再適用安全)。
--
-- 注意: authenticated ロールへの public テーブル GRANT は Supabase が標準提供する
--   (ローカル raw Postgres で再現する場合は同等の GRANT が必要)。本 migration は
--   RLS policy のみを検証し、GRANT は前提とする (他 RLS migration と同方針)。

begin;

do $$
declare
  u_a  uuid := '00000000-0000-4d31-a000-0000000000a1';
  u_b  uuid := '00000000-0000-4d31-b000-0000000000b1';
  ws_a uuid := '00000000-0000-4d31-a000-0000000000a2';
  ws_b uuid := '00000000-0000-4d31-b000-0000000000b2';
  p_a  uuid := '00000000-0000-4d31-a000-0000000000a3';
  p_b  uuid := '00000000-0000-4d31-b000-0000000000b3';
  t_a  uuid := '00000000-0000-4d31-a000-0000000000a4';
  t_b  uuid := '00000000-0000-4d31-b000-0000000000b4';
  claims_a text := json_build_object('sub', '00000000-0000-4d31-a000-0000000000a1', 'role', 'authenticated', 'aud', 'authenticated')::text;
  claims_b text := json_build_object('sub', '00000000-0000-4d31-b000-0000000000b1', 'role', 'authenticated', 'aud', 'authenticated')::text;
  leak int;
begin
  -- 0) 前回 fixture の残骸があれば除去 (冪等性担保)
  delete from public.workspaces where id in (ws_a, ws_b);
  delete from public.users where id in (u_a, u_b);
  delete from auth.users where id in (u_a, u_b);

  -- 1) fixture seed (migration ロール = RLS bypass で投入)
  insert into auth.users (id, email) values
    (u_a, 'td31-a@test.invalid'), (u_b, 'td31-b@test.invalid');
  insert into public.users (id, email) values
    (u_a, 'td31-a@test.invalid'), (u_b, 'td31-b@test.invalid');
  insert into public.workspaces (id, owner_user_id, name) values
    (ws_a, u_a, 'td31-workspace-A'), (ws_b, u_b, 'td31-workspace-B');
  insert into public.workspace_memberships (workspace_id, user_id, role) values
    (ws_a, u_a, 'owner'), (ws_b, u_b, 'owner');
  insert into public.projects (id, workspace_id, name, project_type) values
    (p_a, ws_a, 'td31-project-A', 'internal_product'),
    (p_b, ws_b, 'td31-project-B', 'internal_product');
  insert into public.tasks (id, project_id, category, title, type, estimated_hours) values
    (t_a, p_a, 'test', 'td31-task-A', 'feature', 1),
    (t_b, p_b, 'test', 'td31-task-B', 'feature', 1);

  -- 2) user A として越境不可を検証
  perform set_config('request.jwt.claims', claims_a, true);
  set local role authenticated;

  select count(*) into leak from public.workspaces where id = ws_b;
  if leak <> 0 then raise exception 'R-T08 FAIL: user A が workspace B を参照 (% 件)', leak; end if;
  select count(*) into leak from public.projects where id = p_b;
  if leak <> 0 then raise exception 'R-T08 FAIL: user A が project B を参照 (% 件)', leak; end if;
  select count(*) into leak from public.tasks where id = t_b;
  if leak <> 0 then raise exception 'R-T08 FAIL: user A が task B を参照 (% 件)', leak; end if;
  -- positive control: 自 workspace は見える
  select count(*) into leak from public.workspaces where id = ws_a;
  if leak <> 1 then raise exception 'R-T08 FAIL: user A が自 workspace A を参照できない (% 件)', leak; end if;

  reset role;

  -- 3) user B として対称に越境不可を検証
  perform set_config('request.jwt.claims', claims_b, true);
  set local role authenticated;

  select count(*) into leak from public.workspaces where id = ws_a;
  if leak <> 0 then raise exception 'R-T08 FAIL: user B が workspace A を参照 (% 件)', leak; end if;
  select count(*) into leak from public.projects where id = p_a;
  if leak <> 0 then raise exception 'R-T08 FAIL: user B が project A を参照 (% 件)', leak; end if;
  select count(*) into leak from public.tasks where id = t_a;
  if leak <> 0 then raise exception 'R-T08 FAIL: user B が task A を参照 (% 件)', leak; end if;

  reset role;

  -- 4) cleanup (workspaces 削除で projects/tasks/memberships が cascade)
  delete from public.workspaces where id in (ws_a, ws_b);
  delete from public.users where id in (u_a, u_b);
  delete from auth.users where id in (u_a, u_b);

  raise notice 'T-D-31 R-T08 workspace isolation: PASS (workspaces / projects / tasks, 双方向)';
end $$;

commit;
