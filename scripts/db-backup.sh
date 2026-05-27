#!/usr/bin/env bash
# Atelier DB 論理バックアップ (pg_dump)
#
# 対象: Supabase Postgres 16 (Tokyo region) の public スキーマ。
#       Supabase 管理スキーマ (auth / storage / realtime / vault 等) は
#       Supabase 側 PITR / 日次バックアップで保護されるため本スクリプトでは
#       app データ (public) のみを論理 dump する (復元時の所有権競合を避ける)。
#
# 使い方:
#   DATABASE_URL=postgresql://user:pass@host:5432/postgres ./scripts/db-backup.sh
#   ./scripts/db-backup.sh --schema-only      # スキーマのみ
#   ./scripts/db-backup.sh --data-only        # データのみ
#   ./scripts/db-backup.sh --verify FILE      # 既存 dump の健全性確認
#
# 出力: ${ATELIER_BACKUP_DIR:-./backups}/atelier-<scope>-<UTC timestamp>.dump
#       (pg_dump custom format -Fc。pg_restore で復元)
#
# 環境変数:
#   DATABASE_URL          接続文字列 (必須。--verify 時は不要)
#   ATELIER_BACKUP_DIR    出力先ディレクトリ (default: ./backups)
#
# リストア手順は docs/db/backup-restore.md を参照。
set -euo pipefail

SCOPE="full"
DUMP_FLAGS=()
VERIFY_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --schema-only) SCOPE="schema"; DUMP_FLAGS+=("--schema-only"); shift ;;
    --data-only)   SCOPE="data";   DUMP_FLAGS+=("--data-only"); shift ;;
    --verify)      VERIFY_FILE="${2:-}"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "❌ unknown arg: $1" >&2; exit 2 ;;
  esac
done

# --verify モード: dump ファイルの目録を出して健全性を確認
if [ -n "$VERIFY_FILE" ]; then
  if [ ! -f "$VERIFY_FILE" ]; then
    echo "❌ verify target not found: $VERIFY_FILE" >&2; exit 1
  fi
  echo "→ verifying $VERIFY_FILE"
  pg_restore --list "$VERIFY_FILE" >/dev/null
  echo "✓ valid pg_dump archive ($(pg_restore --list "$VERIFY_FILE" | grep -c ';') entries)"
  exit 0
fi

: "${DATABASE_URL:?DATABASE_URL is required (Supabase 接続文字列)}"

BACKUP_DIR="${ATELIER_BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/atelier-${SCOPE}-${TS}.dump"

echo "→ pg_dump (scope=$SCOPE) → $OUT"
# -Fc: custom format (圧縮 + pg_restore で選択復元可)
# --schema=public: app データのみ。Supabase 管理スキーマは除外。
# --no-owner / --no-privileges: 復元先の所有者/権限差異を吸収 (RLS policy は dump に含まれる)
pg_dump \
  --dbname="$DATABASE_URL" \
  --format=custom \
  --schema=public \
  --no-owner \
  --no-privileges \
  "${DUMP_FLAGS[@]}" \
  --file="$OUT"

# 取得直後に健全性確認
pg_restore --list "$OUT" >/dev/null
SIZE="$(du -h "$OUT" | cut -f1)"
echo "✓ backup complete: $OUT ($SIZE)"
echo "  復元: docs/db/backup-restore.md を参照 (pg_restore --dbname=... --no-owner $OUT)"
