#!/usr/bin/env bash
# ローカル開発フルスタック ブートストラップ (登録→ログイン→画面 を実際に動かす)。
#
# 前提: ローカルに PostgreSQL 16+ が起動していること (port 5432)。
#   - macOS: brew install postgresql@17 pgvector && brew services start postgresql@17
#     (pgvector はナレッジ RAG の vector 型に必要 — 無いと該当 migration が skip され
#      チャットが 500 になる)
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

# superuser 接続の OS 差分:
#   - Linux (apt): postgres OS ユーザー経由 (sudo -u postgres)
#   - macOS (Homebrew): postgres OS ユーザーは存在せず、brew services で起動した
#     PostgreSQL は現ユーザーが superuser。psql -d postgres で直接接続する。
if [[ "$(uname)" == "Darwin" ]]; then
  super_psql() { psql -d postgres "$@"; }
  super_createdb() { createdb "$@"; }
else
  super_psql() { sudo -u postgres psql "$@"; }
  super_createdb() { sudo -u postgres createdb "$@"; }
fi

echo "→ DB / ロール作成 ($DB_NAME)"
super_psql -c "DROP DATABASE IF EXISTS $DB_NAME" 2>/dev/null || true
super_psql -tc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1 \
  || super_psql -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS' SUPERUSER" 2>/dev/null || true
super_createdb -O "$DB_USER" "$DB_NAME"

echo "→ Supabase 互換 shim 適用"
PGPASSWORD="$DB_PASS" psql -h "$PGHOST" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL'
create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
-- Supabase 互換: extensions スキーマ (migration が extensions.vector を参照する。
-- スキーマが無いと vector 系 → chat_threads → chat 全テーブルが連鎖 skip し
-- チャットが動かない DB になる)
create schema if not exists extensions;
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
grant usage on schema extensions to authenticated, anon, service_role;
grant execute on all functions in schema auth to authenticated, anon, service_role;
grant select on auth.users to authenticated, service_role;
alter default privileges in schema auth grant execute on functions to authenticated, anon, service_role;
SQL

# 運営固定シード (AI 社員テンプレ / skill / 法令ページ)。これが無いと
# workspace 作成トリガ (t-d-99) が実体化する AI 社員が 0 名になり、
# 「AI 社員がいません」でチャットも始められない (Mac 実機検証で検出した実事故)。
echo "→ 運営シード適用 (supabase/seed/*.sql)"
SEED_OK=0
for f in $(ls supabase/seed/*.sql 2>/dev/null | LC_ALL=C sort); do
  if PGPASSWORD="$DB_PASS" psql -h "$PGHOST" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1; then
    SEED_OK=$((SEED_OK + 1))
  else
    echo "  ⚠ seed 失敗: $(basename "$f") — 運営テンプレ欠落のまま起動しない (要調査)"
  fi
done
echo "→ seed: $SEED_OK applied"

# 既存 workspace への AI 社員バックフィル (シード前に作られた WS を救済 — 冪等)
echo "→ 既存 workspace の AI 社員バックフィル"
PGPASSWORD="$DB_PASS" psql -h "$PGHOST" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q <<'SQL'
insert into public.ai_employees (
  workspace_id, template_id, name, display_name, icon,
  role, department, attached_skills, attached_knowledge_cats,
  system_prompt_override, is_default
)
select w.id, t.id, t.default_name, t.default_display_name, t.default_icon,
       t.role, t.department, t.default_skills, t.default_knowledge_cats,
       t.system_prompt, true
from public.workspaces w
cross join public.ai_employee_templates t
where t.is_active = true
on conflict do nothing;
SQL

echo ""
echo "✓ DB ブートストラップ完了。次は:"
echo "  export ATELIER_DB_URL='postgresql+asyncpg://$DB_USER:$DB_PASS@$PGHOST:5432/$DB_NAME'"
echo "  export ATELIER_AUTH_JWT_SECRET='dev-local-secret-please-change'"
echo "  詳細は docs/local-dev-runbook.md"
