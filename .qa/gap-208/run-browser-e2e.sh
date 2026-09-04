#!/usr/bin/env bash
# GAP-208 実ブラウザ e2e の実行 (使い捨てユーザーを 1 人作って、必ず消す)。
#
# 前提: web :3100 (next start / 本番ビルド) / API :8123 (uvicorn, JWT=e2e-secret) /
#       Postgres :54322 が動いていること。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
PSQL="psql postgresql://postgres@/postgres?host=/tmp&port=54322 -qtA"
U="$(python3 -c 'import uuid;print(uuid.uuid4())')"

cleanup() {
  $PSQL -c "delete from public.workspace_billing where workspace_id in
            (select id from public.workspaces where owner_user_id = '$U')" > /dev/null
  $PSQL -c "delete from public.workspace_memberships where user_id = '$U'" > /dev/null
  $PSQL -c "delete from public.workspaces where owner_user_id = '$U'" > /dev/null
  $PSQL -c "delete from public.consents where user_id = '$U'" > /dev/null
  $PSQL -c "delete from public.users where id = '$U'" > /dev/null
  $PSQL -c "delete from auth.users where id = '$U'" > /dev/null
}
trap cleanup EXIT

echo "[seed] 旧版の規約に同意済みの既存ユーザーを 1 人つくる (ワークスペースあり)"
$PSQL -c "insert into auth.users (id) values ('$U')" > /dev/null
$PSQL -c "insert into public.users (id, email) values ('$U', '$U@example.test')" > /dev/null
# owner membership は DB トリガーが自動で作る
WS="$($PSQL -c "insert into public.workspaces (name, owner_user_id) values ('GAP208 WS', '$U') returning id")"
$PSQL -c "insert into public.consents (user_id, type, version, accepted)
          values ('$U', 'terms_of_service', '2026-08-21', true),
                 ('$U', 'privacy_policy', '2026-08-20', true)" > /dev/null
# 契約者 (Pro) にする — **やめる口** が出るかを実際に見るため
$PSQL -c "insert into public.workspace_billing
          (workspace_id, stripe_customer_id, stripe_subscription_id, plan, status)
          values ('$WS', 'cus_e2e_gap208', 'sub_e2e_gap208', 'pro', 'active')" > /dev/null
$PSQL -c "update public.workspaces set plan = 'pro' where id = '$WS'" > /dev/null
echo "       user=$U / ws=$WS (Pro 契約者として seed)"
echo "       現行版: $($PSQL -c "select doc_type || '=' || version from legal_documents where is_current and locale='ja' order by doc_type" | tr '\n' ' ')"
echo

cd "$ROOT/apps/web" || exit 1
E2E_USER_ID="$U" E2E_WORKSPACE_ID="$WS" OUT="$ROOT/.qa/gap-208" node "$ROOT/.qa/gap-208/e2e-browser.mjs"
RC=$?
cd "$ROOT" || exit 1
exit $RC
