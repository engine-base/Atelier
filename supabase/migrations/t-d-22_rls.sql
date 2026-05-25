-- T-D-22: クライアント別 JWT 経路完全分離 RLS (R-T08 致命級)
--
-- 信頼源: 03_architecture/architecture.json#access_control.client_portal_isolation
--          = "別 JWT claim (invitation_token_hash) で完全分離"
-- 依存: T-D-08 (client_invitations), T-D-14/15/16/17 (member RLS)
--
-- ⚠️ 致命級 (R-T08): 本 migration は AI 単独で本番 merge してはならない。
--    経営者承認 (S-E01) 後にのみ merge する。
--
-- 設計:
--   クライアント (外部レビュアー) は Supabase user (auth.uid()) を持たず、
--   invitation token から発行された JWT の claim `invitation_token_hash` で識別される。
--   member 用 RLS (auth.uid() ベース) はクライアントには 0 行しか返さないため、
--   本 migration がクライアント経路専用の permissive policy を追加する。
--
--   - current_client_project(): JWT claim invitation_token_hash から、有効
--     (未失効・未期限切れ) な client_invitations の project_id を返す SECURITY DEFINER helper。
--   - クライアントは自分の invitation に紐づく 1 project の
--     workflow_outputs / mocks を SELECT 可、comments を SELECT/INSERT 可 (scope=comment)。
--   - 他 project へのアクセスは current_client_project() と一致しないため 0 行 = deny。
--   - audit_client_access_denied(): 越境試行をアプリ層が audit_logs に記録するための helper。
--
-- Idempotency: create or replace function + drop policy if exists → create。

begin;

-- =============================================================================
-- helper: 現在のクライアント JWT が指す project_id (有効な invitation のみ)
-- =============================================================================
create or replace function public.current_client_project()
returns uuid
language sql
security definer
stable
set search_path = public, pg_catalog
as $$
  select ci.project_id
  from public.client_invitations ci
  where ci.token_hash = nullif(auth.jwt() ->> 'invitation_token_hash', '')
    and ci.revoked_at is null
    and ci.expires_at > now()
  limit 1
$$;

comment on function public.current_client_project() is
  'R-T08: client JWT claim invitation_token_hash から有効 invitation の project_id を返す。'
  ' member 経路 (auth.uid()) とは独立。失効/期限切れ/不一致は NULL (= アクセス不可)。';

-- =============================================================================
-- helper: クライアント越境試行を audit_logs に記録 (アプリ層が呼ぶ、R-T08 監査要件)
-- =============================================================================
create or replace function public.audit_client_access_denied(
  p_attempted_project uuid,
  p_reason text default 'client_cross_project'
)
returns void
language sql
security definer
set search_path = public, pg_catalog
as $$
  insert into public.audit_logs
    (actor_type, actor_id, action, target_type, target_id, after)
  values
    ('anonymous',
     coalesce(auth.jwt() ->> 'invitation_token_hash', 'unknown'),
     'rls.client_cross_project_denied',
     'project',
     p_attempted_project,
     jsonb_build_object('reason', p_reason));
$$;

comment on function public.audit_client_access_denied(uuid, text) is
  'R-T08: クライアント越境試行を audit_logs に記録するための helper (アプリ層から呼ぶ)。';

-- =============================================================================
-- workflow_outputs: クライアントは自 project の成果物のみ閲覧可
-- =============================================================================
drop policy if exists workflow_outputs_client_select on public.workflow_outputs;
create policy workflow_outputs_client_select on public.workflow_outputs
  for select to authenticated
  using (
    public.current_client_project() is not null
    and project_id = public.current_client_project()
  );

-- =============================================================================
-- mocks: クライアントは自 project の画面モックのみ閲覧可
-- =============================================================================
drop policy if exists mocks_client_select on public.mocks;
create policy mocks_client_select on public.mocks
  for select to authenticated
  using (
    public.current_client_project() is not null
    and project_id = public.current_client_project()
  );

-- =============================================================================
-- comments: クライアントは自 invitation の comment を SELECT/INSERT 可 (scope=comment)
--   - SELECT: 自分が投稿した comment (author_invitation_id = 自 invitation)
--   - INSERT: author_invitation_id が自 invitation かつ自 project に属する場合のみ
-- =============================================================================
drop policy if exists comments_client_select on public.comments;
create policy comments_client_select on public.comments
  for select to authenticated
  using (
    author_invitation_id is not null
    and author_invitation_id in (
      select ci.id from public.client_invitations ci
      where ci.token_hash = nullif(auth.jwt() ->> 'invitation_token_hash', '')
        and ci.revoked_at is null
        and ci.expires_at > now()
    )
  );

drop policy if exists comments_client_insert on public.comments;
create policy comments_client_insert on public.comments
  for insert to authenticated
  with check (
    public.current_client_project() is not null
    and author_user_id is null
    and author_invitation_id in (
      select ci.id from public.client_invitations ci
      where ci.token_hash = nullif(auth.jwt() ->> 'invitation_token_hash', '')
        and ci.revoked_at is null
        and ci.expires_at > now()
    )
  );

commit;
