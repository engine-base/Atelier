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
  VOYAGE_API_KEY='<Voyage AI Dashboard で発行>'
# ⚠ GAP-175: 利用者向けの AI 実行は既定で **本人の PC の Bridge (本人の Claude
#   サブスク)** で動く。ANTHROPIC_API_KEY は既定では使われない —
#   運営の従量課金を使うには ATELIER_ALLOW_API_BILLING=1 を明示すること。
#   ここで投入する ANTHROPIC_API_KEY は「運営バッチ (ナレッジ自動キュレーション)」
#   と、明示的に API 課金を許可した場合のためのもの。
#   ATELIER_LLM_PROVIDER は未設定のままにする (未設定 = relay = 本人サブスク)。
# ⚠ VOYAGE_API_KEY 未投入だと RAG は text 検索 degrade になる。
# 確認 (値は出ず名前と digest のみ):
flyctl secrets list --app atelier-api-eb
```

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

## Vault (project_credentials) の鍵運用 (GAP-131)

- 鍵は `ATELIER_VAULT_ENCRYPTION_KEYS` (カンマ区切り、先頭=暗号化・全鍵=復号)。
  ローテーション手順・喪失時手順・監査の見方は **docs/vault-key-operations.md** を正とする。
- **AI が触るホストに本番の vault 鍵を置かない** (開発ホストは開発鍵 + ダミーデータ)。
  構造的遮断 (KMS 化) はホスト版の必須要件 — docs/adr/ADR-020 参照。
