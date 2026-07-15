#!/usr/bin/env bash
# supabase/migrations/*.sql を「辞書順ソート」で適用する (CI Gate #14 / 本番 deploy / ローカル共用)。
#
# supabase CLI は t-*.sql の命名を <timestamp>_name.sql 規約違反として skip するため、
# 実 DB へのプロビジョンは本スクリプトが正本 (Gate #10 の静的監査と同じ sorted 順)。
#
# スキーマ用マイグレーションは冪等 (create table if not exists / drop policy if exists →
# create policy / create or replace function) なので、部分適用済みの本番へ再適用しても安全。
#
# SCHEMA_ONLY=1 のとき `-- @verification-only` マーカー付きファイル (RLS 越境試験など
# fixture を insert/commit するスクリプト) を skip する。**本番 deploy では必ず SCHEMA_ONLY=1**
# (検証用 fixture を本番に流し込まないため)。CI Gate #14 は全適用 (SCHEMA_ONLY 未設定)。
#
# usage:
#   PGURL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" bash scripts/ci/apply-migrations.sh
#   SCHEMA_ONLY=1 PGURL="<prod>" bash scripts/ci/apply-migrations.sh   # 本番
set -euo pipefail

: "${PGURL:?PGURL (postgresql://...) を指定してください}"
SCHEMA_ONLY="${SCHEMA_ONLY:-0}"
cd "$(dirname "$0")/../.."

shopt -s nullglob
# glob 展開は辞書順 (Gate #10 の静的監査・実DB検証と同じ順序)
files=(supabase/migrations/*.sql)
if [ "${#files[@]}" -eq 0 ]; then
  echo "no migrations found" >&2
  exit 1
fi
applied=0
skipped=0
for f in "${files[@]}"; do
  if [ "$SCHEMA_ONLY" = "1" ] && head -5 "$f" | grep -q "@verification-only"; then
    echo "== skip (verification-only): $f"
    skipped=$((skipped + 1))
    continue
  fi
  echo "== apply: $f"
  psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$f"
  applied=$((applied + 1))
done
echo "== done: ${applied} applied / ${skipped} skipped (SCHEMA_ONLY=${SCHEMA_ONLY})"
