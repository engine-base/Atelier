-- CI 用: 素の Postgres (pgvector イメージ) を Supabase 互換の最小基盤にする。
--
-- ローカルの supabase start は auth schema / roles / default privileges を
-- 自動提供するが、CI の services コンテナは素の PG のため、migration 適用前に
-- この bootstrap を流す。Gate #14 (real-PG integration) と scripts/ci/apply-migrations.sh
-- が前提とする。
--
-- 冪等: 全て if not exists / or replace / DO ブロックの存在チェック付き。

-- ── roles (supabase 互換) ────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    -- t-i-08 が rolbypassrls = true を要求 (R-T07)
    create role service_role nologin bypassrls;
  end if;
end $$;

grant anon, authenticated, service_role to postgres;

-- ── schemas ──────────────────────────────────────────────────────────────
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create schema if not exists auth;

-- ── auth.users (GoTrue 互換の最小形) ─────────────────────────────────────
create table if not exists auth.users (
  id                  uuid primary key,
  email               text unique,
  encrypted_password  text,
  created_at          timestamptz not null default now()
);

-- ── auth.uid() / auth.role() (request.jwt.claims GUC から解決) ──────────
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select ((nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'sub')::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb) ->> 'role'
$$;

-- ── privileges ───────────────────────────────────────────────────────────
grant usage on schema public, auth, extensions to anon, authenticated, service_role;
grant select, insert, update, delete on auth.users to authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

-- 以後 postgres が作る public のオブジェクトに自動 grant (supabase の既定に相当)。
-- 列レベル保護 (例 byok_api_keys.encrypted_key) は各 migration が明示 revoke する。
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant usage, select on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema extensions
  grant execute on functions to anon, authenticated, service_role;
grant usage on type extensions.vector to anon, authenticated, service_role;
