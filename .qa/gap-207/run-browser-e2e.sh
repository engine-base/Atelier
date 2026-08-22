#!/usr/bin/env bash
# GAP-207 実ブラウザ e2e の実行 (使い捨てユーザーを 2 人作って、必ず消す)。
#
# 前提: web :3100 (next start / 本番ビルド) / API :8123 (uvicorn, JWT=e2e-secret) /
#       Postgres :54322 が動いていること。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PSQL="psql postgresql://postgres@/postgres?host=/tmp&port=54322 -qtA"
NEW="$(python3 -c 'import uuid;print(uuid.uuid4())')"
OLD="$(python3 -c 'import uuid;print(uuid.uuid4())')"

cleanup() {
  # 作成されたワークスペース (と membership) ごと消す
  for u in "$NEW" "$OLD"; do
    $PSQL -c "delete from public.workspace_memberships where user_id = '$u'" > /dev/null
    $PSQL -c "delete from public.workspaces where owner_user_id = '$u'" > /dev/null
    $PSQL -c "delete from public.consents where user_id = '$u'" > /dev/null
    $PSQL -c "delete from public.users where id = '$u'" > /dev/null
    $PSQL -c "delete from auth.users where id = '$u'" > /dev/null
  done
}
trap cleanup EXIT

echo "[seed] ワークスペースが無い人 / ある人 を 1 人ずつ作る"
for u in "$NEW" "$OLD"; do
  $PSQL -c "insert into auth.users (id) values ('$u')" > /dev/null
  $PSQL -c "insert into public.users (id, email) values ('$u', '$u@example.test')" > /dev/null
done
# owner の membership は DB トリガーが自動で作る
WS="$($PSQL -c "insert into public.workspaces (name, owner_user_id) values ('既存WS', '$OLD') returning id")"
echo "       new(ws無し)=$NEW"
echo "       old(ws有り)=$OLD / ws=$WS"
echo

# @playwright/test は apps/web に入っているので、そこから解決させる
cd "$ROOT/apps/web"
E2E_USER_NEW="$NEW" E2E_USER_WITH_WS="$OLD" OUT="$ROOT/.qa/gap-207" \
  node "$ROOT/.qa/gap-207/e2e-browser.mjs"
RC=$?
cd "$ROOT"

echo
echo "[DB] 実際にワークスペースが作られたか (画面の言い分ではなく DB を見る)"
$PSQL -c "select name || ' / owner=' || owner_user_id from public.workspaces where owner_user_id = '$NEW'"
exit $RC
