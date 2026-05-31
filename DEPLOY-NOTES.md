# Atelier デプロイ状況メモ (2026-05-31)

## 本番トポロジ
- Web: Vercel — 安定 prod alias = https://atelier-web-coral.vercel.app
- API: Fly.io — https://atelier-api-eb.fly.dev (Root: apps/api, uvicorn main:app)
- DB : Supabase project rgxwmdnqnlkgrgdfafih (Session Pooler :5432)

## 完了済み
- connector (#184): API api_router mount + 認証フロント配線 + middleware /auth/s_a01 + CORS。main 反映済
- Fly API: /auth/signup=422, signin(存在しないuser)=401 → DB接続OK・認証ロジック稼働
- Fly secrets 投入済 (ATELIER_AUTH_JWT_SECRET / ATELIER_DB_URL=pooler / SUPABASE anon+service_role+admin_url)
- Tailwind CSS空バグ修正 (#187): content を両CWD(repo root + apps/web)対応グロブに。main 反映済
  - 原因: Vercel は Root Directory=apps/web を CWD にするため repo root 相対グロブが0マッチ→全ユーティリティpurge→CSS 9KB(無装飾)
  - 検証: ローカル next build で CSS 31KB・.bg-surface 等生成確認

## 残タスク / 次の人へ
1. #187 マージ後、Vercel が main(5f1cb9e) から本番再ビルド。coral の CSS が 31KB に切替わるか確認:
   curl -s https://atelier-web-coral.vercel.app/auth/s_a01 | grep -oE '/_next/static/css/[a-z0-9]+\.css' → そのCSSが>20KBなら成功
   - 自動で切替わらない場合: Vercel ダッシュボードで最新デプロイを「Promote to Production」(本番promoteはAIガードで不可、人間が実行)
2. ブラウザで https://atelier-web-coral.vercel.app/auth/s_a01 → Sign up で登録テスト (実DB書込)
   - 500なら Supabase に migration 未適用の可能性 → `supabase link --project-ref rgxwmdnqnlkgrgdfafih && supabase db push`
3. ⚠️ セキュリティ: チャットに平文露出した全シークレット要ローテーション
   (Fly token / Supabase service_role+anon / SUPABASE_JWT_SECRET / Vercel token / Voyage / Sentry / DBパスワード)
4. 画面の「中身」ライブデータ描画(33画面分 GET API配線)は次フェーズ connector

## 既知の落とし穴
- v3-gate は claude/* 以外のブランチでも走る。#186 が dirty(重複コミット)で失敗 → main から切り直した #187 で解決
- ローカル ruff 0.15.8 ⇔ CI 0.8.4 の format 差。commit は `uvx ruff@0.8.4 format` で揃える
- このコンテナの curl は時々 SSL clock skew で 000、GitHub API は無認証レート制限あり → MCP 経由推奨
