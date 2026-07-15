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
| PS-20 | ワークスペース作成 | POST /workspaces | 201 | **FAIL → BLOCKED** INFRA-3（本番スキーマドリフト） |
| PS-21 | プロジェクト作成 | POST /projects | 201 | BLOCKED（PS-20 依存） |
| PS-22 | チャット実 AI | S-E01 で送信 | 実 LLM 応答がストリーム表示 | BLOCKED（PS-20 依存） |
| PS-23 | RAG 実引き | ナレッジ参照質問 | Voyage→pgvector→実引用 | BLOCKED（PS-20 依存） |
| PS-24 | リロード永続 | F5 | ログアウトせず維持 | BLOCKED |

## 恒久対策（INFRA-3 / production readiness）
1. **schema migration と verification script の分離**（t-d-31〜35 は本番へ流さない）。
2. **deploy に schema-only の冪等マイグレーション適用ステップを追加**（現状ゼロ＝根因）。
3. **prod DB URL を CI secret 化**し、deploy 時に schema を必ず同期。
4. 上記完了後に PS-20〜24 を実ブラウザで実走し本欄を PASS 化する。
