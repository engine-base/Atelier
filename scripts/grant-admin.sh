#!/usr/bin/env bash
# 既存アカウントを「運営 (admin)」に昇格させる (GAP-217)。
#
# なぜ要るか
# ----------
# 運営画面 (/admin 配下) は JWT の app_metadata.role == "admin" を要求する。
# その role の信頼源は **DB の auth.users.raw_app_meta_data だけ** で、
# ユーザー入力からは絶対に受け取らない (改ざんで運営になれないようにするため)。
#
# ところが、その DB 値を立てる手段が **script も画面も API も無かった**。
# 新しく構築した環境では「登録はできる・サインインもできる・けれど運営画面には
# 永久に入れない」状態になり、AI 社員テンプレも既定デザインも法務文書の改訂も
# 誰も触れない。2026-08-26 の通し (J00-03) で実際にその状態を踏んだ。
#
# 昇格は「本番 DB を触れる人」だけができる操作として、あえて画面には出さず
# この script に閉じる。誰が実行したかはサーバーの操作記録に残る。
#
# 使い方
# ------
#   # ローカル (scripts/dev-bootstrap.sh で作った DB)
#   bash scripts/grant-admin.sh you@example.com
#
#   # 任意の DB を指定 (本番・検証環境はこちら)
#   PGURL="postgresql://user:pass@host:5432/dbname" bash scripts/grant-admin.sh you@example.com
#
#   # 取り消す
#   bash scripts/grant-admin.sh you@example.com --revoke
#
# 実行後、**対象の人は一度サインアウトして入り直す**必要がある。
# アクセストークンはサインイン時に作られ、その時点の role を焼き込むため、
# 発行済みトークンは昇格を知らない。
set -uo pipefail

EMAIL="${1:-}"
MODE="${2:-grant}"

if [ -z "$EMAIL" ] || [ "$EMAIL" = "-h" ] || [ "$EMAIL" = "--help" ]; then
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

case "$MODE" in
  grant | --grant) ACTION="grant" ;;
  --revoke | revoke) ACTION="revoke" ;;
  *)
    echo "❌ 2 番目の引数は --revoke だけです (指定なしなら昇格): $MODE" >&2
    exit 1
    ;;
esac

# ローカル既定は scripts/dev-bootstrap.sh が作る DB に合わせる。
DB_USER="${ATELIER_DEV_DB_USER:-atelier_dev}"
DB_PASS="${ATELIER_DEV_DB_PASS:-devpass}"
DB_NAME="${ATELIER_DEV_DB_NAME:-atelier_dev}"
PGHOST="${PGHOST:-localhost}"
PGURL="${PGURL:-postgresql://${DB_USER}:${DB_PASS}@${PGHOST}:5432/${DB_NAME}}"

if ! command -v psql >/dev/null 2>&1; then
  echo "❌ psql が見つかりません。PostgreSQL クライアントを入れてください。" >&2
  exit 1
fi

# --- 対象が実在するか先に見る (無い相手に UPDATE を投げて 0 件で黙るのを防ぐ) --- #
FOUND=$(psql "$PGURL" -tAc \
  "select count(*) from auth.users where lower(email) = lower('${EMAIL//\'/\'\'}')" 2>/dev/null)

if [ -z "$FOUND" ]; then
  echo "❌ DB に接続できませんでした: $PGURL" >&2
  echo "   PGURL を指定するか、ローカルなら先に scripts/dev-bootstrap.sh を実行してください。" >&2
  exit 1
fi

if [ "$FOUND" = "0" ]; then
  echo "❌ そのメールアドレスのアカウントがありません: $EMAIL" >&2
  echo "   先に画面から新規登録を済ませてから、この script を実行してください。" >&2
  echo "   (この script はアカウントを作りません — 既にある人を運営にするだけです)" >&2
  exit 1
fi

# --- 昇格 / 取り消し ------------------------------------------------------- #
# raw_app_meta_data の他の値 (Supabase が入れる provider 等) を消さないよう、
# jsonb の合成で role キーだけを足し引きする。
if [ "$ACTION" = "grant" ]; then
  SQL="update auth.users
         set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{\"role\":\"admin\"}'::jsonb
       where lower(email) = lower('${EMAIL//\'/\'\'}')"
  VERB="運営に昇格"
else
  SQL="update auth.users
         set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) - 'role'
       where lower(email) = lower('${EMAIL//\'/\'\'}')"
  VERB="運営権限を取り消し"
fi

if ! psql "$PGURL" -v ON_ERROR_STOP=1 -q -c "$SQL"; then
  echo "❌ 更新に失敗しました。上のエラーを確認してください。" >&2
  exit 1
fi

# --- 結果を読み直して見せる (「実行した」ではなく「こうなった」を出す) ----- #
ROLE=$(psql "$PGURL" -tAc \
  "select coalesce(raw_app_meta_data->>'role', '(なし)') from auth.users
    where lower(email) = lower('${EMAIL//\'/\'\'}')")

echo "✅ ${VERB}: ${EMAIL}"
echo "   いまの role: ${ROLE}"
echo
echo "→ 対象の人は **一度サインアウトして入り直して**ください。"
echo "   アクセストークンはサインイン時にその時点の role を焼き込むため、"
echo "   発行済みのトークンはこの変更を知りません。"
