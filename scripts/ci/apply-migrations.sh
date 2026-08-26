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
pending=()
for f in "${files[@]}"; do
  if [ "$SCHEMA_ONLY" = "1" ] && head -5 "$f" | grep -q "@verification-only"; then
    echo "== skip (verification-only): $f"
    skipped=$((skipped + 1))
    continue
  fi
  pending+=("$f")
done

# GAP-220: 「依存が解けるまで」何周でも回す。
#
# ファイル名の辞書順と依存順は一致しない (gap-*.sql < t-d-*.sql)。1 周だけだと
# **後から入った gap-* が土台の t-d-* より先に走って必ず失敗する**。実際 CI は
# 2 本目の gap-131 が `relation "public.project_credentials" does not exist` で
# 止まり、**Gate #14 (real-PG integration) と Gate #15 (browser E2E) は DB を
# 用意できず、本体が一度も走っていなかった**。
#
# GAP-172 で dev-bootstrap.sh は同じ方式に直してあったが、**CI 側のこの
# スクリプトは直し忘れていた**。同じ穴を 2 か所に空けたまま、ローカルだけ
# 塞いでいた。
#
# 1 周で 1 本でも新しく通れば次の周でさらに通せる → 進捗ゼロになるまで繰り返す。
# **最後まで通らなかったものは黙って飲み込まず、エラーを出して落とす**
# (「skip した」で緑にすると、欠けた DB で緑になる — それが一番危ない)。
round=0
while [ "${#pending[@]}" -gt 0 ]; do
  round=$((round + 1))
  next=()
  progress=0
  for f in "${pending[@]}"; do
    if psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1; then
      echo "== apply (round ${round}): $f"
      applied=$((applied + 1))
      progress=$((progress + 1))
    else
      next+=("$f")
    fi
  done
  pending=("${next[@]+"${next[@]}"}")
  [ "$progress" -eq 0 ] && break
done

if [ "${#pending[@]}" -gt 0 ]; then
  echo "::error::${#pending[@]} 本の migration が適用できませんでした (${round} 周で収束せず)" >&2
  for f in "${pending[@]}"; do
    echo "-- $f" >&2
    psql "$PGURL" -v ON_ERROR_STOP=1 -q -f "$f" 2>&1 >/dev/null | head -3 >&2
  done
  exit 1
fi

echo "== done: ${applied} applied / ${skipped} skipped (${round} 周で収束 / SCHEMA_ONLY=${SCHEMA_ONLY})"
