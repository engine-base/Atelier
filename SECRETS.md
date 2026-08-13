# シークレット運用ガイド

Atelier の API キー・接続文字列・トークンの**安全な保管と利用**のルール。

> 原則: **シークレットの実値は git にもチャット(AI)にも置かない。**
> 保管は「人間しかアクセスできない場所」に集約し、各環境へは公式 CLI で注入する。

---

## 1. 保管場所（信頼源）

| 用途 | 保管場所 | 取得コマンド |
|---|---|---|
| Supabase anon / service_role | Supabase Dashboard → Project Settings → API | `supabase projects api-keys --project-ref <ref>` |
| Supabase DB パスワード | Supabase Dashboard → Settings → Database | (Reset で再発行) |
| Fly デプロイトークン | Fly Dashboard → Account → Access Tokens | `flyctl auth token` |
| Vercel トークン | Vercel Dashboard → Settings → Tokens | — |
| Stripe API キー (test/live) | Stripe Dashboard → 開発者 → API キー | (Dashboard で確認・ロール) |
| Google OAuth クライアント ID/secret | Google Cloud Console → Auth Platform → Clients | — |
| JWT 署名鍵 | 自分で生成し 1Password 等に保管 | `python3 -c "import secrets;print(secrets.token_urlsafe(48))"` |
| BYOK 暗号化キー (`ATELIER_BYOK_ENCRYPTION_KEY`) | 自分で生成し 1Password 等に保管 | `python3 -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"` |
| Vault 暗号化キー (`ATELIER_VAULT_ENCRYPTION_KEY`) | 同上 (BYOK とは別値にする) | 同上 |
| Bridge worker トークン (`ATELIER_BRIDGE_TOKEN`) | 自分で生成し 1Password 等に保管 | `python3 -c "import secrets;print(secrets.token_urlsafe(48))"` |
| Inngest Event / Signing key | Inngest Dashboard → Manage → Event Keys / Signing Key | — |
| Sentry DSN (API / Web) | Sentry Dashboard → Settings → Projects → Client Keys (DSN) | — |
| Langfuse Public / Secret key | Langfuse Dashboard → Settings → API Keys | — |
| Better Stack source token | Better Stack → Telemetry → Sources → 対象 source | — |

**個人の保管庫**として 1Password / Bitwarden 等のパスワードマネージャに上記をまとめて保存推奨。
チームなら 1Password の共有 Vault か、Doppler / Infisical 等のシークレットマネージャを使う。

---

## 2. 各環境への注入方法（実値は CLI 経由でのみ流す）

### ローカル開発
```bash
cp apps/api/.env.example apps/api/.env          # 雛形をコピー
cp apps/web/.env.example apps/web/.env.local
# 保管庫から実値をコピペして各 .env を埋める (.env は .gitignore 済)
```

### 本番 API (Fly.io)
```bash
flyctl secrets set --app atelier-api-eb \
  ATELIER_AUTH_JWT_SECRET='<保管庫の値>' \
  ATELIER_DB_URL='<Supabase Session Pooler の asyncpg URL>' \
  ATELIER_SUPABASE_ADMIN_API_URL='https://<ref>.supabase.co' \
  ATELIER_SUPABASE_ANON_KEY='<anon>' \
  ATELIER_SUPABASE_SERVICE_ROLE_KEY='<service_role>' \
  ANTHROPIC_API_KEY='<Anthropic Console で発行>' \
  VOYAGE_API_KEY='<Voyage AI Dashboard で発行>' \
  ATELIER_BYOK_ENCRYPTION_KEY='<Fernet 鍵>' \
  ATELIER_VAULT_ENCRYPTION_KEY='<Fernet 鍵 (BYOK とは別値)>' \
  ATELIER_BRIDGE_TOKEN='<保管庫の値>'
# ⚠ ANTHROPIC_API_KEY / VOYAGE_API_KEY 未投入だと本番 chat は
#   「LLM が利用できません」エラー、RAG は text 検索 degrade になる。
# ⚠ ATELIER_BYOK_ENCRYPTION_KEY / ATELIER_VAULT_ENCRYPTION_KEY 未投入だと
#   BYOK API / シークレット保管 API が 500 を返す (GAP-107)。
# 観測基盤 (任意だが本番では投入推奨。未設定なら skip して通常動作):
#   SENTRY_DSN / LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / BETTERSTACK_SOURCE_TOKEN
# 確認 (値は出ず名前と digest のみ):
flyctl secrets list --app atelier-api-eb
```

> 必須 env とテンプレート (`.env.example`) の乖離は
> `python3 scripts/ci/env-template-drift.py` で機械検査している (T-F-43)。
> 新しい必須 env を足したら**名前だけ**テンプレートに登録すること (実値は書かない)。

### 本番 Web (Vercel)
Dashboard → Project → Settings → Environment Variables、または:
```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL production
```
※ `NEXT_PUBLIC_API_URL` は未設定でOK (コードが本番で Fly を自動使用)。

### CI (GitHub Actions)
リポジトリ → Settings → Secrets and variables → Actions に登録。
deploy.yml は `FLY_API_TOKEN` / `FLY_APP_NAME` を参照。

---

## 3. AI / 自動化エージェントに渡さない

- このリポジトリで作業する AI エージェントには**実値を貼らない**。
- AI には「環境変数名」だけ伝える (例: `ATELIER_DB_URL を Fly に入れて」)。
  実際の `flyctl secrets set` 実行は**人間が**自分の端末で行う。
- `.env` / `.env.local` は `.gitignore` 済。AI が読む作業ツリーには実値が入らない。

---

## 4. ⚠️ ローテーション（漏洩時 / 定期）

シークレットがチャット・ログ・スクショ等に露出したら**即座に全て再発行**する。

| 対象 | ローテーション手順 |
|---|---|
| Supabase service_role / anon | Dashboard → Settings → API → "Roll" / JWT secret の場合 "Rotate JWT secret" |
| Supabase DB パスワード | Settings → Database → Reset database password → 各環境の `ATELIER_DB_URL` を更新 |
| Fly token | `flyctl tokens revoke` + Dashboard で再発行 → GitHub Secret 更新 |
| Vercel token | Dashboard → Tokens → 削除して再発行 |
| JWT 署名鍵 | 新値生成 → `flyctl secrets set ATELIER_AUTH_JWT_SECRET=...` (既存セッションは無効化される) |

ローテーション後は **各環境の注入値を全て更新**し、デプロイを1回回して反映する。

---

## 5. 漏洩していないかのチェック

```bash
# git に実値が混入していないか (コミット履歴含む)
git log -p --all | grep -iE "service_role|sb_secret|FlyV1|postgres://.*:.*@" | head

# 追跡対象に .env が無いか
git ls-files | grep -E '\.env$|\.env\.' | grep -v example
```
ヒットしたら該当を履歴から除去 (`git filter-repo`) し、全シークレットをローテーションする。
