#!/usr/bin/env bash
# ローンチ前の本番 DB 全消去 (ADR-021 改訂 2026-09-03 / GAP-250)
#
# ローンチ前は本番 Supabase プロジェクトを staging として共用している。実顧客が入る前に
# QA で溜まったデータを **全部消して**、deploy.yml と同じコード (migration → seed) で
# 運営固定データだけを入れ直す。ダッシュボードの手作業ではなく、レビュー済みの
# 1 コマンドで、ガード付きで行う。
#
# 使い方 (経営者の Mac で。URL は GitHub secret PROD_DATABASE_URL と同じ Session pooler の値):
#   DATABASE_URL='postgresql://…' ./scripts/prelaunch-wipe.sh --env production-prelaunch --i-understand-this-deletes-everything
#   DATABASE_URL='postgresql://…' ./scripts/prelaunch-wipe.sh --env production-prelaunch --dry-run   # 何を消すかだけ見る
#
# ガード (どれか 1 つでも外れたら何もせず終了):
#   - DATABASE_URL (postgresql://…) と --i-understand-this-deletes-everything の両方が要る (無ければ usage / exit 2)
#   - --env (無ければ APP_ENV) が production-prelaunch か staging であること
#   - 03_architecture/selected-stack.json の environments.staging.phase が "pre-launch" で始まること
#     (ローンチ後 = 実顧客が入った後には二度と動かない)
#
# 手順:
#   1. backup   scripts/db-backup.sh (pg_dump public スキーマ)。失敗したら続行しない
#   2. wipe     public の全表を 1 トランザクションで TRUNCATE (運営固定の表は退避 → 復元)、
#               storage.objects (7 バケット) と auth.users を DELETE。スキーマ・表・migration は落とさない
#   3. reseed   deploy.yml と同じ: SCHEMA_ONLY=1 apply-migrations.sh → apply-seeds.sh
#   4. verify   全表の行数を出し、運営固定の行以外が残っていたら exit 1
#
# 消えるもの / 残るもの / 復元の手順は docs/prelaunch-wipe.md を参照。
# 秘密 (接続文字列のパスワード) は画面に出さない。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CONFIRM_FLAG="--i-understand-this-deletes-everything"
ALLOWED_ENVS="production-prelaunch staging"
STACK_JSON="03_architecture/selected-stack.json"

# 運営固定データ = 消さない表 (表名:残す行の条件)。seed / migration / 運営の管理画面が持ち主。
#   skills / ai_employee_templates : supabase/seed/t-d-24.sql (UPSERT)
#   legal_documents                : migration が正本 (gap-188/204/208。同意記録の突合に旧版も要る)
#   dispatch_control               : 単一行 (id=1) を migration が入れる
#   output_design_templates        : 運営既定 (is_platform_default) は管理画面で運営が作る。WS 版は消す
KEEP_TABLES=(
  "skills:true"
  "ai_employee_templates:true"
  "legal_documents:true"
  "dispatch_control:true"
  "output_design_templates:is_platform_default"
)
# GAP-242 の 7 バケット (storage.objects はこの中身だけ消す。バケット行は残す)
STORAGE_BUCKETS=(chat-attachments outputs mocks avatars meetings transcripts reference-uploads)

usage() {
  cat <<EOF
usage: DATABASE_URL='postgresql://…' $0 --env <production-prelaunch|staging> $CONFIRM_FLAG
       DATABASE_URL='postgresql://…' $0 --env <production-prelaunch|staging> --dry-run

  DATABASE_URL   本番 (= ローンチ前 staging) の接続文字列。deploy.yml の PROD_DATABASE_URL と同じ Session pooler の URL
  --env          APP_ENV の代わり。production-prelaunch か staging 以外は拒否
  $CONFIRM_FLAG
                 これを付けない限り消さない
  --dry-run      ガード + 消す対象と現在の行数だけ出す (backup も wipe もしない)

詳細: docs/prelaunch-wipe.md
EOF
}

ENV_ARG="${APP_ENV:-}"
CONFIRMED=0
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_ARG="${2:-}"; shift 2 ;;
    --env=*) ENV_ARG="${1#--env=}"; shift ;;
    "$CONFIRM_FLAG") CONFIRMED=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "❌ unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ── guard 1: DATABASE_URL + 確認フラグ ─────────────────────────────────────
