-- T-D-23: Service Role bypass + Bridge token 経路
--
-- 信頼源: 03_architecture/architecture.json#access_control.service_role_bypass=true,
--          authz_method = "RLS + Application Layer 二重チェック"
-- 依存: T-D-14〜21 (全 RLS policy), T-D-20 (mcp_tokens/byok/cron RLS)
--
-- 設計:
--   service_role は Supabase 標準で BYPASSRLS を持ち RLS を bypass する。
--   Bridge (Atelier Bridge → cloud dispatcher) はこの service_role 経路で
--   kanban dispatcher (tasks / task_executions) を操作する。
--   本 migration では「service_role が dispatcher テーブルへ全アクセス可」を
--   明示的 permissive policy として固定する (BYPASSRLS が将来無効化されても
--   dispatcher 経路が壊れない belt-and-suspenders、かつ policy で意図を可視化)。
--
--   ⚠️ workspace scope の絞り込みは RLS では行わない (service_role は全 workspace を
--   操作するため)。代わりに apps/api/src/auth/bridge_token.py が Bridge token の
--   workspace_ids scope をアプリ層で enforce する (二重チェックの app 層側)。
--
-- Idempotency: drop policy if exists → create。

begin;

-- =============================================================================
-- dispatcher 対象テーブル (tasks / task_executions) への service_role 明示許可
-- =============================================================================
drop policy if exists tasks_service_role_all on public.tasks;
create policy tasks_service_role_all on public.tasks
  for all to service_role
  using (true)
  with check (true);

drop policy if exists task_executions_service_role_all on public.task_executions;
create policy task_executions_service_role_all on public.task_executions
  for all to service_role
  using (true)
  with check (true);

comment on policy tasks_service_role_all on public.tasks is
  'T-D-23: Bridge dispatcher (service_role) は全 workspace の tasks を操作可。'
  ' workspace scope は bridge_token.py (app 層) で enforce。';
comment on policy task_executions_service_role_all on public.task_executions is
  'T-D-23: Bridge dispatcher (service_role) は全 task_executions を操作可。'
  ' workspace scope は bridge_token.py (app 層) で enforce。';

commit;
