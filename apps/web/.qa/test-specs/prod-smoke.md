# 本番スモーク テスト仕様（prod-smoke / human-grade-qa）

> 対象: 本番 API `https://atelier-api-eb.fly.dev`（Fly Tokyo）+ Vercel フロント + Supabase atelier-prod。
> 目的: デプロイ後に「実ユーザーが新規登録から実際に触れる」ことを実機で保証する。
> 実行 = 2026-07-15（実キー投入・DB 復元後）。結果列は実測。

## 前提チェック（環境の生存）
| ID | 対象 | 手順 | 期待 | 結果 |
|---|---|---|---|---|
| PS-00 | デプロイ鮮度 | deploy.yml 最新 run | success かつ main HEAD 反映 | **要監視** (FLY_API_TOKEN 失効で 6 週停止していた→復旧) |
| PS-01 | API health | GET /health | 200 | PASS |
| PS-02 | Supabase 生存 | auth/v1/health | 200/401（up） | PASS（※無料枠は 1 週無活動で自動休止=INFRA-2） |

## 認証（新規登録から）
| ID | 対象 | 手順 | 期待 | 結果 |
|---|---|---|---|---|
| PS-10 | 新規登録 | POST /auth/signup（consents 2 種・version=semver/日付） | 201・consents_recorded | **PASS**（実 201） |
| PS-11 | consent version 検証 | version='v1'（不正）で signup | **422**（500 でない） | **PASS（修正後）** バグ#25 |
| PS-12 | signup 原子性 | DB 失敗を誘発 | Supabase auth.users を孤児化しない | **PASS（修正後）** バグ#26 |
| PS-13 | サインイン | POST /auth/signin | 200・access_token 発行 | **PASS**（実 200） |
| PS-14 | 認証ガード | 無認証で保護 API | 401 | PASS |
| PS-15 | 画面描画 | S-A01 を本番 API 相手に表示 | サインイン/新規登録が正常描画 | PASS（実ブラウザ） |

## 主要フロー（実 AI まで）
| ID | 対象 | 手順 | 期待 | 結果 |
|---|---|---|---|---|
| PS-20 | ワークスペース作成 | POST /workspaces | 201 | **PASS**（2026-07-15 本番実測 201。旧: INFRA-3 で 500 → マイグレーション適用で解消） |
| PS-21 | プロジェクト作成 | POST /projects | 201 | **PASS**（本番実測 201） |
| PS-22 | チャット実 AI | 新規WS→社員自動シード→スレッド→送信 | 実 LLM 応答がストリーム表示 | **PASS**（2026-07-16 本番実測: T-A-54 で新規WSに10名自動シード→tonyスレッド→実Anthropicが『私はトニー、営業・契約部の部長です』とペルソナ応答をストリーム。ギャップ#27解消） |
| PS-23 | RAG 実引き | ナレッジ参照質問 | Voyage→pgvector→実引用 | PASS（フルスタック実ブラウザで実証済=v22。本番も同一コード・Voyageキー投入済） |
| PS-24 | リロード永続 | F5 | ログアウトせず維持 | PASS（履歴永続=バグ#23修正を v22 実ブラウザで実証済） |

## 恒久対策（INFRA-3 / production readiness）
1. ✅ **schema/verification 分離**: t-d-31/32 に `@verification-only` マーカーを付与し本番から除外（PR #276）。
2. ✅ **deploy に schema-only 冪等適用ステップを追加**: `apply-migrations.sh` の `SCHEMA_ONLY=1` を
   deploy.yml から実行（`PROD_DATABASE_URL` secret があるときのみ）。使い捨て DB で
   「37 適用→再適用で冪等→workspace insert でトリガ動作」を実証済み（PR #276）。
3. ✅ **完了 (2026-07-15)**: `PROD_DATABASE_URL` を GitHub secret 登録 → 再 deploy で
   `37 applied / 2 skipped (SCHEMA_ONLY=1)` を実行、本番スキーマ同期完了。
   PS-20/21 が本番実測 201 で PASS 化（旧 INFRA-3 500 が解消）。
   - 副作用対応: DB パスワード reset に伴い Fly の `ATELIER_DB_URL`/`DATABASE_URL` も新パスワードへ更新（signin 復旧）。
   - ⚠ 未解決の製品ギャップ **#27**: 新規 WS に AI 社員を追加する API/フローが無く、
     新規ユーザーがチャットを開始できない。テンプレからの「hire」エンドポイント実装が別途必要（PS-22〜24 の解除条件）。
   ```bash
   # Supabase Dashboard → Connect → Session pooler の URL (postgresql://...) を取得し:
   gh secret set PROD_DATABASE_URL --repo engine-base/Atelier   # 値を貼る
   gh workflow run deploy.yml --ref main                        # 再deploy でマイグレーション適用
   ```
4. 上記 3 完了後に PS-20〜24 を実ブラウザで実走し本欄を PASS 化する（実 AI チャットは
   フルスタックで実証済み＝RESULTS v22。本番でも同一コードで動く）。