if [ -z "${DATABASE_URL:-}" ] || [[ "$DATABASE_URL" != postgresql://* ]]; then
  echo "❌ DATABASE_URL (postgresql://…) が要ります" >&2; usage >&2; exit 2
fi
if [ "$CONFIRMED" -ne 1 ] && [ "$DRY_RUN" -ne 1 ]; then
  echo "❌ $CONFIRM_FLAG が無いので何もしません" >&2; usage >&2; exit 2
fi

# ── guard 2: 環境名 ────────────────────────────────────────────────────────
if [ -z "$ENV_ARG" ]; then
  echo "❌ --env (または APP_ENV) を production-prelaunch か staging で明示してください" >&2; usage >&2; exit 2
fi
case " $ALLOWED_ENVS " in
  *" $ENV_ARG "*) ;;
  *) echo "❌ env='$ENV_ARG' では実行しません (許可: $ALLOWED_ENVS)。ローンチ後の本番では二度と使わない" >&2; exit 2 ;;
esac

# ── guard 3: selected-stack.json の phase がまだ pre-launch ──────────────────
PHASE="$(python3 - "$STACK_JSON" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
print(d.get("environments", {}).get("staging", {}).get("phase", ""))
PY
)"
if [[ "$PHASE" != pre-launch* ]]; then
  echo "❌ $STACK_JSON environments.staging.phase='$PHASE' (pre-launch で始まらない)。ローンチ後の本番は消せません" >&2
  exit 2
fi

for c in psql pg_dump pg_restore python3; do
  command -v "$c" >/dev/null || { echo "❌ $c が無い" >&2; exit 2; }
done

# 接続文字列はパスワードを伏せて表示する
SAFE_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's#://([^:/@]+)(:[^@]*)?@#://\1:***@#')"
export DATABASE_URL
PSQL=(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q)
q() { "${PSQL[@]}" -At -c "$1"; }

has_rel() { [ "$(q "select to_regclass('$1') is not null")" = "t" ]; }

echo "== prelaunch-wipe: env=$ENV_ARG phase='$PHASE' target=$SAFE_URL"
q "select 1" >/dev/null || { echo "❌ DB に接続できません" >&2; exit 1; }

# public の表 (通常表のみ。パーティション子表・ビューは除く)
mapfile -t PUBLIC_TABLES < <(q "select tablename from pg_tables where schemaname='public' order by 1")
if [ "${#PUBLIC_TABLES[@]}" -eq 0 ]; then
  echo "❌ public に表が 1 つも無い (migration 未適用の DB?)。対象を間違えている可能性" >&2; exit 1
fi

keep_pred() {  # 表名 → 残す行の条件 ('' なら消す表)
  local t="$1" e
  for e in "${KEEP_TABLES[@]}"; do
    [ "${e%%:*}" = "$t" ] && { echo "${e#*:}"; return; }
  done
  echo ""
}

HAS_STORAGE_OBJECTS=0; has_rel storage.objects && HAS_STORAGE_OBJECTS=1
HAS_STORAGE_BUCKETS=0; has_rel storage.buckets && HAS_STORAGE_BUCKETS=1
HAS_AUTH_USERS=0;      has_rel auth.users      && HAS_AUTH_USERS=1
BUCKET_LIST="$(printf "'%s'," "${STORAGE_BUCKETS[@]}")"; BUCKET_LIST="${BUCKET_LIST%,}"

