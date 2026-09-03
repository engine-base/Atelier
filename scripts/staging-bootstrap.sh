#!/usr/bin/env bash
# staging (ADR-021 案 A) を **1 コマンドで**用意する。Mac で、権限を持つ本人が実行する。
#
#   bash scripts/staging-bootstrap.sh <supabase-org-id> [db-password]
#
# 前提 (ログイン済みであること):
#   supabase login / flyctl auth login / gh auth login / vercel login (任意)
# やること (docs/staging-setup.md §1 の自動化):
#   1. Supabase プロジェクト atelier-staging (ap-northeast-1, Free) を作る
#   2. anon / service_role キーを取り、Session pooler の接続文字列を組み立てる
#   3. Fly app atelier-api-staging を作り、secrets を投入する (JWT secret は乱数生成。API が自前で
#      HS256 発行/検証するので Supabase の JWT secret は不要 = src/dependencies.py)
#   4. GitHub secrets STAGING_DATABASE_URL / STAGING_FLY_APP_NAME を登録する
#   5. staging ブランチを main から切って push (Vercel Preview が出る)
#   6. 残る手作業 (Vercel の env / Site URL / CORS) を画面に出す
# 秘密は画面に出さず、ファイルにも残さない (シェル変数 → 各 CLI へ直接)。
set -euo pipefail
trap 'echo "✗ 途中で止まりました (line $LINENO)。この出力を貼ってください"' ERR

ORG_ID="${1:-}"
DB_PASS="${2:-$(openssl rand -hex 16)}"
PROJECT_NAME="${STAGING_SUPABASE_NAME:-atelier-staging}"
FLY_APP="${STAGING_FLY_APP:-atelier-api-staging}"
REGION="ap-northeast-1"
REPO="engine-base/Atelier"

if [ -z "$ORG_ID" ]; then
  echo "usage: bash scripts/staging-bootstrap.sh <supabase-org-id> [db-password]"
  echo "  org-id は: supabase orgs list"
  exit 2
fi
for c in supabase flyctl gh git openssl psql; do command -v "$c" >/dev/null || { echo "✗ $c が無い"; exit 2; }; done

echo "== 1/6 Supabase プロジェクト $PROJECT_NAME ($REGION, Free) =="
if supabase projects list 2>/dev/null | grep -q " $PROJECT_NAME "; then
  echo "   既にある → 再利用"
else
  supabase projects create "$PROJECT_NAME" --org-id "$ORG_ID" --region "$REGION" --db-password "$DB_PASS" --size free >/dev/null
fi
REF=$(supabase projects list --output json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(p['id'] for p in d if p['name']=='$PROJECT_NAME'))")
echo "   project ref = $REF"
echo "   (起動待ち 60 秒)"; sleep 60

echo "== 2/6 API キーと接続文字列 =="
KEYS=$(supabase projects api-keys --project-ref "$REF" --output json)
ANON=$(echo "$KEYS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(k['api_key'] for k in d if k['name']=='anon'))")
SERVICE=$(echo "$KEYS" | python3 -c "import json,sys; d=json.load(sys.stdin); print(next(k['api_key'] for k in d if k['name']=='service_role'))")
DB_URL="postgresql://postgres.${REF}:${DB_PASS}@aws-1-${REGION}.pooler.supabase.com:5432/postgres"
DB_URL_ASYNC="postgresql+asyncpg://postgres.${REF}:${DB_PASS}@aws-1-${REGION}.pooler.supabase.com:5432/postgres"
psql "$DB_URL" -Atc "select 1" >/dev/null && echo "   DB 接続 OK" || { echo "✗ DB に繋がらない (起動待ちが足りない可能性。1 分後に再実行)"; exit 1; }

echo "== 3/6 Fly app $FLY_APP =="
flyctl apps list 2>/dev/null | grep -q "^$FLY_APP" || flyctl apps create "$FLY_APP" >/dev/null
# API は自前の HS256 JWT を ATELIER_AUTH_JWT_SECRET で発行・検証する (Supabase 発行のトークンは使わない)。
# よって staging 専用の乱数でよい。本番の値を流用しない (漏れたら両方倒れる)。
JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
flyctl secrets set -a "$FLY_APP" --stage \
  ATELIER_DB_URL="$DB_URL_ASYNC" \
  ATELIER_AUTH_JWT_SECRET="$JWT_SECRET" \
  ATELIER_SUPABASE_ADMIN_API_URL="https://${REF}.supabase.co" \
  ATELIER_SUPABASE_ANON_KEY="$ANON" \
  ATELIER_SUPABASE_SERVICE_ROLE_KEY="$SERVICE" \
  ATELIER_PUBLIC_BASE_URL="https://${FLY_APP}.fly.dev" \
  APP_ENV="staging" >/dev/null
echo "   secrets 投入 (DB / JWT / Supabase キー / APP_ENV)"

echo "== 4/6 GitHub secrets =="
printf '%s' "$DB_URL" | gh secret set STAGING_DATABASE_URL --repo "$REPO"
printf '%s' "$FLY_APP" | gh secret set STAGING_FLY_APP_NAME --repo "$REPO"

echo "== 5/6 staging ブランチ (Vercel Preview 用) =="
git fetch origin main >/dev/null
git push origin origin/main:refs/heads/staging 2>/dev/null || git push -f origin origin/main:refs/heads/staging

echo "== 6/6 残る手作業 (権限の都合で CLI にできないもの) =="
cat <<EOF
  a) Vercel → Atelier project → Settings → Environment Variables → Preview (branch: staging):
       NEXT_PUBLIC_API_URL = https://$FLY_APP.fly.dev
     その Preview の URL を控える (例 https://atelier-web-git-staging-<team>.vercel.app) → CORS に入れる:
       flyctl secrets set -a $FLY_APP ATELIER_CORS_EXTRA_ORIGINS='<Preview の URL>'
  b) Supabase Dashboard → Authentication → URL Configuration:
       Site URL = (a) の URL / Redirect URLs に同 URL と http://localhost:3000
     (あるいは: NEXT_PUBLIC_SITE_URL=<URL> supabase link --project-ref $REF && supabase config push)
  c) 初回 deploy (migration → seed → deploy → /health):
       gh workflow run deploy.yml --ref main -f environment=staging
       gh run watch
  d) 完成したら 03_architecture/selected-stack.json の environments.staging.resources を埋めて commit:
       supabase_project_ref=$REF / fly_app=$FLY_APP / vercel_preview_url=(a) / ready=true
  ※ 秘密 (JWT secret / service_role / DB パスワード) はチャットや Issue に貼らない。貼ったら即ローテーション。
EOF
echo "✓ 自動化できる分は完了。DB パスワードはこのシェルにしか無い (必要なら Supabase Dashboard で reset できる)"
