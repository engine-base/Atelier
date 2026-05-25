-- T-D-34: RLS 越境試験 — Bridge token scope (R-T08 関連)
--
-- 信頼源: 04_functional_breakdown/entities.json#E-012 (tasks) +
--          03_architecture/architecture.json (service_role_bypass=true,
--          "RLS + Application Layer 二重チェック")
-- 依存: T-D-23 (service_role bypass + bridge_token.py)
--
-- 検証する不変条件:
--   1. member (authenticated) は他 workspace の tasks を参照不可 (RLS、0 行)。
--   2. Bridge dispatcher = service_role は RLS を bypass し全 workspace の tasks を
--      操作可 (tasks_service_role_all, T-D-23)。Bridge が触れる workspace の絞り込みは
--      RLS でなく app 層 (bridge_token.py の assert_workspace_allowed) が enforce する
--      (test_bridge_token.py で別途検証済み)。
--
-- 形式: self-verifying migration。違反時 RAISE EXCEPTION、成功時 fixture 削除 (冪等)。

begin;

do $$
declare
  u_a  uuid := '00000000-0000-4d34-a000-0000000000a1';
  u_b  uuid := '00000000-0000-4d34-b000-0000000000b1';
  ws_a uuid := '00000000-0000-4d34-a000-0000000000a2';
  ws_b uuid := '00000000-0000-4d34-b000-0000000000b2';
  p_a  uuid := '00000000-0000-4d34-a000-0000000000a3';
  p_b  uuid := '00000000-0000-4d34-b000-0000000000b3';
  t_a  uuid := '00000000-0000-4d34-a000-0000000000a4';
  t_b  uuid := '00000000-0000-4d34-b000-0000000000b4';
  claims_a text := json_build_object('sub','00000000-0000-4d34-a000-0000000000a1','role','authenticated','aud','authenticated')::text;
  cnt int;
begin
  -- 0) 残骸除去 (冪等)
  delete from public.workspaces where id in (ws_a, ws_b);
  delete from public.users where id in (u_a, u_b);
  delete from auth.users where id in (u_a, u_b);

  -- 1) fixture seed
  insert into auth.users (id, email) values (u_a,'td34-a@test.invalid'),(u_b,'td34-b@test.invalid');
  insert into public.users (id, email) values (u_a,'td34-a@test.invalid'),(u_b,'td34-b@test.invalid');
  insert into public.workspaces (id, owner_user_id, name) values (ws_a,u_a,'td34-wsA'),(ws_b,u_b,'td34-wsB');
  insert into public.workspace_memberships (workspace_id, user_id, role) values (ws_a,u_a,'owner'),(ws_b,u_b,'owner');
  insert into public.projects (id, workspace_id, name, project_type) values
    (p_a,ws_a,'td34-pA','internal_product'),(p_b,ws_b,'td34-pB','internal_product');
  insert into public.tasks (id, project_id, category, title, type, estimated_hours) values
    (t_a,p_a,'test','td34-taskA','feature',1),(t_b,p_b,'test','td34-taskB','feature',1);

  -- 2) member (authenticated user A): 他 workspace の task は不可視
  perform set_config('request.jwt.claims', claims_a, true);
  set local role authenticated;
  select count(*) into cnt from public.tasks where id = t_a;
  if cnt <> 1 then raise exception 'FAIL: member A が自 task を参照不可 (% 件)', cnt; end if;
  select count(*) into cnt from public.tasks where id = t_b;
  if cnt <> 0 then raise exception 'R-T08 FAIL: member A が他 workspace の task を参照 (% 件)', cnt; end if;
  reset role;

  -- 3) Bridge dispatcher = service_role: RLS bypass で全 task を操作可
  set local role service_role;
  select count(*) into cnt from public.tasks where id in (t_a, t_b);
  if cnt <> 2 then raise exception 'FAIL: service_role (Bridge) が全 task を参照不可 (% 件, expected 2)', cnt; end if;
  reset role;

  -- 4) cleanup
  delete from public.workspaces where id in (ws_a, ws_b);
  delete from public.users where id in (u_a, u_b);
  delete from auth.users where id in (u_a, u_b);

  raise notice 'T-D-34 Bridge token scope: PASS (member isolation 維持, service_role bypass 動作; workspace scope は app 層 bridge_token.py が enforce)';
end $$;

commit;
