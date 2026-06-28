-- T-D-36: project_credentials — プロジェクト・クレデンシャルシークレット (E-022 関連)
--
-- 信頼源: docs/project-vault-design.md
-- 関連: BYOK (byok_api_keys) と同じ Fernet 暗号 + RLS パターンを project_id 軸に流用。
-- 依存: T-D-05 (projects), T-D-15 (projects RLS / current_user_workspaces)
--
-- 設計:
--   各プロジェクトの機密データ (顧客/案件の API キー・パスワード・トークン・接続文字列)
--   を暗号化保存するシークレット。資料/ドキュメントは knowledge_* が担当、本表は機密専用。
--
-- セキュリティ:
--   - encrypted_value: アプリ層 (Fernet) で暗号化済の ciphertext のみ保存。平文は保存しない。
--   - last4: 一覧 UI の識別用に末尾4文字のみ平文保持 (任意)。秘匿性は低い。
--   - 暗号鍵は DB の外 (環境変数 ATELIER_VAULT_ENCRYPTION_KEY)。
--   - tenant 経路: project_id → workspace。RLS は T-D-36_rls で配置。
--
-- Idempotency: CREATE IF NOT EXISTS + DO ブロックで re-run 安全。

begin;

-- =============================================================================
-- credential 種別 enum
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'credential_kind_enum') then
    create type public.credential_kind_enum as enum (
      'api_key', 'password', 'token', 'connection_string', 'other'
    );
  end if;
end $$;

-- =============================================================================
-- E-022 project_credentials (workspace_scoped via project_id)
-- =============================================================================
create table if not exists public.project_credentials (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects(id) on delete cascade,

  -- 表示
  name             text not null,
  kind             public.credential_kind_enum not null default 'other',

  -- 機密本体 (Fernet 暗号化済 ciphertext, urlsafe-base64)。平文は保存しない。
  encrypted_value  text not null,
  -- 一覧 UI 用に末尾4文字のみ平文保持 (識別用、任意)
  last4            text,

  -- 監査用
  created_by       uuid references public.users(id) on delete set null,

  -- timestamps + soft delete
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,

  constraint project_credentials_name_length
    check (char_length(name) between 1 and 200),
  constraint project_credentials_last4_length
    check (last4 is null or char_length(last4) <= 4)
);

comment on table public.project_credentials is
  'E-022 プロジェクト・シークレット — 機密クレデンシャルを Fernet 暗号化保存。project_id 経由で workspace scoped。RLS で越境=0。';
comment on column public.project_credentials.encrypted_value is
  'Fernet 暗号化済 ciphertext。平文は保存も応答もしない (reveal API でのみ復号)。';
comment on column public.project_credentials.last4 is
  '一覧 UI 識別用の末尾4文字 (平文)。秘匿性低。';

create index if not exists project_credentials_project_idx
  on public.project_credentials (project_id, created_at desc)
  where deleted_at is null;

-- RLS 有効化 (policy は t-d-36_project_credentials_rls.sql で配置)
alter table public.project_credentials enable row level security;

commit;
