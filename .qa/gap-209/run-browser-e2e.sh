#!/usr/bin/env bash
# GAP-209 実ブラウザ e2e の実行 (使い捨てユーザーを 1 人作って、必ず消す)。
#
# 見るもの:
#   ① 「帰れない画面」が無くなったか (t-uc-36〜40 にシェル / t-uc-35 は素のまま)
#   ② 「出る口」が本当に効くか (サインアウト → **サーバー側で refresh が失効する**)
#
# 前提: web :3100 (next start / 本番ビルド) / API :8123 (uvicorn, JWT=e2e-secret) /
#       Postgres :54322 が動いていること。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
PSQL="psql postgresql://postgres@/postgres?host=/tmp&port=54322 -qtA"
U="$(python3 -c 'import uuid;print(uuid.uuid4())')"
EMAIL="$U@example.com"

cleanup() {
  $PSQL -c "delete from public.audit_logs where actor_id in ('$U', '$EMAIL')" > /dev/null
  $PSQL -c "delete from public.workspace_memberships where user_id = '$U'" > /dev/null
  $PSQL -c "delete from public.workspaces where owner_user_id = '$U'" > /dev/null
  $PSQL -c "delete from public.consents where user_id = '$U'" > /dev/null
  $PSQL -c "delete from public.users where id = '$U'" > /dev/null
  $PSQL -c "delete from auth.users where id = '$U'" > /dev/null
}
trap cleanup EXIT

echo "[seed] ワークスペースを持つ既存ユーザーを 1 人つくる"
$PSQL -c "insert into auth.users (id) values ('$U')" > /dev/null
$PSQL -c "insert into public.users (id, email) values ('$U', '$EMAIL')" > /dev/null
# owner membership は DB トリガーが自動で作る
WS="$($PSQL -c "insert into public.workspaces (name, owner_user_id) values ('GAP209 WS', '$U') returning id")"
# 現行版の規約に同意済みにしておく (再同意の帯を出さず、素の画面を見る)
$PSQL -c "insert into public.consents (user_id, type, version, accepted)
          select '$U', doc_type::text::consent_type_enum, version, true from public.legal_documents
          where is_current and locale = 'ja' and doc_type in ('terms_of_service','privacy_policy')" > /dev/null

# **盗まれた refresh token** の想定で 2 本仕込む。
#   BEFORE = サインアウト前に使ってみる (土台: 失効前は通ることを見る)
#   AFTER  = サインアウト後に使ってみる (本題: 失効していることを見る)
# 2 本に分けるのは、refresh が rotate 方式で 1 度使うと消費されるため。
# 中身は audit_logs では sha256 なので、平文はここで作って e2e に渡す。
seed_refresh() {
  local plain hash
  plain="$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
  hash="$(python3 -c "import hashlib,sys;print(hashlib.sha256(sys.argv[1].encode()).hexdigest())" "$plain")"
  $PSQL -c "insert into public.audit_logs (actor_type, actor_id, action, target_type, target_id, after)
            values ('anonymous', '$EMAIL', 'auth.refresh.issued', 'auth_token', gen_random_uuid(),
                    jsonb_build_object('email','$EMAIL','token_hash','$hash',
                      'user_id','$U','origin','e2e',
                      'expires_epoch', (extract(epoch from now())::bigint + 86400)))" > /dev/null
  echo "$plain"
}
BEFORE="$(seed_refresh)"
AFTER="$(seed_refresh)"
echo "       user=$U / ws=$WS / refresh token を 2 本 (before/after) 発行済みにした"
echo

cd "$ROOT/apps/web" || exit 1
E2E_USER_ID="$U" E2E_WORKSPACE_ID="$WS" \
  E2E_REFRESH_BEFORE="$BEFORE" E2E_REFRESH_AFTER="$AFTER" \
  OUT="$ROOT/.qa/gap-209" node "$ROOT/.qa/gap-209/e2e-browser.mjs"
RC=$?
cd "$ROOT" || exit 1
exit $RC
