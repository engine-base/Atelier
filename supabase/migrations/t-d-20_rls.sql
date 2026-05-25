-- T-D-20: RLS policies for mcp_tokens / byok_api_keys / cron_schedules (E-021/022/023)
--
-- 信頼源: 04_functional_breakdown/entities.json + R-T08 (致命級)
-- 依存: T-D-12 (mcp_tokens / byok_api_keys), T-D-13 (cron_schedules),
--       T-D-14 (current_user_workspaces() helper)
--
-- 設計:
--   - mcp_tokens (E-021 workspace_scoped): SELECT=member, INSERT/UPDATE=owner/member,
--     DELETE=owner。token は機微なので viewer 含む非 member には不可視。
--   - byok_api_keys (E-022 user_scoped): 完全 self-scoped (user_id = auth.uid())。
--     他ユーザーの鍵は SELECT/変更とも不可 (UNWANTED: 非所有者 deny)。
--   - cron_schedules (E-023 project_scoped via project_id→workspace):
--     SELECT=member, INSERT/UPDATE=owner/member, DELETE=owner。
--
-- いずれも default-deny を DROP し実 policy に置換 (冪等: drop if exists → create)。

begin;

-- =============================================================================
-- E-021 mcp_tokens (workspace_scoped)
-- =============================================================================
drop policy if exists mcp_tokens_default_deny on public.mcp_tokens;
drop policy if exists mcp_tokens_select_member on public.mcp_tokens;
drop policy if exists mcp_tokens_insert_member on public.mcp_tokens;
drop policy if exists mcp_tokens_update_member on public.mcp_tokens;
drop policy if exists mcp_tokens_delete_owner on public.mcp_tokens;

create policy mcp_tokens_select_member on public.mcp_tokens
  for select to authenticated
  using (workspace_id in (select public.current_user_workspaces()));

create policy mcp_tokens_insert_member on public.mcp_tokens
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = mcp_tokens.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy mcp_tokens_update_member on public.mcp_tokens
  for update to authenticated
  using (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = mcp_tokens.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = mcp_tokens.workspace_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy mcp_tokens_delete_owner on public.mcp_tokens
  for delete to authenticated
  using (
    exists (
      select 1 from public.workspace_memberships m
      where m.workspace_id = mcp_tokens.workspace_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- =============================================================================
-- E-022 byok_api_keys (user_scoped, 完全 self-scoped)
-- =============================================================================
drop policy if exists byok_api_keys_default_deny on public.byok_api_keys;
drop policy if exists byok_api_keys_select_owner on public.byok_api_keys;
drop policy if exists byok_api_keys_insert_owner on public.byok_api_keys;
drop policy if exists byok_api_keys_update_owner on public.byok_api_keys;
drop policy if exists byok_api_keys_delete_owner on public.byok_api_keys;

create policy byok_api_keys_select_owner on public.byok_api_keys
  for select to authenticated
  using (user_id = auth.uid());

create policy byok_api_keys_insert_owner on public.byok_api_keys
  for insert to authenticated
  with check (user_id = auth.uid());

create policy byok_api_keys_update_owner on public.byok_api_keys
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy byok_api_keys_delete_owner on public.byok_api_keys
  for delete to authenticated
  using (user_id = auth.uid());

-- =============================================================================
-- E-023 cron_schedules (project_scoped via project_id → workspace)
-- =============================================================================
drop policy if exists cron_schedules_default_deny on public.cron_schedules;
drop policy if exists cron_schedules_select_member on public.cron_schedules;
drop policy if exists cron_schedules_insert_member on public.cron_schedules;
drop policy if exists cron_schedules_update_member on public.cron_schedules;
drop policy if exists cron_schedules_delete_owner on public.cron_schedules;

create policy cron_schedules_select_member on public.cron_schedules
  for select to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = cron_schedules.project_id
        and p.workspace_id in (select public.current_user_workspaces())
    )
  );

create policy cron_schedules_insert_member on public.cron_schedules
  for insert to authenticated
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = cron_schedules.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy cron_schedules_update_member on public.cron_schedules
  for update to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = cron_schedules.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = cron_schedules.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

create policy cron_schedules_delete_owner on public.cron_schedules
  for delete to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = cron_schedules.project_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

commit;
