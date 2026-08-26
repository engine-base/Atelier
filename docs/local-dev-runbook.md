# ローカル開発ランブック — 登録→ログイン→画面を実際に動かす

このドキュメントは Atelier を**自分のPCで実際に起動**し、ブラウザで
「登録 → ログイン → 画面遷移」を触るための手順です。

> 背景: W3/W4 = 画面UI、W5 = テスト/インフラ を別々に完成させたため、
> 両者を繋ぐ **connector（API組み立て + DB + フロント↔API配線 + middleware）**
> を本ランブック付随の変更で配線しました。本番(Supabase/Vercel/Fly.io)経路は
> 別途 IaC で構成します。

## 前提

- Node.js 20.x + pnpm 9.x
- Python 3.12 + uv
- PostgreSQL 16+（ローカル, port 5432）+ **pgvector**
  - macOS: `brew install postgresql@17 pgvector && brew services start postgresql@17`
  - Ubuntu: `sudo apt install postgresql-16 postgresql-16-pgvector`
  - pgvector が無いと vector 型を使う migration → chat 系テーブルが連鎖 skip され
    チャットが動かない DB になる (dev-bootstrap.sh のログで skip 数を確認できる)

## 1. DB ブートストラップ

```bash
./scripts/dev-bootstrap.sh
```

`atelier_dev` DB を作成し、Supabase 互換 shim（`auth` schema / `auth.uid()` 等）
を入れて migration を適用します。

## 2. バックエンド (FastAPI) 起動

```bash
cd apps/api
export ATELIER_DB_URL='postgresql+asyncpg://atelier_dev:devpass@localhost:5432/atelier_dev'
export ATELIER_AUTH_JWT_SECRET='dev-local-secret-please-change'
uv run uvicorn main:app --host 127.0.0.1 --port 8000
```

- 確認: `curl http://localhost:8000/health` → `{"status":"ok"}` 系
- API ドキュメント: http://localhost:8000/docs

## 3. フロントエンド (Next.js) 起動

別ターミナルで:

```bash
cd apps/web
echo 'NEXT_PUBLIC_API_URL=http://localhost:8000' > .env.local
pnpm exec next build
pnpm exec next start -p 3100
```

## 4. ブラウザで触る

→ **http://localhost:3100**

| 操作 | URL | 挙動 |
|---|---|---|
| トップ | `/` | Atelier ホーム |
| 保護ページに直アクセス | `/projects/s_b01` | 未認証なら `/auth/s_a01` に自動リダイレクト |
| 登録 | `/auth/s_a01`（Sign up タブ） | 実 API `/auth/signup` → DB に users + consents 記録 |
| ログイン | `/auth/s_a01`（Sign in タブ） | 実 API `/auth/signin` → HS256 JWT を `atelier_access` cookie に設定 |
| ログイン後 | 自動で `/projects/s_b01` 等へ | middleware が cookie を検証して通過 |
| 法務ページ | `/public/s_pub01..04` | 未認証でも公開（利用規約・プライバシー等） |

### デモ手順
1. http://localhost:3100/auth/s_a01 を開く
2. 「Sign up」タブ → メール・パスワード（8文字以上）・同意チェック → 登録
3. 自動ログインされ、プロジェクト画面へ遷移
4. 以後は cookie 有効期限（1h）内は保護ページを回遊可能

## 5. 最初の運営 (admin) を作る

運営画面 `/admin` は **JWT の `app_metadata.role == "admin"`** を要求する。その role の
信頼源は **DB の `auth.users.raw_app_meta_data` だけ**で、ユーザー入力からは受け取らない
(改ざんで運営になれないようにするため)。したがって **画面からは運営になれない**。

新しく構築した環境では、まず普通に登録してから昇格させる:

```bash
# 1. 画面から普通に新規登録する (http://localhost:3100/signin の「新規登録」タブ)
# 2. その人を運営にする
bash scripts/grant-admin.sh you@example.com

# 任意の DB を指定する場合 (本番・検証環境)
PGURL="postgresql://user:pass@host:5432/dbname" bash scripts/grant-admin.sh you@example.com

# 取り消す
bash scripts/grant-admin.sh you@example.com --revoke
```

**昇格したら一度サインアウトして入り直す。** アクセストークンはサインイン時に
その時点の role を焼き込むため、発行済みのトークンは昇格を知らない。入り直さないと
`/admin` は 403 のままで、「昇格したのに入れない」と誤解する。

> この手順が無かったため、2026-08-26 の通し (J00-03) で **登録もサインインもできるのに
> 運営画面には永久に入れない**環境ができていた (GAP-217)。AI 社員テンプレ・既定デザイン・
> 法務文書の改訂は運営しか触れないので、そこから先が全部止まる。

## 既知の制約（正直な開示）

- **画面の「中身」データ**: 各画面（ダッシュボード/タスク/ナレッジ等）は現状
  静的/モック表示の箇所が残ります。画面ごとの GET API → 実データ描画の配線は
  33画面分の追加作業（次フェーズ connector）。
- **DB shim**: ローカルは Supabase の `auth.users`/`auth.uid()` を最小 shim で
  代替。本番は Supabase Auth が担います。
- **cookie**: ローカル dev は client 側で `atelier_access` を設定。本番は
  server 側 HttpOnly cookie。
