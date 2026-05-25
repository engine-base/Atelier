-- T-D-33: RLS 越境試験 — client_portal (R-T08)
--
-- 信頼源: 04_functional_breakdown/entities.json#E-017 + R-T08 (致命級)
-- 依存: T-D-22 (client 別 JWT 完全分離 RLS)
--
-- 形式: self-verifying migration。client invitation (project A) の JWT
--   (invitation_token_hash claim) でアクセスし、自 project の workflow_outputs /
--   mocks は可視・他 project は 0 行 (cross-project deny) を assert。
--   audit_client_access_denied() が audit_logs に記録することも検証。
--   違反時 RAISE EXCEPTION で abort、成功時 fixture 削除で net-zero (冪等)。

begin;

do $$
declare
  u_a  uuid := '00000000-0000-4d33-a000-0000000000a1';
  u_b  uuid := '00000000-0000-4d33-b000-0000000000b1';
  ws_a uuid := '00000000-0000-4d33-a000-0000000000a2';
  ws_b uuid := '00000000-0000-4d33-b000-0000000000b2';
  p_a  uuid := '00000000-0000-4d33-a000-0000000000a3';
  p_b  uuid := '00000000-0000-4d33-b000-0000000000b3';
  wo_a uuid := '00000000-0000-4d33-a000-0000000000a4';
  wo_b uuid := '00000000-0000-4d33-b000-0000000000b4';
  m_a  uuid := '00000000-0000-4d33-a000-0000000000a5';
  m_b  uuid := '00000000-0000-4d33-b000-0000000000b5';
  tok  text := repeat('3', 64);  -- client invitation token_hash (project A)
  claims text := json_build_object('role','authenticated','aud','authenticated','invitation_token_hash', repeat('3',64))::text;
  leak int;
  audit_before int;
  audit_after int;
begin
  -- 0) 残骸除去 (冪等)
  delete from public.workspaces where id in (ws_a, ws_b);
  delete from public.users where id in (u_a, u_b);
  delete from auth.users where id in (u_a, u_b);

  -- 1) fixture seed (RLS bypass)
  insert into auth.users (id, email) values (u_a,'td33-a@test.invalid'),(u_b,'td33-b@test.invalid');
  insert into public.users (id, email) values (u_a,'td33-a@test.invalid'),(u_b,'td33-b@test.invalid');
  insert into public.workspaces (id, owner_user_id, name) values (ws_a,u_a,'td33-wsA'),(ws_b,u_b,'td33-wsB');
  insert into public.projects (id, workspace_id, name, project_type) values
    (p_a,ws_a,'td33-pA','client_work'),(p_b,ws_b,'td33-pB','client_work');
  insert into public.client_invitations (project_id, email, token_hash, expires_at)
    values (p_a, 'td33-client@ext.invalid', tok, now() + interval '7 days');
  insert into public.workflow_outputs (id, project_id, stage) values (wo_a,p_a,'design'),(wo_b,p_b,'design');
  insert into public.mocks (id, project_id, screen_name, html_storage_path) values
    (m_a,p_a,'screenA','a.html'),(m_b,p_b,'screenB','b.html');

  -- 2) client JWT (invitation_token_hash claim, auth.uid()=null) で越境試験
  perform set_config('request.jwt.claims', claims, true);
  set local role authenticated;

  -- 自 project は可視 (positive control)
  select count(*) into leak from public.workflow_outputs where id = wo_a;
  if leak <> 1 then raise exception 'R-T08 FAIL: client が自 project の workflow_output を参照不可 (% 件)', leak; end if;
  select count(*) into leak from public.mocks where id = m_a;
  if leak <> 1 then raise exception 'R-T08 FAIL: client が自 project の mock を参照不可 (% 件)', leak; end if;

  -- 他 project は 0 行 (cross-project deny)
  select count(*) into leak from public.workflow_outputs where id = wo_b;
  if leak <> 0 then raise exception 'R-T08 FAIL: client が他 project の workflow_output を参照 (% 件)', leak; end if;
  select count(*) into leak from public.mocks where id = m_b;
  if leak <> 0 then raise exception 'R-T08 FAIL: client が他 project の mock を参照 (% 件)', leak; end if;

  reset role;

  -- 3) audit_client_access_denied() が audit_logs に記録することを検証
  select count(*) into audit_before from public.audit_logs
    where action = 'rls.client_cross_project_denied' and target_id = p_b;
  perform set_config('request.jwt.claims', claims, true);
  perform public.audit_client_access_denied(p_b, 'td33-test');
  select count(*) into audit_after from public.audit_logs
    where action = 'rls.client_cross_project_denied' and target_id = p_b;
  if audit_after <> audit_before + 1 then
    raise exception 'R-T08 FAIL: 越境試行が audit_logs に記録されない (before=%, after=%)', audit_before, audit_after;
  end if;

  -- 4) cleanup
  delete from public.audit_logs where action = 'rls.client_cross_project_denied' and target_id = p_b;
  delete from public.workspaces where id in (ws_a, ws_b);
  delete from public.users where id in (u_a, u_b);
  delete from auth.users where id in (u_a, u_b);

  raise notice 'T-D-33 R-T08 client_portal isolation: PASS (own=visible, cross-project=0, audit logged)';
end $$;

commit;
