-- T-D-12: mcp_tokens (E-021) / byok_api_keys (E-022)
--
-- 信頼源: 04_functional_breakdown/entities.json#E-021, E-022
-- 関連: F-P01 (MCP サーバアクセストークン), BYOK (T-F-19 Supabase Vault 連携)
-- 依存: T-D-01 (workspaces / users / set_updated_at()), T-F-19 (Vault byok 層)
--
-- セキュリティ:
--   - mcp_tokens.token_hash は SHA-256 hex (生 token は DB に保存しない)。
--   - byok_api_keys.encrypted_key は Supabase Vault secret の id (uuid text)。
--     平文鍵は vault.secrets に暗号化保管され本テーブルには置かない (T-F-19)。
--   - RLS は本 migration で enable + default-deny。実 policy は T-D-20 で配置。

begin;

-- =============================================================================
-- E-021 mcp_tokens (workspace_scoped)
-- =============================================================================
create table if not exists public.mcp_tokens (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  token_hash    text not null unique,
  name          text not null,
  scopes        text[] not null default array[]::text[],
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint mcp_tokens_token_hash_sha256
    check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint mcp_tokens_name_length
    check (char_length(name) between 1 and 100),
  constraint mcp_tokens_revoked_after_creation
    check (revoked_at is null or revoked_at >= created_at),
  constraint mcp_tokens_expiry_after_creation
    check (expires_at is null or expires_at > created_at)
);

comment on table public.mcp_tokens is
  'E-021 McpToken — MCP サーバアクセストークン (F-P01)。workspace_scoped。';
comment on column public.mcp_tokens.token_hash is
  'SHA-256 hex digest (生 token は DB に保存しない)。UNIQUE。';

create index if not exists mcp_tokens_workspace_idx
  on public.mcp_tokens (workspace_id);
create index if not exists mcp_tokens_active_idx
  on public.mcp_tokens (workspace_id)
  where revoked_at is null;

-- =============================================================================
-- E-022 byok_api_keys (user_scoped, Supabase Vault 連携)
-- =============================================================================
create table if not exists public.byok_api_keys (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users(id) on delete cascade,
  provider       text not null,
  encrypted_key  text not null,
  key_label      text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint byok_api_keys_provider_valid
    check (provider in ('claude', 'openai', 'gemini')),
  constraint byok_api_keys_key_label_length
    check (key_label is null or char_length(key_label) between 1 and 100)
);

comment on table public.byok_api_keys is
  'E-022 ByokApiKey — ユーザー API キー (Supabase Vault 暗号化保管、T-F-19)。user_scoped。';
comment on column public.byok_api_keys.encrypted_key is
  'Supabase Vault secret の id (uuid text)。平文は vault.secrets に暗号化保管。';

create index if not exists byok_api_keys_user_idx
  on public.byok_api_keys (user_id);
create index if not exists byok_api_keys_user_provider_active_idx
  on public.byok_api_keys (user_id, provider)
  where is_active;

-- =============================================================================
-- updated_at トリガ (T-D-01 set_updated_at() 再利用)
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'mcp_tokens_set_updated_at') then
    create trigger mcp_tokens_set_updated_at
      before update on public.mcp_tokens
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'byok_api_keys_set_updated_at') then
    create trigger byok_api_keys_set_updated_at
      before update on public.byok_api_keys
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- =============================================================================
-- RLS enable + default-deny (実 policy は T-D-20)
-- =============================================================================
alter table public.mcp_tokens enable row level security;
alter table public.byok_api_keys enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='mcp_tokens' and policyname='mcp_tokens_default_deny'
  ) then
    create policy mcp_tokens_default_deny on public.mcp_tokens
      as restrictive for all to public using (false);
  end if;
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='byok_api_keys' and policyname='byok_api_keys_default_deny'
  ) then
    create policy byok_api_keys_default_deny on public.byok_api_keys
      as restrictive for all to public using (false);
  end if;
end $$;

commit;
