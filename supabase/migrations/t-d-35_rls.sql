-- T-D-35: RLS 越境試験 — cron_schedules / byok_api_keys (vault) / mcp_tokens (R-T08)
--
-- 信頼源: 04_functional_breakdown/entities.json + R-T08 (致命級)
-- 依存: T-D-19 (audit RLS), T-D-20 (mcp_tokens / byok_api_keys / cron RLS)
--
-- 形式: self-verifying migration (T-D-31/32 と同方式)。
--   - mcp_tokens (workspace_scoped): user A は workspace B の token を参照不可
--   - byok_api_keys (user_scoped): user A は user B の鍵を参照不可 (非所有者 deny)
--   - cron_schedules (project_scoped): user A は workspace B の cron を参照不可
--   違反時 RAISE EXCEPTION で abort、成功時 fixture 削除で net-zero (冪等)。

begin;

do $$
declare
  u_a   uuid := '00000000-0000-4d35-a000-0000000000a1';
  u_b   uuid := '00000000-0000-4d35-b000-0000000000b1';
  ws_a  uuid := '00000000-0000-4d35-a000-0000000000a2';
  ws_b  uuid := '00000000-0000-4d35-b000-0000000000b2';
  p_a   uuid := '00000000-0000-4d35-a000-0000000000a3';
  p_b   uuid := '00000000-0000-4d35-b000-0000000000b3';
  mt_a  uuid := '00000000-0000-4d35-a000-0000000000a4';
  mt_b  uuid := '00000000-0000-4d35-b000-0000000000b4';
  bk_a  uuid := '00000000-0000-4d35-a000-0000000000a5';
  bk_b  uuid := '00000000-0000-4d35-b000-0000000000b5';
  cr_a  uuid := '00000000-0000-4d35-a000-0000000000a6';
  cr_b  uuid := '00000000-0000-4d35-b000-0000000000b6';
  claims_a text := json_build_object('sub','00000000-0000-4d35-a000-0000000000a1','role','authenticated','aud','authenticated')::text;
  claims_b text := json_build_object('sub','00000000-0000-4d35-b000-0000000000b1','role','authenticated','aud','authenticated')::text;
  leak int;
begin
  -- 0) 残骸除去 (冪等)
  delete from public.byok_api_keys where id in (bk_a, bk_b);
  delete from public.workspaces where id in (ws_a, ws_b);
  delete from public.users where id in (u_a, u_b);
  delete from auth.users where id in (u_a, u_b);

  -- 1) fixture seed (RLS bypass)
  insert into auth.users (id, email) values (u_a,'td35-a@test.invalid'),(u_b,'td35-b@test.invalid');
  insert into public.users (id, email) values (u_a,'td35-a@test.invalid'),(u_b,'td35-b@test.invalid');
  insert into public.workspaces (id, owner_user_id, name) values (ws_a,u_a,'td35-wsA'),(ws_b,u_b,'td35-wsB');
  insert into public.workspace_memberships (workspace_id, user_id, role) values (ws_a,u_a,'owner'),(ws_b,u_b,'owner');
  insert into public.projects (id, workspace_id, name, project_type) values
    (p_a,ws_a,'td35-pA','internal_product'),(p_b,ws_b,'td35-pB','internal_product');
  insert into public.mcp_tokens (id, workspace_id, token_hash, name) values
    (mt_a, ws_a, repeat('a',64), 'td35-tokenA'),
    (mt_b, ws_b, repeat('b',64), 'td35-tokenB');
  insert into public.byok_api_keys (id, user_id, provider, encrypted_key) values
    (bk_a, u_a, 'claude', 'vault-secret-A'),
    (bk_b, u_b, 'openai', 'vault-secret-B');
  insert into public.cron_schedules (id, project_id, name, cron_expression, target_action) values
    (cr_a, p_a, 'td35-cronA', '0 0 * * *', 'task_replay'),
    (cr_b, p_b, 'td35-cronB', '0 0 * * *', 'task_replay');

  -- 2) user A: workspace B / user B のリソースは不可視
  perform set_config('request.jwt.claims', claims_a, true);
  set local role authenticated;
  select count(*) into leak from public.mcp_tokens where id = mt_b;
  if leak <> 0 then raise exception 'R-T08 FAIL: user A が mcp_token B を参照 (% 件)', leak; end if;
  select count(*) into leak from public.byok_api_keys where id = bk_b;
  if leak <> 0 then raise exception 'R-T08 FAIL: user A が byok_api_key B を参照 (% 件)', leak; end if;
  select count(*) into leak from public.cron_schedules where id = cr_b;
  if leak <> 0 then raise exception 'R-T08 FAIL: user A が cron_schedule B を参照 (% 件)', leak; end if;
  -- positive control: 自分のリソースは見える
  select count(*) into leak from public.byok_api_keys where id = bk_a;
  if leak <> 1 then raise exception 'R-T08 FAIL: user A が自 byok_api_key A を参照できない (% 件)', leak; end if;
  reset role;

  -- 3) user B: 対称
  perform set_config('request.jwt.claims', claims_b, true);
  set local role authenticated;
  select count(*) into leak from public.mcp_tokens where id = mt_a;
  if leak <> 0 then raise exception 'R-T08 FAIL: user B が mcp_token A を参照 (% 件)', leak; end if;
  select count(*) into leak from public.byok_api_keys where id = bk_a;
  if leak <> 0 then raise exception 'R-T08 FAIL: user B が byok_api_key A を参照 (% 件)', leak; end if;
  select count(*) into leak from public.cron_schedules where id = cr_a;
  if leak <> 0 then raise exception 'R-T08 FAIL: user B が cron_schedule A を参照 (% 件)', leak; end if;
  reset role;

  -- 4) cleanup
  delete from public.byok_api_keys where id in (bk_a, bk_b);
  delete from public.workspaces where id in (ws_a, ws_b);
  delete from public.users where id in (u_a, u_b);
  delete from auth.users where id in (u_a, u_b);

  raise notice 'T-D-35 R-T08 isolation: PASS (mcp_tokens / byok_api_keys / cron_schedules, 双方向)';
end $$;

commit;
