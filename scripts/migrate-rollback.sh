#!/usr/bin/env bash
# T-D-28: Migration rollback / 再構築の冪等性テスト
#
# Supabase migration は down スクリプトを持たない (CLI は前進専用) ため、
# 実運用の「ロールバック保証」は **完全な teardown → 再構築で同一スキーマに戻る**
# (= supabase db reset の再現性) で担保する。本スクリプトはそれを検証する:
#   1. 現在の public スキーマを dump (before)
#   2. drop schema public cascade → 再作成 (= teardown / rollback to empty)
#   3. 全 migration を再適用 (rebuild)
#   4. public スキーマを再 dump (after)
#   5. before と after が **差分なし** であることを確認 (元の状態に戻る)
#
# ⚠️ 破壊的: public スキーマを drop する。**スクラッチ DB のみ**で実行すること。
#    安全装置として ATELIER_MIGRATE_ALLOW_DESTRUCTIVE=1 を必須にする。
#
# Usage:
#   ATELIER_MIGRATE_ALLOW_DESTRUCTIVE=1 \
#   DATABASE_URL=postgresql://user:pass@host:5432/scratch ./scripts/migrate-rollback.sh
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL (libpq 形式、スクラッチ DB) が必要}"
if [ "${ATELIER_MIGRATE_ALLOW_DESTRUCTIVE:-}" != "1" ]; then
  echo "::error::破壊的操作のため ATELIER_MIGRATE_ALLOW_DESTRUCTIVE=1 を設定してください (スクラッチ DB 限定)" >&2
  exit 3
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGDIR="$ROOT/supabase/migrations"
PSQL=(psql -v ON_ERROR_STOP=1 -q -d "$DATABASE_URL")
DUMP=(pg_dump -s -n public --no-owner --no-privileges -d "$DATABASE_URL")

# dump を正規化 (非意味的な volatile 行を除去して安定比較):
#   - pg_dump 16 の \restrict/\unrestrict はダンプ毎にランダムなセッショントークン
#   - COMMENT ON SCHEMA public は initdb 既定スキーマ固有 (再作成 public には付かない)
normalize() {
  grep -vE '^(--|SET |SELECT pg_catalog|\\restrict|\\unrestrict|$)' \
    | grep -vE "^COMMENT ON SCHEMA public IS" \
    | sed '/^COMMENT ON EXTENSION/d'
}

mapfile -t FILES < <(ls "$MIGDIR"/*.sql | sort)

apply_all() {
  for f in "${FILES[@]}"; do "${PSQL[@]}" -f "$f" >/dev/null; done
}

echo "→ (1) dump before"
BEFORE="$("${DUMP[@]}" | normalize)"

echo "→ (2) teardown: drop schema public cascade + recreate"
"${PSQL[@]}" -c "drop schema public cascade; create schema public;"
# 再作成した public に Supabase 相当の role grant を再設定 (t-d-31/32 が authenticated で動くため)
"${PSQL[@]}" -c "grant usage on schema public to anon, authenticated, service_role;" 2>/dev/null || true
"${PSQL[@]}" -c "alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;" 2>/dev/null || true

echo "→ (3) rebuild: 全 migration 再適用 (${#FILES[@]} files)"
apply_all

echo "→ (4) dump after"
AFTER="$("${DUMP[@]}" | normalize)"

echo "→ (5) diff before/after"
if diff <(printf '%s\n' "$BEFORE") <(printf '%s\n' "$AFTER") >/tmp/migrate-rollback.diff 2>&1; then
  echo "✓ migrate-rollback PASS — teardown→rebuild で元のスキーマに完全復帰 (差分なし)"
else
  echo "::error::rebuild 後にスキーマ差分が発生 (冪等でない migration):" >&2
  head -40 /tmp/migrate-rollback.diff >&2
  exit 1
fi
