-- T-D-32: RLS 越境試験 — project 分離 (R-T08)
--
-- 信頼源: 04_functional_breakdown/entities.json + R-T08 (致命級)
-- 依存: T-D-31 (workspace 分離試験)。本試験は project 配下の子テーブル
--       (chat_threads / mocks / workflow_outputs) が project→workspace の
--       membership 経由でのみ可視であることを検証する。
--
-- 形式: self-verifying migration (T-D-31 と同方式)。fixture を seed し authenticated
--   ロール + JWT claims で「他 workspace の project-scoped 行が 0 件」を双方向 assert。
--   違反時 RAISE EXCEPTION で abort、成功時 fixture 削除で net-zero (冪等)。

begin;

do $$
declare
  u_a   uuid := '00000000-0000-4d32-a000-0000000000a1';
  u_b   uuid := '00000000-0000-4d32-b000-0000000000b1';
  ws_a  uuid := '00000000-0000-4d32-a000-0000000000a2';
  ws_b  uuid := '00000000-0000-4d32-b000-0000000000b2';
  p_a   uuid := '00000000-0000-4d32-a000-0000000000a3';
  p_b   uuid := '00000000-0000-4d32-b000-0000000000b3';
  e_a   uuid := '00000000-0000-4d32-a000-0000000000a4';
  e_b   uuid := '00000000-0000-4d32-b000-0000000000b4';
  th_a  uuid := '00000000-0000-4d32-a000-0000000000a5';
  th_b  uuid := '00000000-0000-4d32-b000-0000000000b5';
  m_a   uuid := '00000000-0000-4d32-a000-0000000000a6';
  m_b   uuid := '00000000-0000-4d32-b000-0000000000b6';
  w_a   uuid := '00000000-0000-4d32-a000-0000000000a7';
  w_b   uuid := '00000000-0000-4d32-b000-0000000000b7';
  claims_a text := json_build_object('sub','00000000-0000-4d32-a000-0000000000a1','role','authenticated','aud','authenticated')::text;
  claims_b text := json_build_object('sub','00000000-0000-4d32-b000-0000000000b1','role','authenticated','aud','authenticated')::text;
  leak int;
begin
  -- 0) 残骸除去 (冪等)
  delete from public.workspaces where id in (ws_a, ws_b);
  delete from public.users where id in (u_a, u_b);
  delete from auth.users where id in (u_a, u_b);

  -- 1) fixture seed (RLS bypass)
  insert into auth.users (id, email) values (u_a,'td32-a@test.invalid'),(u_b,'td32-b@test.invalid');
  insert into public.users (id, email) values (u_a,'td32-a@test.invalid'),(u_b,'td32-b@test.invalid');
  insert into public.workspaces (id, owner_user_id, name) values (ws_a,u_a,'td32-wsA'),(ws_b,u_b,'td32-wsB');
  insert into public.workspace_memberships (workspace_id, user_id, role) values (ws_a,u_a,'owner'),(ws_b,u_b,'owner');
  insert into public.projects (id, workspace_id, name, project_type) values
    (p_a,ws_a,'td32-pA','internal_product'),(p_b,ws_b,'td32-pB','internal_product');
  insert into public.ai_employees (id, workspace_id, name, display_name, role, department) values
    (e_a,ws_a,'td32-empA','EmpA','member','product'),(e_b,ws_b,'td32-empB','EmpB','member','product');
  insert into public.chat_threads (id, project_id, ai_employee_id, title) values
    (th_a,p_a,e_a,'td32-threadA'),(th_b,p_b,e_b,'td32-threadB');
  insert into public.mocks (id, project_id, screen_name, html_storage_path) values
    (m_a,p_a,'screenA','a/path.html'),(m_b,p_b,'screenB','b/path.html');
  insert into public.workflow_outputs (id, project_id, stage) values
    (w_a,p_a,'design'),(w_b,p_b,'design');

  -- 2) user A: 他 workspace の project-scoped 行は不可視
  perform set_config('request.jwt.claims', claims_a, true);
  set local role authenticated;
  select count(*) into leak from public.chat_threads where id = th_b;
  if leak <> 0 then raise exception 'R-T08 FAIL: user A が chat_thread B を参照 (% 件)', leak; end if;
  select count(*) into leak from public.mocks where id = m_b;
  if leak <> 0 then raise exception 'R-T08 FAIL: user A が mock B を参照 (% 件)', leak; end if;
  select count(*) into leak from public.workflow_outputs where id = w_b;
  if leak <> 0 then raise exception 'R-T08 FAIL: user A が workflow_output B を参照 (% 件)', leak; end if;
  -- positive control
  select count(*) into leak from public.mocks where id = m_a;
  if leak <> 1 then raise exception 'R-T08 FAIL: user A が自 project の mock A を参照できない (% 件)', leak; end if;
  reset role;

  -- 3) user B: 対称
  perform set_config('request.jwt.claims', claims_b, true);
  set local role authenticated;
  select count(*) into leak from public.chat_threads where id = th_a;
  if leak <> 0 then raise exception 'R-T08 FAIL: user B が chat_thread A を参照 (% 件)', leak; end if;
  select count(*) into leak from public.mocks where id = m_a;
  if leak <> 0 then raise exception 'R-T08 FAIL: user B が mock A を参照 (% 件)', leak; end if;
  select count(*) into leak from public.workflow_outputs where id = w_a;
  if leak <> 0 then raise exception 'R-T08 FAIL: user B が workflow_output A を参照 (% 件)', leak; end if;
  reset role;

  -- 4) cleanup (workspaces 削除で project-scoped 子が cascade)
  delete from public.workspaces where id in (ws_a, ws_b);
  delete from public.users where id in (u_a, u_b);
  delete from auth.users where id in (u_a, u_b);

  raise notice 'T-D-32 R-T08 project isolation: PASS (chat_threads / mocks / workflow_outputs, 双方向)';
end $$;

commit;
