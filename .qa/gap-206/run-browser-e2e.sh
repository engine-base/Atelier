#!/usr/bin/env bash
# GAP-206 実ブラウザ e2e の実行 (使い捨てユーザーを 2 人作って、必ず消す)。
#
# 前提: web :3100 (next start) / API :8123 (uvicorn, JWT=e2e-secret) /
#       Postgres :54322 が動いていること。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || exit 1
PSQL="psql postgresql://postgres@/postgres?host=/tmp&port=54322 -qtA"
U1="$(python3 -c 'import uuid;print(uuid.uuid4())')"
U2="$(python3 -c 'import uuid;print(uuid.uuid4())')"

cleanup() {
  for u in "$U1" "$U2"; do
    $PSQL -c "delete from public.consents where user_id = '$u'" > /dev/null
    $PSQL -c "delete from public.users where id = '$u'" > /dev/null
    $PSQL -c "delete from auth.users where id = '$u'" > /dev/null
  done
}
trap cleanup EXIT

echo "[seed] 旧版 (2026-05-25) に同意したままの利用者を 2 人つくる"
for u in "$U1" "$U2"; do
  $PSQL -c "insert into auth.users (id) values ('$u')" > /dev/null
  $PSQL -c "insert into public.users (id, email) values ('$u', '$u@example.test')" > /dev/null
  $PSQL -c "insert into public.consents (user_id, type, version, accepted)
            values ('$u', 'terms_of_service', '2026-05-25', true),
                   ('$u', 'privacy_policy', '2026-08-20', true)" > /dev/null
done
echo "       user1=$U1"
echo "       user2=$U2"
echo "       現行版: $($PSQL -c "select doc_type || '=' || version from legal_documents where is_current and locale='ja' order by doc_type" | tr '\n' ' ')"
echo

# @playwright/test は apps/web に入っているので、そこから解決させる
cd "$ROOT/apps/web" || exit 1
E2E_USER_ID="$U1" E2E_USER_ID_2="$U2" OUT="$ROOT/.qa/gap-206" \
  node "$ROOT/.qa/gap-206/e2e-browser.mjs"
RC=$?
cd "$ROOT" || exit 1
echo
echo "[DB] 同意が実際に増えたか (画面の言い分ではなく DB を見る)"
$PSQL -c "select type || ' ' || version || ' accepted=' || accepted || ' ua=' || coalesce(left(user_agent,20),'-')
          from public.consents where user_id = '$U1' order by accepted_at"
echo "       user2 (閉じただけ):"
$PSQL -c "select type || ' ' || version from public.consents where user_id = '$U2' order by accepted_at"
exit $RC
