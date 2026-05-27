#!/usr/bin/env bash
# DB スキーマ → ORM 型 自動生成・同期パイプライン (T-D-26 Drizzle / T-D-27 SQLAlchemy)
#
# 信頼源: supabase/migrations/*.sql (Supabase CLI 一本化)。
#   ORM 層の型はこの SQL に追従させる。本スクリプトは両 ORM の型が
#   migration と drift していないことを検証 (+ SQLAlchemy は実 DB から再生成) する。
#
# Usage:
#   ./scripts/sync-db-types.sh                 # Drizzle 静的検証 (+ DB があれば SQLAlchemy 生成)
#   DATABASE_URL=postgresql://... ./scripts/sync-db-types.sh
#
# 動作:
#   1. Drizzle (T-D-26): packages/db の型チェック + Drizzle schema ↔ migration の
#      テーブル集合 parity を検証 (DB 不要)。
#   2. SQLAlchemy (T-D-27): DATABASE_URL があれば sqlacodegen で実 DB から model を
#      生成 (apps/api/src/_generated/db_models.py)、生成結果のテーブル集合 parity を検証。
#
# 環境変数:
#   DATABASE_URL              sync driver の接続文字列 (例: postgresql+psycopg://...)。
#                             未設定なら SQLAlchemy 生成は skip し Drizzle 静的検証のみ。
#   ATELIER_DB_MODELS_OUT     SQLAlchemy model 出力先 (default: apps/api/src/_generated/db_models.py)
#
# CI では本スクリプト実行後 git diff で drift を検出する想定 (sync-types.sh と同方式)。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MIGRATIONS_DIR="supabase/migrations"
DRIZZLE_SCHEMA="packages/db/src/schema"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "::error::$MIGRATIONS_DIR not found" >&2
  exit 1
fi

# migration の create table 集合 (信頼源)
migration_tables() {
  grep -rhoE 'create table if not exists public\.[a-z_]+' "$MIGRATIONS_DIR" \
    | grep -oE 'public\.[a-z_]+' | sed 's/public\.//' | sort -u
}

# =============================================================================
# 1) Drizzle (T-D-26): 型チェック + schema ↔ migration parity
# =============================================================================
echo "→ [Drizzle] type-check @atelier/db"
pnpm --filter @atelier/db type-check

echo "→ [Drizzle] schema ↔ migration table parity"
DRIZZLE_TABLES="$(
  python3 - "$DRIZZLE_SCHEMA" <<'PY'
import re, sys, pathlib
names = set()
for f in pathlib.Path(sys.argv[1]).glob("*.ts"):
    names |= set(re.findall(r"pgTable\(\s*'([a-z_]+)'", f.read_text()))
print("\n".join(sorted(names)))
PY
)"
MIG_TABLES="$(migration_tables)"
if ! diff <(printf '%s\n' "$DRIZZLE_TABLES") <(printf '%s\n' "$MIG_TABLES") >/tmp/drizzle_drift.diff 2>&1; then
  echo "::error::[Drizzle] table set drift vs $MIGRATIONS_DIR:" >&2
  cat /tmp/drizzle_drift.diff >&2
  echo "対処: packages/db/src/schema/*.ts を migration に合わせて更新してください。" >&2
  exit 1
fi
echo "  ✓ Drizzle in sync ($(printf '%s\n' "$MIG_TABLES" | grep -c .) tables)"

# =============================================================================
# 2) SQLAlchemy (T-D-27): 実 DB から model を自動生成 + parity
# =============================================================================
OUT="${ATELIER_DB_MODELS_OUT:-apps/api/src/_generated/db_models.py}"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "::notice::[SQLAlchemy] DATABASE_URL 未設定 — 型生成 skip (Drizzle 静的検証のみ完了)。"
  echo "  実 DB を指定して再実行すると sqlacodegen で $OUT を再生成します。"
  exit 0
fi

echo "→ [SQLAlchemy] sqlacodegen で実 DB から model 生成 → $OUT"
mkdir -p "$(dirname "$OUT")"
uv tool run --from sqlacodegen --with 'psycopg[binary]' \
  sqlacodegen \
  --generator declarative \
  --schemas public \
  --outfile "$OUT" \
  "$DATABASE_URL"

echo "→ [SQLAlchemy] generated ↔ migration table parity"
SA_TABLES="$(
  grep -oE "__tablename__\s*=\s*'[a-z_]+'|__tablename__\s*=\s*\"[a-z_]+\"" "$OUT" \
    | grep -oE "[a-z_]+'|[a-z_]+\"" | tr -d "'\"" | sort -u
)"
if ! diff <(printf '%s\n' "$SA_TABLES") <(printf '%s\n' "$MIG_TABLES") >/tmp/sa_drift.diff 2>&1; then
  echo "::error::[SQLAlchemy] generated table set drift vs $MIGRATIONS_DIR:" >&2
  cat /tmp/sa_drift.diff >&2
  exit 1
fi
echo "  ✓ SQLAlchemy in sync ($(printf '%s\n' "$MIG_TABLES" | grep -c .) tables)"
echo "✓ sync-db-types complete"