# ── 現在の行数 (dry-run の表示 / 実行前の記録) ──────────────────────────────
print_counts() {
  local t n pred
  printf '   %-36s %10s  %s\n' "table" "rows" "action"
  for t in "${PUBLIC_TABLES[@]}"; do
    n="$(q "select count(*) from public.\"$t\"")"
    pred="$(keep_pred "$t")"
    if [ -z "$pred" ]; then
      printf '   %-36s %10s  TRUNCATE\n' "public.$t" "$n"
    elif [ "$pred" = "true" ]; then
      printf '   %-36s %10s  KEEP (運営固定)\n' "public.$t" "$n"
    else
      printf '   %-36s %10s  KEEP where %s / 残りは消す\n' "public.$t" "$n" "$pred"
    fi
  done
  if [ "$HAS_AUTH_USERS" -eq 1 ]; then
    printf '   %-36s %10s  DELETE\n' "auth.users" "$(q "select count(*) from auth.users")"
  else
    printf '   %-36s %10s  SKIP (auth.users が無い)\n' "auth.users" "-"
  fi
  if [ "$HAS_STORAGE_OBJECTS" -eq 1 ]; then
    printf '   %-36s %10s  DELETE (bucket in %s)\n' "storage.objects" "$(q "select count(*) from storage.objects")" "${STORAGE_BUCKETS[*]}"
  else
    printf '   %-36s %10s  SKIP (storage スキーマが無い環境)\n' "storage.objects" "-"
  fi
  if [ "$HAS_STORAGE_BUCKETS" -eq 1 ]; then
    printf '   %-36s %10s  KEEP (migration gap-242 が持ち主)\n' "storage.buckets" "$(q "select count(*) from storage.buckets")"
  fi
}

echo "== 対象 (${#PUBLIC_TABLES[@]} public tables)"
print_counts

if [ "$DRY_RUN" -eq 1 ]; then
  echo "== dry-run: ここで終了 (backup も wipe もしていない)"
  exit 0
fi

# ── STEP 1: backup ─────────────────────────────────────────────────────────
echo "== [1/4] backup (scripts/db-backup.sh)"
BACKUP_OUT="$(bash scripts/db-backup.sh 2>&1 | tee /dev/stderr)" || {
  echo "❌ backup が失敗したので消しません" >&2; exit 1
}
BACKUP_FILE="$(printf '%s\n' "$BACKUP_OUT" | sed -n 's/^✓ backup complete: \([^ ]*\).*/\1/p' | tail -1)"
if [ -z "$BACKUP_FILE" ] || [ ! -s "$BACKUP_FILE" ]; then
  echo "❌ backup ファイルが確認できません (出力: $BACKUP_OUT)" >&2; exit 1
fi
bash scripts/db-backup.sh --verify "$BACKUP_FILE" >/dev/null || { echo "❌ backup の健全性確認に失敗" >&2; exit 1; }
echo "   backup: $BACKUP_FILE (public スキーマ。auth/storage は Supabase 側の日次バックアップ)"

# ── STEP 2: wipe ───────────────────────────────────────────────────────────
echo "== [2/4] wipe"
# public: 運営固定の行を temp 表へ退避 → 全表を 1 文で TRUNCATE (依存順不要・FK も一括) → 復元。
# 全部 1 トランザクション。途中で失敗したら何も変わらない。
{
  echo "begin;"
  for t in "${PUBLIC_TABLES[@]}"; do
    pred="$(keep_pred "$t")"
    [ -n "$pred" ] && echo "create temp table \"_keep_$t\" on commit drop as select * from public.\"$t\" where $pred;"
  done
  printf 'truncate table '
  first=1
  for t in "${PUBLIC_TABLES[@]}"; do
    [ "$first" -eq 1 ] || printf ', '
    printf 'public."%s"' "$t"; first=0
  done
  echo ' restart identity cascade;'
  for t in "${PUBLIC_TABLES[@]}"; do
    pred="$(keep_pred "$t")"
    [ -n "$pred" ] && echo "insert into public.\"$t\" select * from \"_keep_$t\";"
  done
  echo "commit;"
} > "${TMPDIR:-/tmp}/prelaunch-wipe-$$.sql"
"${PSQL[@]}" -f "${TMPDIR:-/tmp}/prelaunch-wipe-$$.sql"
rm -f "${TMPDIR:-/tmp}/prelaunch-wipe-$$.sql"
echo "   public: ${#PUBLIC_TABLES[@]} 表を TRUNCATE (運営固定 ${#KEEP_TABLES[@]} 表の行は復元)"

