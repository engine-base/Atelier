#!/usr/bin/env bash
# supabase/seed/*.sql を辞書順で適用する (本番 deploy / ローカル共用)。
#
# seed は運営固定データ (AI 社員テンプレ / skill / 法令ページ) で、全て UPSERT
# (on conflict do update/nothing) のため再実行安全。migration 適用後に流す。
# deploy.yml は migration → seed の順で実行し、新規 workspace が
# bootstrap トリガ (t-d-99) でテンプレから AI 社員を実体化できる状態にする。
#
# usage:
#   PGURL="postgresql://..." bash scripts/ci/apply-seeds.sh
set -euo pipefail

: "${PGURL:?PGURL (postgresql://...) を指定してください}"
cd "$(dirname "$0")/../.."

shopt -s nullglob
files=(supabase/seed/*.sql)
if [ "${#files[@]}" -eq 0 ]; then
  echo "no seeds found" >&2
  exit 0
fi
for f in "${files[@]}"; do
  echo "== seed: $f"
  psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "== done: ${#files[@]} seeds applied"
