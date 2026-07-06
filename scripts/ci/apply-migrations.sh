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

count=0
for f in $(ls supabase/migrations/*.sql | sort); do
  echo "== apply: $f"
  psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$f"
  count=$((count + 1))
done
echo "== done: ${count} migrations applied"
