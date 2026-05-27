#!/usr/bin/env bash
# T-D-28: Migration 順序検証
#
# supabase/migrations/*.sql を辞書順 (= 適用順) に空 DB へ適用し、各 migration が
# エラーなく通ること、および全 `create table public.X` が実在することを検証する。
#
# 前提: DATABASE_URL は libpq 形式 (postgresql://...) の **スクラッチ DB**。
#       auth スキーマ / authenticated・anon・service_role ロール / extensions スキーマは
#       Supabase が標準提供する (ローカル raw Postgres ではブートストラップ済みであること)。
#
# Usage:
#   DATABASE_URL=postgresql://user:pass@host:5432/scratch ./scripts/migrate-verify.sh
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL (libpq 形式、スクラッチ DB) が必要}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGDIR="$ROOT/supabase/migrations"
PSQL=(psql -v ON_ERROR_STOP=1 -q -d "$DATABASE_URL")

mapfile -t FILES < <(ls "$MIGDIR"/*.sql | sort)
[ "${#FILES[@]}" -gt 0 ] || { echo "::error::no migrations found in $MIGDIR" >&2; exit 1; }

# 自己検証型 RLS migration (t-d-31/32 等) が authenticated ロールで実行されるため、
# Supabase が標準提供する public への role grant を確保する (スクラッチ DB 用)。
echo "→ ensuring Supabase-equivalent grants (authenticated/anon/service_role)"
"${PSQL[@]}" -c "grant usage on schema public to anon, authenticated, service_role;" 2>/dev/null || true
"${PSQL[@]}" -c "alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;" 2>/dev/null || true

echo "→ applying ${#FILES[@]} migrations in lexical order"
for f in "${FILES[@]}"; do
  if "${PSQL[@]}" -f "$f" >/tmp/migrate-verify.out 2>&1; then
    echo "  OK  $(basename "$f")"
  else
    echo "::error::migration failed: $(basename "$f")" >&2
    tail -8 /tmp/migrate-verify.out >&2
    exit 1
  fi
done

echo "→ verifying every 'create table public.X' exists"
EXPECTED="$(grep -rhoE 'create table if not exists public\.[a-z_]+' "$MIGDIR" \
  | grep -oE 'public\.[a-z_]+' | sort -u)"
missing=0
while read -r tbl; do
  [ -z "$tbl" ] && continue
  exists="$("${PSQL[@]}" -tAc "select to_regclass('$tbl') is not null;")"
  if [ "$exists" != "t" ]; then
    echo "::error::expected table missing after migrate: $tbl" >&2
    missing=$((missing+1))
  fi
done <<< "$EXPECTED"

if [ "$missing" -gt 0 ]; then
  echo "::error::$missing expected table(s) missing" >&2
  exit 1
fi
echo "✓ migrate-verify PASS ($(printf '%s\n' "$EXPECTED" | grep -c .) tables present)"
