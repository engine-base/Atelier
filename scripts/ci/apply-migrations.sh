#!/usr/bin/env bash
# supabase/migrations/*.sql を「辞書順ソート」で全適用する (CI Gate #14 / ローカル共用)。
#
# supabase CLI は t-*.sql の命名を <timestamp>_name.sql 規約違反として skip するため、
# 実 DB へのプロビジョンは本スクリプトが正本 (Gate #10 の静的監査と同じ sorted 順)。
#
# usage:
#   PGURL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" bash scripts/ci/apply-migrations.sh
set -euo pipefail

: "${PGURL:?PGURL (postgresql://...) を指定してください}"
cd "$(dirname "$0")/../.."

shopt -s nullglob
# glob 展開は辞書順 (Gate #10 の静的監査・実DB検証と同じ順序)
files=(supabase/migrations/*.sql)
if [ "${#files[@]}" -eq 0 ]; then
  echo "no migrations found" >&2
  exit 1
fi
for f in "${files[@]}"; do
  echo "== apply: $f"
  psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "== done: ${#files[@]} migrations applied"
