#!/usr/bin/env bash
# Postgres コンテナ初回起動時に /docker-entrypoint-initdb.d から実行される。
# Supabase 互換 shim を入れてから supabase/migrations/*.sql を順に適用する
# (Supabase 専用構文を含む migration は continue-on-error で skip)。
set -uo pipefail

DB="${POSTGRES_DB:-atelier_dev}"
USER="${POSTGRES_USER:-atelier_dev}"
PSQL=(psql -v ON_ERROR_STOP=1 --username "$USER" --dbname "$DB")

echo "→ Supabase 互換 shim 適用"
"${PSQL[@]}" <<'SQL'
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create schema if not exists auth;
create schema if not exists extensions;
-- pgvector (pgvector/pgvector イメージが提供)
create extension if not exists vector with schema extensions;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  created_at timestamptz not null default now(),
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb
);
create or replace function auth.uid() returns uuid language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;
create or replace function auth.role() returns text language sql stable as $fn$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $fn$;
create or replace function auth.jwt() returns jsonb language sql stable as $fn$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $fn$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
SQL

echo "→ migration 適用 (Supabase 依存は skip)"
OK=0
SKIP=0
for f in $(ls /migrations/*.sql | sort); do
  if psql -v ON_ERROR_STOP=1 --username "$USER" --dbname "$DB" -q -f "$f" >/dev/null 2>&1; then
    OK=$((OK + 1))
  else
    SKIP=$((SKIP + 1))
    echo "  ⚠ skip: $(basename "$f")"
  fi
done
echo "✓ DB init 完了: $OK applied / $SKIP skipped"
