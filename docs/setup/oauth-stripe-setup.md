# GAP-020 / GAP-021 外部サービス設定手順 (経営者作業)

> 対象: **Google OAuth クライアント ID の作成** と **Stripe webhook secret の投入** の 2 件。
> どちらも AI 側では実行できない (Google Cloud Console / Stripe Dashboard へのログインが必要)。
> このファイルの手順は上から順にコピペで完了する。所要 10〜15 分。
>
> 前提 (設定済と確認済み):
> - Google Cloud プロジェクト **Atelier / `atelier-505408`** — OAuth 同意画面・テストユーザー設定済
> - Stripe **テストモード** — `STRIPE_SECRET_KEY` (`sk_test_…`) は `apps/api/.env` に、
>   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (`pk_test_…`) は `apps/web/.env.local` に投入済
>
> **本番キー (Google 本番クライアント / Stripe live) への切替はこの手順に含めない。**
> 別タスク **T-I-25** として起票済 — 本番ドメイン確定 (T-I-21) 後に実施する。

---

## A. Google OAuth クライアント ID の作成

### A-1. 作成画面を開く

```
https://console.cloud.google.com/auth/clients/create?project=atelier-505408
```

> 上の URL が開かない場合: Google Cloud Console → 左メニュー **APIs & Services** →
> **認証情報 (Credentials)** → **+ 認証情報を作成** → **OAuth クライアント ID**。
> プロジェクトが `Atelier (atelier-505408)` になっていることを画面上部で必ず確認する。

### A-2. 入力値 (この 3 つをコピペ)

| 項目 | 入力する値 |
|---|---|
| アプリケーションの種類 | **ウェブ アプリケーション** |
| 名前 | `Atelier Web (dev)` |

**承認済みの JavaScript 生成元** — 「+ URI を追加」で 1 件:

```
http://localhost:3000
```

**承認済みのリダイレクト URI** — 「+ URI を追加」で 1 件:

```
http://localhost:3000/signin/oauth/callback
```

> ⚠️ リダイレクト URI は **完全一致**でしか動かない。
> 末尾スラッシュを付けない / `https` にしない / `8000` にしない (ここは Web の 3000 番)。
> このパスは Atelier 側の実装で固定する値なので、変更せずそのまま貼ること。

**「作成」** を押す。

### A-3. 同意画面のスコープを確認 (未設定なら追加)

```
https://console.cloud.google.com/auth/scopes?project=atelier-505408
```

次の 3 つが入っていること。無ければ「スコープを追加または削除」で追加して保存:

```
openid
.../auth/userinfo.email
.../auth/userinfo.profile
```

### A-4. 発行された 2 値を `.env` に貼る

作成直後のダイアログに表示される **クライアント ID** と **クライアント シークレット** を
`apps/api/.env` の末尾に追記する (このファイルは `.gitignore` 済・git に入らない):

```bash
# ── Google OAuth (GAP-020 / まずテスト環境) ──────────────────
ATELIER_OAUTH_GOOGLE_CLIENT_ID=＜ここにクライアント ID＞
ATELIER_OAUTH_GOOGLE_CLIENT_SECRET=＜ここにクライアント シークレット＞
ATELIER_OAUTH_REDIRECT_URI=http://localhost:3000/signin/oauth/callback
```

> シークレットは後から再表示できない。1Password などの保管庫にも同時に保存すること
> (SECRETS.md「1. 保管場所」の運用)。
> **クライアント シークレットは Web 側 (`apps/web/.env.local`) には置かない。**
> 認可 URL の生成もコード交換も API 側だけが行う設計にしてある。

### A-5. サインインできるアカウントについて

同意画面が「テスト」ステータスの間は、**テストユーザーに登録したアカウントだけ**が
サインインできる。自分のアカウントが入っているかここで確認できる:

```
https://console.cloud.google.com/auth/audience?project=atelier-505408
```

---

## B. Stripe webhook secret の発行と投入

用途が 2 つあるので、**まず B-1 (ローカル) だけやれば十分**。B-2 は常設環境が要るときに。

### B-1. ローカル開発用 (今すぐ必要なのはこちら)

Stripe CLI を入れてログインし、webhook を転送する:

```bash
brew install stripe/stripe-cli/stripe
stripe login
stripe listen --forward-to localhost:8000/webhooks/stripe
```

起動すると次の行が出る:

```
> Ready! Your webhook signing secret is whsec_xxxxxxxxxxxxxxxxxxxxxxxx (^C to quit)
```

この `whsec_…` を `apps/api/.env` の **既存の空行**に貼る (行を新規追加しない):

```bash
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxxxxx
```

> `stripe listen` は動かしている間だけ有効。シークレットは `stripe login` した
> アカウント単位で安定するので、毎回貼り直す必要は基本的にない。

### B-2. 常設エンドポイント用 (ステージング / 常時起動の検証環境がある場合のみ)

```
https://dashboard.stripe.com/test/webhooks/create
```

- **エンドポイント URL**: `https://＜API の公開 URL＞/webhooks/stripe`
  (例: 現状の Fly なら `https://atelier-api-eb.fly.dev/webhooks/stripe`)
- **リッスンするイベント**: 次の 6 件を選択

```
checkout.session.completed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
invoice.paid
invoice.payment_failed
```

作成後の画面で **「署名シークレットを表示」** → `whsec_…` をコピー。
Fly に入れる場合はローカル `.env` ではなく secrets に:

```bash
flyctl secrets set --app atelier-api-eb STRIPE_WEBHOOK_SECRET='whsec_…'
```

### B-3. Stripe テスト商品について (作業不要・事前共有)

有料プラン (`pro` / `enterprise`) の商品と価格は、実装側が
`scripts/stripe/bootstrap-test-products.py` で**テストモードに自動作成**する
(`lookup_key` = `atelier_pro_monthly` / `atelier_enterprise_monthly`、再実行しても増えない冪等処理)。
**Dashboard で手作業の商品登録は不要**だが、テスト環境に商品が自動で 2 件増える点だけ了解しておいてほしい。
本番 (live) 側には一切触れない。

---

## C. 完了後に返してほしい情報

以下をそのまま返信してくれれば、実装・検証を続行する。

```
1. Google OAuth: 完了 / 未完了
2. Stripe webhook secret: 完了 (B-1 ローカル / B-2 常設のどちら) / 未完了
3. Vercel の本番 URL: ＜あれば https://… / 無ければ「未確定」＞
```

> 3 について: Google はリダイレクト URI にワイルドカードを許さないため、
> Vercel のプレビュー URL (毎回変わる) は登録できない。本番 URL が既に確定しているなら
> `＜本番 URL＞/signin/oauth/callback` を A-2 のリダイレクト URI に**追加**しておくと、
> 本番切替 (T-I-25) が 1 手減る。未確定ならローカルだけで問題ない。

---

## D. 秘密情報の取り扱い (再掲)

- `.env` / `.env.local` は `.gitignore` 済。**実値を git にも AI へのチャットにも貼らない。**
- AI に伝えるのは「入れた / 入れてない」と**変数名だけ**でよい。
- 露出したら即ローテーション: Google はクライアントシークレットを再発行、
  Stripe は Dashboard でキーをロール (SECRETS.md「4. ローテーション」)。
