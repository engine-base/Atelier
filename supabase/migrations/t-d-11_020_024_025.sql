-- T-D-11: audit_logs / consents / external_uploads (E-020, E-025, E-024)
--
-- 信頼源: 04_functional_breakdown/entities.json
-- 関連: F-LEGAL-001 (利用規約), F-LEGAL-004 (同意取得)
-- 依存: T-D-01 (users / workspaces), T-D-02 (projects for external_uploads)
--
-- 作成順:
--   1. enums (consent_type / external_upload_type)
--   2. audit_logs   (E-020, workspace_scoped, append-only)
--   3. consents     (E-025, user_scoped, append-only)
--   4. external_uploads (E-024, workspace_scoped via project, soft_delete)
--
-- ⚠️ 既知の仕様 drift:
--   apps/api/src/audit/writer.py (T-F-18) は table 名 'audit_log' (単数) と
--   column 名 (resource_type, resource_id, metadata, status_code) を期待するが、
--   entities.json は 'audit_logs' (複数) + (target_type, target_id, before, after)。
--   本 migration は entities.json を信頼源として実装。writer.py の整合は別 PR。

begin;

-- =============================================================================
-- Enums
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'consent_type_enum') then
    create type public.consent_type_enum as enum (
      'terms_of_service', 'privacy_policy', 'data_residency', 'ai_training_optin'
    );
  end if;
  if not exists (select 1 from pg_type where typname = 'external_upload_type_enum') then
    -- ⚠️ entities.json に values 未定義のため defensive default。
    -- 追加が必要になれば ALTER TYPE で拡張する (Postgres は enum 追加可)。
    create type public.external_upload_type_enum as enum (
      'document', 'image', 'audio', 'video', 'spreadsheet', 'archive', 'other'
    );
  end if;
end $$;

-- =============================================================================
-- E-020 audit_logs (workspace_scoped, append-only)
--
-- soft_delete: false。append-only 監査ログなので UPDATE / DELETE はアプリ層で禁止。
-- workspace_id は NULL 許容 (system 操作 / auth 失敗 / pre-auth event は workspace 不明)
-- =============================================================================
create table if not exists public.audit_logs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid references public.workspaces(id) on delete set null,
  actor_type    text not null,
  actor_id      text not null,
  action        text not null,
  target_type   text not null,
  target_id     uuid,
  "before"      jsonb,
  "after"       jsonb,
  ip_address    inet,
  created_at    timestamptz not null default now(),

  constraint audit_logs_actor_type_valid
    check (actor_type in ('ai', 'user', 'system', 'anonymous')),

  constraint audit_logs_before_object
    check ("before" is null or jsonb_typeof("before") in ('object', 'null')),

  constraint audit_logs_after_object
    check ("after" is null or jsonb_typeof("after") in ('object', 'null')),

  constraint audit_logs_action_format
    check (action ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$')
);

comment on table public.audit_logs is
  'E-020 AuditLog — workspace_scoped (NULL 許容で system / pre-auth 用)。append-only。';
comment on column public.audit_logs.actor_type is 'ai / user / system / anonymous';
comment on column public.audit_logs.actor_id is
  'actor_type=user なら users.id (UUID string)、ai なら ai_employees.id、system なら "system"';
comment on column public.audit_logs.action is
  'dot-separated lower snake (例: auth.signin, project.update, rls.bypass_attempt)';

create index if not exists audit_logs_workspace_created_idx
  on public.audit_logs (workspace_id, created_at desc);
create index if not exists audit_logs_actor_idx
  on public.audit_logs (actor_type, actor_id, created_at desc);
create index if not exists audit_logs_action_idx
  on public.audit_logs (action, created_at desc);
create index if not exists audit_logs_target_idx
  on public.audit_logs (target_type, target_id) where target_id is not null;

