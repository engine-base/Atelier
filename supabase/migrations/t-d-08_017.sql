-- T-D-08: client_invitations (E-017)
--
-- 信頼源: 04_functional_breakdown/entities.json#E-017
-- 関連: F-L01 (クライアント招待 / 外部レビュー)
-- 依存: T-D-02 (projects), T-D-07 (comments forward ref 解消)
--
-- セキュリティ:
--   token_hash は SHA-256 hex (アプリ層で生成)。生 token は DB に保存しない。
--   token は invitation URL に含まれ、クライアントがアクセス時に hash 比較。
--
-- 連鎖:
--   作成順:
--     1. client_invitations 本体
--     2. ALTER comments ADD CONSTRAINT (T-D-07 forward ref 解消)

begin;

-- =============================================================================
-- E-017 client_invitations (workspace_scoped via project_id)
-- =============================================================================
create table if not exists public.client_invitations (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references public.projects(id) on delete cascade,
  email                text not null,
  token_hash           text not null unique,
  scopes               jsonb not null default '["view","comment"]'::jsonb,
  expires_at           timestamptz not null,
  used_at              timestamptz,
  revoked_at           timestamptz,
  client_display_name  text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint client_invitations_email_format
    check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),

  constraint client_invitations_token_hash_sha256
    check (token_hash ~ '^[a-f0-9]{64}$'),

  constraint client_invitations_scopes_array
    check (jsonb_typeof(scopes) = 'array'),

  constraint client_invitations_used_after_creation
    check (used_at is null or used_at >= created_at),

  constraint client_invitations_revoked_after_creation
    check (revoked_at is null or revoked_at >= created_at),

  -- F-L01 要件: 有効期限は数日 (最大 30 日まで許容、デフォルト 7 日)
  constraint client_invitations_expiry_reasonable
    check (expires_at > created_at and expires_at <= created_at + interval '30 days')
);

comment on table public.client_invitations is
  'E-017 ClientInvitation — クライアント外部レビュー用招待 (token-based、TTL)。F-L01。';
comment on column public.client_invitations.token_hash is
  'SHA-256 hex digest (生 token は DB に保存しない、URL 経由のみ)。UNIQUE。';
comment on column public.client_invitations.scopes is
  '権限スコープ配列。デフォルト ["view","comment"] (read + comment 可、edit 不可)';
comment on column public.client_invitations.expires_at is
  '有効期限。最大 30 日、デフォルト 7 日 (アプリ層で計算)';
comment on column public.client_invitations.used_at is
  '最初に accept された時刻。NULL なら未使用。';
comment on column public.client_invitations.revoked_at is
  '管理者による失効時刻。NULL なら有効。';

-- 高速 lookup 用 indexes
create index if not exists client_invitations_project_id_idx
  on public.client_invitations (project_id);
-- 有効 invitation を絞り込む partial index (used/revoked/expired 除外)
create index if not exists client_invitations_active_idx
  on public.client_invitations (project_id, expires_at)
  where used_at is null and revoked_at is null;
-- email 検索 (project 内で同一 email 招待を確認)
create index if not exists client_invitations_email_idx
  on public.client_invitations (project_id, email)
  where used_at is null and revoked_at is null;

-- =============================================================================
-- T-D-07 forward reference 解消: comments.author_invitation_id → client_invitations.id
-- =============================================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'comments_author_invitation_id_fkey'
  ) then
    alter table public.comments
      add constraint comments_author_invitation_id_fkey
      foreign key (author_invitation_id)
      references public.client_invitations(id)
      on delete set null;
  end if;
end $$;

-- =============================================================================
-- updated_at トリガ (T-D-01 set_updated_at() 再利用)
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'client_invitations_set_updated_at') then
    create trigger client_invitations_set_updated_at
      before update on public.client_invitations
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- =============================================================================
-- RLS enable + default-deny (T-D-17 で実 policy 配置予定)
-- =============================================================================
alter table public.client_invitations enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
    where schemaname='public' and tablename='client_invitations'
      and policyname='client_invitations_default_deny'
  ) then
    create policy client_invitations_default_deny on public.client_invitations
      as restrictive for all to public using (false);
  end if;
end $$;

commit;
