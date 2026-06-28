#!/usr/bin/env bash
# ローカル開発フルスタック ブートストラップ (登録→ログイン→画面 を実際に動かす)。
#
# 前提: ローカルに PostgreSQL 16 が起動していること (port 5432)。
#   - macOS: brew services start postgresql@16
#   - Ubuntu: sudo service postgresql start
#
# このスクリプトは:
#   1. atelier_dev DB + ロールを作成
#   2. Supabase 互換 shim (auth schema / auth.uid() 等) を流す
#   3. supabase/migrations/*.sql を順に適用 (Supabase 専用構文は continue-on-error)
#
# 実行後の起動手順は docs/local-dev-runbook.md を参照。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

DB_USER="${ATELIER_DEV_DB_USER:-atelier_dev}"
DB_PASS="${ATELIER_DEV_DB_PASS:-devpass}"
DB_NAME="${ATELIER_DEV_DB_NAME:-atelier_dev}"
PGHOST="${PGHOST:-localhost}"

echo "→ DB / ロール作成 ($DB_NAME)"
sudo -u postgres psql -c "DROP DATABASE IF EXISTS $DB_NAME" 2>/dev/null || true
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS' SUPERUSER" 2>/dev/null || true
sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"

echo "→ Supabase 互換 shim 適用"
PGPASSWORD="$DB_PASS" psql -h "$PGHOST" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  created_at timestamptz not null default now(),
  raw_app_meta_data jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb
);
-- auth.uid()/role(): 本番 Supabase 互換。API は request.jwt.claims (JSON 全体) を
-- セットするため、単数 claim だけでなく claims JSON からも sub/role を取り出す。
create or replace function auth.uid() returns uuid language sql stable as $fn$
  select nullif(coalesce(
    current_setting('request.jwt.claim.sub', true),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  ), '')::uuid $fn$;
create or replace function auth.role() returns text language sql stable as $fn$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    'anon'
  ) $fn$;
create or replace function auth.jwt() returns jsonb language sql stable as $fn$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $fn$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end $$;
SQL

echo "→ migration 適用 (Supabase 専用構文は skip)"
OK=0; SKIP=0
for f in $(ls supabase/migrations/*.sql | sort); do
  if PGPASSWORD="$DB_PASS" psql -h "$PGHOST" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1; then
    OK=$((OK + 1))
  else
    SKIP=$((SKIP + 1))
    echo "  ⚠ skip (Supabase 依存): $(basename "$f")"
  fi
done
echo "→ migration: $OK applied / $SKIP skipped"

# Supabase 本番が標準で付与する GRANT をローカルでも再現する。
# これが無いと authenticated ロールが public/auth スキーマにアクセスできず
# RLS 評価で "permission denied" → API が 500/0件 になる。
echo "→ ロール GRANT (Supabase 相当)"
PGPASSWORD="$DB_PASS" psql -h "$PGHOST" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q <<'SQL'
grant usage on schema public to authenticated, anon, service_role;
grant all on all tables in schema public to authenticated, service_role;
grant select on all tables in schema public to anon;
grant all on all sequences in schema public to authenticated, service_role;
alter default privileges in schema public grant all on tables to authenticated, service_role;
alter default privileges in schema public grant all on sequences to authenticated, service_role;
grant usage on schema auth to authenticated, anon, service_role;
grant execute on all functions in schema auth to authenticated, anon, service_role;
grant select on auth.users to authenticated, service_role;
alter default privileges in schema auth grant execute on functions to authenticated, anon, service_role;
SQL

echo ""
echo "✓ DB ブートストラップ完了。次は:"
echo "  export ATELIER_DB_URL='postgresql+asyncpg://$DB_USER:$DB_PASS@$PGHOST:5432/$DB_NAME'"
echo "  export ATELIER_AUTH_JWT_SECRET='dev-local-secret-please-change'"
echo "  詳細は docs/local-dev-runbook.md"
