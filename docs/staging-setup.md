# staging 環境の用意手順（ADR-021 案 A）

> 誰が・何を・どの権限で。**ダッシュボードで手作業するのはアカウント/プロジェクトの作成と secrets 登録だけ**。
> スキーマ・seed・バケット・API のデプロイは本番と同じコード（deploy.yml）で作る（G-11: 外部リソースはコードで）。
> 所要: 経営者側 約 1 時間、その後の deploy は約 5 分。

## 0. 前提
- ADR-021 が承認され、`03_architecture/selected-stack.json` の `environments.staging.decision` が `approved` になっていること
  （`python3 scripts/ci/pipeline-next.py check-staging` が ✓）。
- 費用: Supabase Free（$0）/ Fly.io shared-cpu-1x auto-stop（ほぼ $0）/ Vercel Preview（Hobby 内）。

## 1. 経営者がやること（権限が要るもの）

### 1-1. Supabase: staging プロジェクトを作る
1. https://supabase.com/dashboard → New project → 名前 `atelier-staging`、Region **Tokyo (ap-northeast-1)**、Free。
2. Settings → Database → **Session pooler** の接続文字列（`postgresql://postgres.<ref>:<pw>@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres`）を控える。
3. Settings → API → `anon` key / `service_role` key / Project URL を控える（service_role は誰にも貼らない。Fly secrets にだけ入れる）。
4. Authentication → URL Configuration:
   - Site URL: staging の Web URL（Vercel Preview の固定 URL。3-2 で決まる）
   - Redirect URLs: 同 URL + `http://localhost:3000`
   （この設定は `supabase/config.toml` に寄せてあるので、`supabase link --project-ref <ref> && supabase config push` でコードから当てられる。手で入れた場合も同じ値にする）

### 1-2. Fly.io: staging の app を作る
```bash
flyctl apps create atelier-api-staging --org <本番と同じ org>
flyctl secrets set -a atelier-api-staging \
  ATELIER_DB_URL='postgresql+asyncpg://postgres.<ref>:<pw>@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres' \
  ATELIER_AUTH_JWT_SECRET='<Supabase staging の JWT secret (Settings → API)>' \
  ATELIER_SUPABASE_ADMIN_API_URL='https://<ref>.supabase.co' \
  ATELIER_SUPABASE_ANON_KEY='<anon>' \
  ATELIER_SUPABASE_SERVICE_ROLE_KEY='<service_role>' \
  ATELIER_PUBLIC_BASE_URL='https://atelier-api-staging.fly.dev' \
  ATELIER_CORS_EXTRA_ORIGINS='<staging Web URL>' \
  APP_ENV='staging'
```
本番にある他の secrets（Resend / Stripe テストキー等）は **テストモードの鍵**を入れる。無いものは入れない（その機能の行は BLOCKED として残る）。

### 1-3. GitHub: secrets を 2 つ登録
```bash
gh secret set STAGING_DATABASE_URL --repo engine-base/Atelier   # 1-1 の Session pooler URL (postgresql://...)
gh secret set STAGING_FLY_APP_NAME --repo engine-base/Atelier    # atelier-api-staging
```

### 1-4. Vercel: staging ブランチの Preview に API 先を入れる
- Vercel → Project → Settings → Environment Variables → **Preview** かつ Git Branch = `staging`:
  `NEXT_PUBLIC_API_URL=https://atelier-api-staging.fly.dev`（本番 Web が使っている API URL の変数名に合わせる）
- Preview の固定 URL（`atelier-web-<hash>-<team>.vercel.app` ではなく branch alias）を 1-1 の Site URL に使う。

## 2. deploy（本番と同じコード）
```bash
git push origin main:staging                       # staging ブランチを main に追随させる（Web の Preview が出る）
gh workflow run deploy.yml --ref main -f environment=staging   # migration (SCHEMA_ONLY=1) → seed → flyctl deploy → /health
```
deploy.yml は `environment=staging` のとき `STAGING_DATABASE_URL` / `STAGING_FLY_APP_NAME` を使う。本番と**同じ**ステップが走るので、
「本番で初めて壊れる migration」（GAP-238 型）や「バケットが無い」（GAP-242 型）は staging で先に出る。

## 3. 確認（PS-00〜PS-05 を staging で流す）
```bash
API=https://atelier-api-staging.fly.dev
curl -s $API/health                                                   # 200
# prod-smoke.md の PS-01〜PS-05 を staging の URL で実行し、結果列に「staging」と書く
python3 scripts/ci/qa-ladder.py levels                                # BLOCKED(理由: staging 未整備) の行を消化対象に戻す
```

## 4. データ方針（守ること）
- staging に **本番データ・実顧客データを複製しない**。seed（AI 社員テンプレ・法務文書）+ QA 専用アカウントだけ。
- 破壊的テスト（DB 故意破壊 PS-12、退会、課金のテストモード、混雑上限）は **staging では全面可**。本番では禁止。
- 週次リセット可: `supabase db reset --linked` ではなく、**本番と同じ apply-migrations.sh を空 DB に当て直す**（同じコードで作れることの確認を兼ねる）。

## 5. 休止対策（Free 枠は 1 週無活動で休止する = INFRA-2）
- Better Stack の uptime 監視（既存 GAP-195）に `https://atelier-api-staging.fly.dev/health` を追加。/health は DB を触るので Supabase の休止も防げる。
- 休止したら 1-1 のダッシュボードで Restore（経営者のみ）。

## 6. 権限とやらないこと
| 作業 | 誰 | 備考 |
|---|---|---|
| Supabase / Fly / Vercel のプロジェクト作成・secrets | 経営者 | 権限が要る |
| deploy.yml の実行 | 経営者（`gh workflow run`） | 実装 AI は dispatch 権限が無い |
| migration / seed / バケット / 認証設定のコード化 | 実装 AI | 手作業に戻さない |
| staging での L1〜L3 実走・正本への書き戻し | 実装 AI（各タスクの担当） | jit-task-execution STEP 4.5 |
| 本番での通し・破壊テスト | **誰もやらない** | L4 スモークのみ |
