-- T-D-01: users / workspaces / workspace_memberships (E-001, E-002, E-003)
--
-- 信頼源: 04_functional_breakdown/entities.json
-- 関連 RLS: T-D-14 で users / workspace_memberships の per-entity policy 配置
--          T-D-15 で workspaces policy 配置 (本 migration は table + 基本制約のみ)
--
-- 適用方法:
--   supabase migration up         -- 増分適用
--   supabase db push              -- linked project (rgxwmdnqnlkgrgdfafih) に push
--   supabase db reset             -- 全 migration reapply (開発時)
--
-- Idempotency: CREATE IF NOT EXISTS + DO ブロックで re-run 安全。
--
-- ⚠️ R-T08 (致命級): users / workspaces / workspace_memberships は
--    クライアント別 JWT 経路完全分離 (T-D-22) の起点。RLS は T-D-14 / T-D-15 で
--    厳格に定義する。本 migration では RLS enable のみ行い、policy は別 task。

begin;

-- =============================================================================
-- E-003 前提: workspace_member_role_enum
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_type where typname = 'workspace_member_role_enum') then
    create type public.workspace_member_role_enum as enum ('owner', 'member', 'viewer');
  end if;
end $$;

-- =============================================================================
-- E-001: users
--   - id: Supabase auth.users.id と同一の UUID
--   - tenant_isolation: self-scoped (auth.uid() で識別)
-- =============================================================================
create table if not exists public.users (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text not null unique,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz
);

comment on table public.users is
  'E-001 User — Supabase Auth と同一 id でリンク。RLS: self-scoped (auth.uid() = id)。';
comment on column public.users.id is 'Supabase auth.users.id と同一 (1:1 リンク)';
comment on column public.users.deleted_at is 'soft delete。30 日猶予期間 (F-LEGAL-002)';

-- 検索/RLS で頻繁にアクセスされる列に index
create index if not exists users_email_idx on public.users (email) where deleted_at is null;

-- =============================================================================
-- E-002: workspaces
--   - tenant 単位 (id 自体が workspace_id)
--   - name は 2-50 chars 制約
--   - owner_user_id は users(id) FK
-- =============================================================================
create table if not exists public.workspaces (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid not null references public.users(id) on delete restrict,
  name           text not null,
  icon           text,
  plan           text not null default 'free',
  settings       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  constraint workspaces_name_length check (char_length(name) between 2 and 50)
);

comment on table public.workspaces is
  'E-002 Workspace — テナント単位。RLS: メンバーのみ閲覧可 (T-D-15 で配置)。';
comment on column public.workspaces.owner_user_id is
  'workspace 作成者。RESTRICT で誤削除を防ぐ。';
comment on column public.workspaces.plan is 'free / pro / enterprise (T-A-XX で課金連携)';
comment on column public.workspaces.icon is 'Lucide icon name または storage URL';

create index if not exists workspaces_owner_user_id_idx on public.workspaces (owner_user_id)
  where deleted_at is null;

-- =============================================================================
-- E-003: workspace_memberships
--   - workspace_id × user_id の複合 PK
--   - role: owner / member / viewer (workspace_member_role_enum)
-- =============================================================================
create table if not exists public.workspace_memberships (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null references public.users(id) on delete cascade,
  role         public.workspace_member_role_enum not null,
  joined_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

comment on table public.workspace_memberships is
  'E-003 WorkspaceMembership — N:M 中間テーブル。RLS: 自分の所属のみ (T-D-14)。';

create index if not exists workspace_memberships_user_id_idx
  on public.workspace_memberships (user_id);

-- =============================================================================
-- updated_at 自動更新トリガ (users / workspaces 共通)
-- =============================================================================
create or replace function public.set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'users_set_updated_at') then
    create trigger users_set_updated_at
      before update on public.users
      for each row execute function public.set_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'workspaces_set_updated_at') then
    create trigger workspaces_set_updated_at
      before update on public.workspaces
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- =============================================================================
-- RLS enable (policy は T-D-14 / T-D-15 で配置)
-- =============================================================================
alter table public.users                  enable row level security;
alter table public.workspaces             enable row level security;
alter table public.workspace_memberships  enable row level security;

commit;
