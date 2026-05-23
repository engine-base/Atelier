-- T-D-19: RLS policies for audit_logs / consents / external_uploads
--          (E-020, E-024, E-025)
--
-- 信頼源: 04_functional_breakdown/entities.json
-- 関連: F-LEGAL-001 (法令対応), R-T08 (致命級 越境試験)
-- 依存: T-D-11 (3 tables 配置 + default-deny), T-D-14 (current_user_workspaces helper)
--
-- 設計:
--
-- E-020 audit_logs (workspace_scoped NULL 許容, append-only):
--   - SELECT: 自分の event (actor='user' AND actor_id=auth.uid()) OR
--             所属 workspace の event (workspace_id IN current_user_workspaces())
--             ※ workspace_id IS NULL の system event は service_role bypass のみ閲覧
--   - INSERT: 通常 user は禁止 (audit は middleware + service_role が書く前提)
--             ただし actor='user' AND actor_id=auth.uid() の self 記録は許可
--             (フロント側の analytics event 等)
--   - UPDATE: 禁止 (append-only 不変性)
--   - DELETE: 禁止 (append-only 不変性)
--
-- E-025 consents (user_scoped, append-only):
--   - SELECT: user_id = auth.uid() のみ
--   - INSERT: user_id = auth.uid() のみ (同意は自分のみ表明可)
--   - UPDATE: 禁止 (append-only、変更は新 record で表現)
--   - DELETE: 禁止 (法的記録のため)
--
-- E-024 external_uploads (workspace_scoped via project, soft_delete):
--   - SELECT: workspace member (project_id → projects → workspace_id)
--   - INSERT: workspace member 以上 (uploaded_by_user_id = auth.uid())
--   - UPDATE: workspace owner OR uploader 本人
--   - DELETE: workspace owner のみ (破壊的)
--
-- R-T08 致命級: workspace A → workspace B の audit_logs / external_uploads / consents
-- への越境 SELECT が 0 件であることを scripts/verify_rls_isolation.py で別途検証。

begin;

-- =============================================================================
-- audit_logs (E-020): self + workspace member SELECT、INSERT は self 限定
-- =============================================================================
drop policy if exists audit_logs_default_deny on public.audit_logs;
drop policy if exists audit_logs_select on public.audit_logs;
drop policy if exists audit_logs_insert_self on public.audit_logs;

-- SELECT: 自分の event OR 自分が所属 workspace の event
create policy audit_logs_select on public.audit_logs
  for select
  to authenticated
  using (
    (actor_type = 'user' and actor_id = auth.uid()::text)
    or (workspace_id is not null and workspace_id in (select public.current_user_workspaces()))
  );

-- INSERT: actor=user の self 記録のみ許可 (system / ai event は service_role 経由)
create policy audit_logs_insert_self on public.audit_logs
  for insert
  to authenticated
  with check (
    actor_type = 'user'
    and actor_id = auth.uid()::text
    and (workspace_id is null or workspace_id in (select public.current_user_workspaces()))
  );

-- UPDATE / DELETE policy は作らない = append-only enforce (FOR ALL の default-deny を継承せず、
-- 該当 policy 不在で UPDATE/DELETE が deny される: authenticated は ROLE policy が無いので不可)
-- 念のため explicit deny を置く (運用上の安心)
drop policy if exists audit_logs_no_update on public.audit_logs;
drop policy if exists audit_logs_no_delete on public.audit_logs;

create policy audit_logs_no_update on public.audit_logs
  as restrictive
  for update
  to authenticated
  using (false)
  with check (false);

create policy audit_logs_no_delete on public.audit_logs
  as restrictive
  for delete
  to authenticated
  using (false);

-- =============================================================================
-- consents (E-025): user_scoped append-only
-- =============================================================================
drop policy if exists consents_default_deny on public.consents;
drop policy if exists consents_select_self on public.consents;
drop policy if exists consents_insert_self on public.consents;
drop policy if exists consents_no_update on public.consents;
drop policy if exists consents_no_delete on public.consents;

create policy consents_select_self on public.consents
  for select
  to authenticated
  using (user_id = auth.uid());

create policy consents_insert_self on public.consents
  for insert
  to authenticated
  with check (user_id = auth.uid());

-- append-only enforce: UPDATE / DELETE 不可 (法的記録保全)
create policy consents_no_update on public.consents
  as restrictive
  for update
  to authenticated
  using (false)
  with check (false);

create policy consents_no_delete on public.consents
  as restrictive
  for delete
  to authenticated
  using (false);

-- =============================================================================
-- external_uploads (E-024): project_id 経由 workspace_scoped, soft_delete
-- =============================================================================
drop policy if exists external_uploads_default_deny on public.external_uploads;
drop policy if exists external_uploads_select_member on public.external_uploads;
drop policy if exists external_uploads_insert_member on public.external_uploads;
drop policy if exists external_uploads_update_owner_or_uploader on public.external_uploads;
drop policy if exists external_uploads_delete_owner on public.external_uploads;

-- SELECT: workspace member 全員可
create policy external_uploads_select_member on public.external_uploads
  for select
  to authenticated
  using (
    project_id in (
      select p.id from public.projects p
      where p.workspace_id in (select public.current_user_workspaces())
    )
  );

-- INSERT: workspace member 以上 (uploaded_by_user_id = auth.uid())
create policy external_uploads_insert_member on public.external_uploads
  for insert
  to authenticated
  with check (
    uploaded_by_user_id = auth.uid()
    and exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = external_uploads.project_id
        and m.user_id = auth.uid()
        and m.role in ('owner', 'member')
    )
  );

-- UPDATE: uploader 本人 OR workspace owner
create policy external_uploads_update_owner_or_uploader on public.external_uploads
  for update
  to authenticated
  using (
    uploaded_by_user_id = auth.uid()
    or exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = external_uploads.project_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  )
  with check (
    uploaded_by_user_id = auth.uid()
    or exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = external_uploads.project_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

-- DELETE: workspace owner のみ (破壊的)
create policy external_uploads_delete_owner on public.external_uploads
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      join public.workspace_memberships m on m.workspace_id = p.workspace_id
      where p.id = external_uploads.project_id
        and m.user_id = auth.uid()
        and m.role = 'owner'
    )
  );

commit;