if [ "$HAS_STORAGE_OBJECTS" -eq 1 ]; then
  n="$(q "with d as (delete from storage.objects where bucket_id in ($BUCKET_LIST) returning 1) select count(*) from d")"
  echo "   storage.objects: $n 行 DELETE (${#STORAGE_BUCKETS[@]} バケット。バケット自体は残す)"
  echo "   注意: storage.objects の行を消しても S3 側の実ファイルは残る (課金対象外の孤児)。物理削除は docs/prelaunch-wipe.md §5"
else
  echo "   storage.objects: SKIP (storage スキーマが無い環境 — Supabase 以外)"
fi

if [ "$HAS_AUTH_USERS" -eq 1 ]; then
  n="$(q "with d as (delete from auth.users returning 1) select count(*) from d")"
  echo "   auth.users: $n 行 DELETE (identities / sessions / refresh_tokens は Supabase の FK cascade で消える)"
else
  echo "   auth.users: SKIP (auth.users が無い環境)"
fi

# ── STEP 3: reseed (deploy.yml と同じ手順・同じスクリプト) ───────────────────
echo "== [3/4] reseed (deploy.yml と同じ: apply-migrations.sh SCHEMA_ONLY=1 → apply-seeds.sh)"
SCHEMA_ONLY=1 PGURL="$DATABASE_URL" bash scripts/ci/apply-migrations.sh | tail -1
PGURL="$DATABASE_URL" bash scripts/ci/apply-seeds.sh | tail -1

# ── STEP 4: verify ─────────────────────────────────────────────────────────
echo "== [4/4] verify"
FAIL=0
printf '   %-36s %10s  %-14s %s\n' "table" "rows" "expected" "status"
check_row() {  # name rows expected ok(0/1)
  local st="OK"; [ "$4" -eq 1 ] || { st="FAIL"; FAIL=1; }
  printf '   %-36s %10s  %-14s %s\n' "$1" "$2" "$3" "$st"
}
for t in "${PUBLIC_TABLES[@]}"; do
  pred="$(keep_pred "$t")"
  n="$(q "select count(*) from public.\"$t\"")"
  if [ -z "$pred" ]; then
    ok=0; [ "$n" -eq 0 ] && ok=1
    check_row "public.$t" "$n" "0" "$ok"
  elif [ "$pred" = "true" ]; then
    ok=0; [ "$n" -gt 0 ] && ok=1
    check_row "public.$t" "$n" ">0 (seed)" "$ok"
  else
    other="$(q "select count(*) from public.\"$t\" where not ($pred)")"
    ok=0; [ "$other" -eq 0 ] && ok=1
    check_row "public.$t" "$n" "非固定=0" "$ok"
  fi
done
if [ "$HAS_AUTH_USERS" -eq 1 ]; then
  n="$(q "select count(*) from auth.users")"; ok=0; [ "$n" -eq 0 ] && ok=1
  check_row "auth.users" "$n" "0" "$ok"
else
  printf '   %-36s %10s  %-14s %s\n' "auth.users" "-" "-" "SKIP (無い環境)"
fi
if [ "$HAS_STORAGE_OBJECTS" -eq 1 ]; then
  n="$(q "select count(*) from storage.objects")"; ok=0; [ "$n" -eq 0 ] && ok=1
  check_row "storage.objects" "$n" "0" "$ok"
  [ "$ok" -eq 1 ] || echo "   ↑ 7 バケット以外にオブジェクトが残っている。バケット名を確認して手で判断する"
else
  printf '   %-36s %10s  %-14s %s\n' "storage.objects" "-" "-" "SKIP (無い環境)"
fi
if [ "$HAS_STORAGE_BUCKETS" -eq 1 ]; then
  n="$(q "select count(*) from storage.buckets where id in ($BUCKET_LIST)")"; ok=0; [ "$n" -eq "${#STORAGE_BUCKETS[@]}" ] && ok=1
  check_row "storage.buckets (gap-242)" "$n" "${#STORAGE_BUCKETS[@]}" "$ok"
fi

if [ "$FAIL" -ne 0 ]; then
  echo "❌ verify FAIL: 運営固定以外の行が残っている (上の FAIL 行)。backup: $BACKUP_FILE"
  exit 1
fi
echo "✓ prelaunch-wipe 完了: データは運営固定分のみ。backup: $BACKUP_FILE"