-- =============================================================================
-- E-025 consents (user_scoped, append-only)
--
-- F-LEGAL-004: 同意取得は (user_id, type, version) で一意の time series。
-- 過去同意の改ざん防止のため append-only (UPDATE / DELETE はアプリ層で禁止)。
-- =============================================================================
create table if not exists public.consents (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  type         public.consent_type_enum not null,
  version      text not null,
  accepted     boolean not null,
  accepted_at  timestamptz not null default now(),
  ip_address   inet,
  user_agent   text,
  created_at   timestamptz not null default now(),

  -- 同一 (user, type, version) で複数 record を許容 (re-prompt 履歴を残す)。
  -- 最新の accepted=true を「現在の同意状態」とアプリ層で判定。

  constraint consents_version_semver_or_date
    check (version ~ '^[0-9]+(\.[0-9]+)*$' or version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),

  constraint consents_user_agent_length
    check (user_agent is null or char_length(user_agent) <= 1000)
);

comment on table public.consents is
  'E-025 Consent — F-LEGAL-004 同意取得履歴 (append-only)。version で履歴管理。';
comment on column public.consents.type is
  'terms_of_service / privacy_policy / data_residency / ai_training_optin';
comment on column public.consents.version is
  'semver (1.0.0) or ISO date (2026-01-01) — どちらも許容';
comment on column public.consents.accepted is
  'true=同意 / false=拒否。最新 record をアプリ層で参照。';

create index if not exists consents_user_type_idx
  on public.consents (user_id, type, accepted_at desc);
create index if not exists consents_type_version_idx
  on public.consents (type, version, accepted_at desc);

-- =============================================================================
-- E-024 external_uploads (workspace_scoped via project, soft_delete)
-- =============================================================================
create table if not exists public.external_uploads (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references public.projects(id) on delete cascade,
  uploaded_by_user_id  uuid not null references public.users(id) on delete restrict,
  type                 public.external_upload_type_enum not null,
  storage_path         text not null,
  file_name            text not null,
  file_size_bytes      bigint not null,
  mime_type            text not null,
  parsed_at            timestamptz,
  parse_result_path    text,
  parse_error          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz,

  constraint external_uploads_file_size_range
    check (file_size_bytes >= 0 and file_size_bytes <= 1073741824),  -- 1 GiB

  constraint external_uploads_file_name_length
    check (char_length(file_name) between 1 and 255),

  constraint external_uploads_mime_format
    check (mime_type ~ '^[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+(;\s*[a-zA-Z0-9!#$&^_.+-]+=.*)?$')
);

comment on table public.external_uploads is
  'E-024 ExternalUpload — project への外部ファイル投入 (Supabase Storage 連携)。';
comment on column public.external_uploads.file_size_bytes is
  '最大 1 GiB (1073741824 bytes)。超過時はアプリ層で chunk upload に分岐';
comment on column public.external_uploads.parsed_at is
  'OCR / Markdown 変換等の解析完了時刻。NULL なら未解析。';
comment on column public.external_uploads.parse_result_path is
  'Supabase Storage 上の解析結果 (Markdown / JSON) パス';

create index if not exists external_uploads_project_idx
  on public.external_uploads (project_id, created_at desc) where deleted_at is null;
create index if not exists external_uploads_uploader_idx
  on public.external_uploads (uploaded_by_user_id, created_at desc) where deleted_at is null;
create index if not exists external_uploads_unparsed_idx
  on public.external_uploads (project_id, created_at)
  where parsed_at is null and parse_error is null and deleted_at is null;

-- =============================================================================
-- updated_at トリガ (external_uploads のみ。audit_logs / consents は append-only)
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'external_uploads_set_updated_at') then
    create trigger external_uploads_set_updated_at
      before update on public.external_uploads
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- =============================================================================
-- RLS enable + default-deny (T-D-19 で実 policy 配置予定)
-- =============================================================================
alter table public.audit_logs       enable row level security;
alter table public.consents         enable row level security;
alter table public.external_uploads enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='audit_logs' and policyname='audit_logs_default_deny'
  ) then
    create policy audit_logs_default_deny on public.audit_logs
      as restrictive for all to public using (false);
  end if;
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='consents' and policyname='consents_default_deny'
  ) then
    create policy consents_default_deny on public.consents
      as restrictive for all to public using (false);
  end if;
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='external_uploads' and policyname='external_uploads_default_deny'
  ) then
    create policy external_uploads_default_deny on public.external_uploads
      as restrictive for all to public using (false);
  end if;
end $$;

commit;
