# Atelier タスクカード（v3.1-dual / API-First / 二軸時間）

- 信頼源: [`tickets.json`](./tickets.json) （190 タスク・二軸時間注入済）
- HTML 版（トグル切替）: [`TASK-CARDS.html`](./TASK-CARDS.html)
- 依存 DAG: [`DEPENDENCIES.md`](./DEPENDENCIES.md) / [`DEPENDENCIES.html`](./DEPENDENCIES.html)
- スケジュール: [`../08_schedule/SCHEDULE.html`](../08_schedule/SCHEDULE.html)
- API 契約凍結: **2026-05-27T13:30:00+09:00**（AI 並列モード時）

## サマリ（二軸）

| 指標 | Human-baseline | AI-accelerated |
|---|---:|---:|
| 総タスク数 | 190 | 190 |
| 総工数 | 1328.0 h | – |
| AI compute | – | 123.7 h |
| Wall-clock 並列 | – | 27.9 h |
| 人間 review | – | 10.8 h |
| 営業日 | 240 日 (~8 ヶ月) | **15 日 (~3 週)** |
| 短縮率 | baseline | **10.7×** |

### Wave 別 wall-clock（AI 並列モード）

| Wave | Phase | 並列度 | AI compute (h) | Wall-clock (h) |
|---|---|---:|---:|---:|
| W0 | 1_foundation | 5 | 18.6 | 6.71 |
| W1 | 2_data | 8 | 17.8 | 5.53 |
| W2 | 3_api | 10 | 26.6 | 4.66 |
| W3 | 4_ui_foundation | 5 | 9.6 | 2.42 |
| W4 | 5_ui_parallel | 10 | 36.8 | 3.68 |
| W5 | 6_integration | 5 | 14.4 | 4.88 |

---

## Group F: Foundation（28 件 / Human 213h / AI 18.6h）

| ID | 担当 | Human h | AI h | accel | review | タイトル |
|---|---|---:|---:|---:|---:|---|
| T-F-01 | tony | 4 | 0.27 | 15× | – | モノレポ初期化（pnpm + Turborepo） |
| T-F-02 | tony | 4 | 0.27 | 15× | – | TS / Python ツールチェイン整備 |
| T-F-03 | tony | 6 | 0.4 | 15× | – | Next.js 15 (App Router) 初期化 |
| T-F-04 | tony | 6 | 0.4 | 15× | – | FastAPI 初期化 + ヘルスチェック |
| T-F-05 | strange | 4 | 0.27 | 15× | – | Supabase プロジェクト作成（Tokyo region） |
| T-F-06 | tony | 6 | 0.4 | 15× | – | Vercel + Fly.io デプロイ設定 |
| ★ T-F-07 | tony | 14 | 0.93 | 15× | 0.5 | GitHub Actions CI/CD（v3-gate.yml 10 gate） |
| T-F-08 | tony | 8 | 0.53 | 15× | – | 観測基盤（Sentry / Langfuse / Better Stack） |
| T-F-09 | wanda | 8 | 0.53 | 15× | – | Atelier デザインシステム統合 |
| T-F-10 | tony | 6 | 0.4 | 15× | – | Drizzle ORM セットアップ |
| T-F-11 | tony | 5 | 0.33 | 15× | – | asyncpg + SQLAlchemy 2.0 セットアップ |
| T-F-12 | tony | 10 | 0.67 | 15× | – | LLMClient 抽象化レイヤ |
| T-F-13 | tony | 12 | 0.8 | 15× | – | LangGraph + Inngest 基盤 |
| T-F-14 | tchalla | 10 | 0.67 | 15× | – | Voyage AI 埋め込み + pgvector |
| T-F-15 | tony | 8 | 0.53 | 15× | – | Prompt Caching + Batch API + LLMLingua |
| T-F-16 | wanda | 10 | 0.67 | 15× | – | shadcn/ui + assistant-ui + tool-ui |
| T-F-17 | tony | 5 | 0.33 | 15× | – | Resend + React Email 基盤 |
| T-F-18 | vision | 6 | 0.4 | 15× | – | 監査ログ書込ライブラリ（共通） |
| T-F-19 | strange | 6 | 0.4 | 15× | – | Supabase Vault（BYOK 暗号化） |
| T-F-20 | tony | 6 | 0.4 | 15× | – | Inngest cron 基盤 |
| T-F-21 | tony | 4 | 0.27 | 15× | – | Anthropic web_search ツール統合 |
| T-F-22 | tony | 10 | 0.67 | 15× | – | MCP Server 同居実装 |
| T-F-23 | vision | 8 | 0.8 | 10× | – | Playwright E2E テスト基盤 |
| T-F-24 | vision | 5 | 0.5 | 10× | – | Vitest + pytest 基盤統合 |
| ★ T-F-25 | tony | 8 | 0.53 | 15× | 0.5 | OpenAPI → TS 型 / Pydantic 自動生成パイプライン |
| T-F-26 | vision | 6 | 0.6 | 10× | – | Schemathesis contract test 統合 |
| ★ T-F-27 | tony | 16 | 3.2 | 5× | 1.0 | Atelier Bridge 開発基盤（Vibeyard fork） |
| ★ T-F-28 | tony | 12 | 2.4 | 5× | 1.0 | Hermes 互換 kanban_tools 移植基盤 |

## Group D: Data（35 件 / Human 188h / AI 17.8h）

| ID | 担当 | Human h | AI h | accel | review | タイトル |
|---|---|---:|---:|---:|---:|---|
| T-D-01 | strange | 6 | 0.5 | 12× | – | DB スキーマ：users / workspaces / workspace_memberships |
| T-D-02 | strange | 6 | 0.5 | 12× | – | DB スキーマ：projects / phases / workflow_outputs |
| T-D-03 | strange | 5 | 0.42 | 12× | – | DB スキーマ：ai_employees / templates / skills |
| T-D-04 | strange | 5 | 0.42 | 12× | – | DB スキーマ：chat_threads / chat_messages |
| T-D-05 | strange | 7 | 0.58 | 12× | – | DB スキーマ：tasks（v3.1 Hermes 互換 10 フィールド） |
| T-D-06 | strange | 5 | 0.42 | 12× | – | DB スキーマ：task_executions / acceptance_criteria |
| T-D-07 | strange | 4 | 0.33 | 12× | – | DB スキーマ：mocks / comments |
| T-D-08 | strange | 4 | 0.33 | 12× | – | DB スキーマ：client_invitations |
| T-D-09 | strange | 6 | 0.5 | 12× | – | DB スキーマ：knowledge_nodes（pgvector 統合） |
| T-D-10 | strange | 5 | 0.42 | 12× | – | DB スキーマ：approval_inbox |
| T-D-11 | strange | 5 | 0.42 | 12× | – | DB スキーマ：audit_logs / consents / external_uploads |
| T-D-12 | strange | 5 | 0.42 | 12× | – | DB スキーマ：mcp_tokens / byok_api_keys |
| ★ T-D-13 | strange | 5 | 0.42 | 12× | 0.3 | DB スキーマ：cron_schedules + シードデータ |
| T-D-14 | strange | 7 | 0.58 | 12× | – | RLS：users / workspace_memberships per-entity policy |
| T-D-15 | strange | 6 | 0.5 | 12× | – | RLS：workspaces / projects |
| T-D-16 | strange | 6 | 0.5 | 12× | – | RLS：tasks / executions / acceptance_criteria |
| T-D-17 | strange | 6 | 0.5 | 12× | – | RLS：chat / mocks / comments / approval_inbox |
| T-D-18 | strange | 5 | 0.42 | 12× | – | RLS：knowledge_nodes（scope per entity） |
| T-D-19 | strange | 5 | 0.42 | 12× | – | RLS：audit_logs / consents / external_uploads |
| T-D-20 | strange | 5 | 0.42 | 12× | – | RLS：mcp_tokens / byok_api_keys / cron |
| T-D-21 | strange | 6 | 0.5 | 12× | – | RLS：ai_employees / templates / skills / phases / outputs |
| T-D-22 | strange | 10 | 2.5 | 4× | 3.0 | クライアント別 JWT 経路完全分離 RLS（R-T08 致命級） |
| T-D-23 | strange | 6 | 0.5 | 12× | – | Service Role bypass + Bridge token 経路 |
| T-D-24 | strange | 4 | 0.33 | 12× | – | シードデータ：AI 社員 10 名 + skill templates |
| T-D-25 | strange | 3 | 0.25 | 12× | – | シードデータ：法令ページ（terms/privacy/特商法） |
| T-D-26 | strange | 4 | 0.33 | 12× | – | Drizzle 型自動生成同期 |
| T-D-27 | strange | 4 | 0.33 | 12× | – | SQLAlchemy 型自動生成同期 |
| T-D-28 | strange | 4 | 0.33 | 12× | – | Migration 順序検証 + rollback テスト |
| T-D-29 | strange | 6 | 0.5 | 12× | – | DB index 設計（パフォーマンス） |
| T-D-30 | strange | 5 | 0.42 | 12× | – | DB バックアップ + リストア手順 |
| T-D-31 | vision | 6 | 0.6 | 10× | – | RLS 越境試験：workspace 分離（基本） |
| T-D-32 | vision | 5 | 0.5 | 10× | – | RLS 越境試験：project 分離 |
| T-D-33 | vision | 8 | 0.8 | 10× | – | RLS 越境試験：client_portal（R-T08） |
| T-D-34 | vision | 5 | 0.5 | 10× | – | RLS 越境試験：Bridge token scope |
| T-D-35 | vision | 4 | 0.4 | 10× | – | RLS 越境試験：cron / vault / mcp_tokens |

## Group A: API（45 件 / Human 310h / AI 26.6h）

| ID | 担当 | Human h | AI h | accel | review | タイトル |
|---|---|---:|---:|---:|---:|---|
| T-A-01 | thor | 8 | 0.67 | 12× | – | 認証 API：signup + 同意取得（F-LEGAL-004） |
| T-A-02 | thor | 6 | 0.5 | 12× | – | 認証 API：signin + 5 回失敗ロック |
| T-A-03 | thor | 10 | 0.83 | 12× | – | 認証 API：Magic Link + OAuth (Google/GitHub) |
| T-A-04 | thor | 6 | 0.5 | 12× | – | 認証 API：パスワードリセット + JWT/refresh |
| T-A-05 | thor | 8 | 0.67 | 12× | – | 認証 API：退会フロー（30 日猶予・F-LEGAL-002） |
| T-A-06 | thor | 6 | 0.5 | 12× | – | ワークスペース CRUD |
| T-A-07 | thor | 8 | 0.67 | 12× | – | WS メンバー管理（招待・ロール・削除） |
| T-A-08 | thor | 5 | 0.42 | 12× | – | MCP トークン管理 API |
| T-A-09 | thor | 6 | 0.5 | 12× | – | BYOK API キー管理 |
| T-A-10 | thor | 7 | 0.58 | 12× | – | プロジェクト CRUD |
| T-A-11 | thor | 6 | 0.5 | 12× | – | プロジェクト dashboard / activities API |
| T-A-12 | thor | 5 | 0.42 | 12× | – | プロジェクトアーカイブ・削除（30 日論理） |
| T-A-13 | strange | 5 | 0.42 | 12× | – | AI 学習 OFF プロジェクト/アカウント単位 |
| T-A-14 | thor | 6 | 0.5 | 12× | – | AI 社員一覧・詳細・編集 API |
| T-A-15 | thor | 4 | 0.33 | 12× | – | AI 社員テンプレ管理（運営側固定） |
| T-A-16 | thor | 6 | 0.5 | 12× | – | チャットスレッド CRUD |
| T-A-17 | thor | 6 | 0.5 | 12× | – | チャットメッセージ送信（即時） |
| T-A-18 | thor | 14 | 1.17 | 12× | – | チャット SSE ストリーミング + F-CTX01 文脈構築 |
| T-A-19 | thor | 5 | 0.42 | 12× | – | チャット分岐 + フィードバック |
| T-A-20 | thor | 7 | 0.58 | 12× | – | 工程ワークフロー一覧・遷移 |
| T-A-21 | thor | 5 | 0.42 | 12× | – | 成果物（workflow_outputs）一覧・取得 |
| T-A-22 | thor | 5 | 0.42 | 12× | – | コメント API（成果物/モック） |
| T-A-23 | strange | 10 | 0.83 | 12× | – | F-IMP01 影響範囲解析（NetworkX） |
| T-A-24 | thor | 8 | 0.67 | 12× | – | タスク再生 API（dispatcher 連動） |
| T-A-25 | thor | 8 | 0.67 | 12× | – | タスク一括再生 + 承認/差戻/再試行 |
| T-A-26 | thor | 6 | 0.5 | 12× | – | タスク CRUD + 受入条件取得 |
| T-A-27 | thor | 5 | 0.42 | 12× | – | タスク実行履歴・スコア取得 |
| T-A-28 | tony | 14 | 1.17 | 12× | – | Hermes 互換 kanban_tools 7 ツール完全実装 |
| T-A-29 | tony | 8 | 0.67 | 12× | – | サーキットブレーカ + PID ポーリング |
| T-A-30 | thor | 8 | 0.67 | 12× | – | 実行モニター API + Bridge 状態 |
| T-A-31 | thor | 6 | 0.5 | 12× | – | 実行ログ SSE 配信 |
| T-A-32 | thor | 10 | 0.83 | 12× | – | 承認待ちインボックス（5 種統合 + decide） |
| T-A-33 | thor | 5 | 0.42 | 12× | – | モック CRUD + バージョン管理 |
| T-A-34 | thor | 6 | 0.5 | 12× | – | クライアント招待管理 API |
| T-A-35 | thor | 8 | 0.67 | 12× | – | クライアント別 JWT signin + project view（R-T08） |
| T-A-36 | tchalla | 10 | 0.83 | 12× | – | ナレッジ CRUD + Voyage semantic 検索 |
| T-A-37 | tchalla | 7 | 0.58 | 12× | – | ナレッジ昇格 + 横断パターン抽出 |
| T-A-38 | steve | 8 | 0.67 | 12× | – | 議事録 + Whisper transcription |
| T-A-39 | steve | 6 | 0.5 | 12× | – | 商談ドキュメント（提案・見積・契約） |
| T-A-40 | tony | 6 | 0.5 | 12× | – | cron スケジュール CRUD + Inngest 連動 |
| T-A-41 | thor | 6 | 0.5 | 12× | – | 運営 admin dashboard / users |
| T-A-42 | thor | 6 | 0.5 | 12× | – | 運営 admin スキル + AI 社員テンプレ管理 |
| T-A-43 | thor | 4 | 0.33 | 12× | – | 運営 admin 監査ログ閲覧 |
| T-A-44 | thor | 5 | 0.42 | 12× | – | 公開ページ API（法令 4 ページ + データ削除請求） |
| ★ T-A-45 | tony | 6 | 1.2 | 5× | 2.0 | ★ OpenAPI 確定 + TS 型自動生成 + screen-api-coverage 100% 検証 ★ API 契約凍結 |

## Group U-shared: UI 共通基盤（18 件 / Human 96h / AI 9.6h）

| ID | 担当 | Human h | AI h | accel | review | タイトル |
|---|---|---:|---:|---:|---:|---|
| T-US-01 | wanda | 8 | 0.8 | 10× | – | AppShell（サイドバー + トップバー + main） |
| T-US-02 | wanda | 6 | 0.6 | 10× | – | WS / プロジェクトピッカー |
| T-US-03 | thor | 6 | 0.6 | 10× | – | 認証フロー配管（JWT Cookie / refresh） |
| ★ T-US-04 | tony | 6 | 0.6 | 10× | 0.5 | 型安全 API クライアント（openapi-typescript 消費） |
| T-US-05 | wanda | 5 | 0.5 | 10× | – | TanStack Query 設定 + キャッシュ戦略 |
| T-US-06 | wanda | 4 | 0.4 | 10× | – | ErrorBoundary + Sentry 統合 |
| T-US-07 | wanda | 8 | 0.8 | 10× | – | 通知ベル + Realtime 購読 |
| T-US-08 | wanda | 5 | 0.5 | 10× | – | 共通モーダル / Dialog / Toast |
| T-US-09 | wanda | 4 | 0.4 | 10× | – | アバター + AI 社員アイコン |
| T-US-10 | wanda | 6 | 0.6 | 10× | – | 共通テーブル + カーソルページネーション |
| T-US-11 | wanda | 5 | 0.5 | 10× | – | 共通フォーム（React Hook Form + Zod） |
| T-US-12 | wanda | 4 | 0.4 | 10× | – | i18n 配管（v1 日本語のみ） |
| T-US-13 | wanda | 6 | 0.6 | 10× | – | a11y 基盤（WCAG 2.2 AA） |
| T-US-14 | wanda | 4 | 0.4 | 10× | – | 印刷スタイル + PDF 出力 |
| T-US-15 | wanda | 6 | 0.6 | 10× | – | クライアントポータル用別レイアウト |
| T-US-16 | wanda | 6 | 0.6 | 10× | – | 運営 admin 用別レイアウト（ダーク） |
| T-US-17 | wanda | 3 | 0.3 | 10× | – | ローディング / スケルトン共通 |
| T-US-18 | wanda | 4 | 0.4 | 10× | – | デザイントークン Tailwind 反映 |

## Group U-screen: UI 画面（40 件 / Human 368h / AI 36.8h）

| ID | 担当 | Human h | AI h | accel | review | タイトル |
|---|---|---:|---:|---:|---:|---|
| T-UC-01 | thor | 14 | 1.4 | 10× | – | S-A01 サインイン/サインアップ画面 |
| T-UC-02 | thor | 12 | 1.2 | 10× | – | S-A03 ワークスペース設定 |
| T-UC-03 | thor | 10 | 1.0 | 10× | – | S-B01 プロジェクト一覧 |
| T-UC-04 | thor | 14 | 1.4 | 10× | – | S-B02 プロジェクトダッシュボード |
| T-UC-05 | thor | 8 | 0.8 | 10× | – | S-B03 プロジェクト設定 |
| T-UC-06 | wanda | 8 | 0.8 | 10× | – | S-C01 AI 社員組織図 |
| T-UC-07 | wanda | 8 | 0.8 | 10× | – | S-C02 AI 社員詳細・編集 |
| T-UC-08 | thor | 20 | 2.0 | 10× | – | S-E01 チャット（assistant-ui + SSE + tool-ui） |
| T-UC-09 | wanda | 6 | 0.6 | 10× | – | S-E01 工程文脈バー（工程連動） |
| T-UC-10 | thor | 14 | 1.4 | 10× | – | S-F01 工程ワークフロー（司令塔） |
| T-UC-11 | thor | 8 | 0.8 | 10× | – | S-F02 フェーズ管理 |
| T-UC-12 | thor | 12 | 1.2 | 10× | – | S-G01 成果物ビューア（コメントピン） |
| T-UC-13 | thor | 8 | 0.8 | 10× | – | S-H01 モックビューア |
| T-UC-14 | thor | 18 | 1.8 | 10× | – | S-I01 タスクボード（6 列・再生バー） |
| T-UC-15 | thor | 14 | 1.4 | 10× | – | S-I02 タスク詳細（6 タブ） |
| T-UC-16 | thor | 14 | 1.4 | 10× | – | S-I03 実行モニター（ダーク・SSE ログ） |
| T-UC-17 | thor | 12 | 1.2 | 10× | – | S-J01 承認待ち（5 種統合） |
| T-UC-18 | thor | 10 | 1.0 | 10× | – | S-K01 ナレッジエクスプローラ |
| T-UC-19 | thor | 8 | 0.8 | 10× | – | S-K02 ナレッジ昇格レビュー |
| T-UC-20 | thor | 8 | 0.8 | 10× | – | S-L01 クライアント招待管理 |
| T-UC-21 | thor | 4 | 0.4 | 10× | – | S-L02 クライアントサインイン |
| T-UC-22 | thor | 10 | 1.0 | 10× | – | S-L03 クライアントプロジェクトビュー |
| T-UC-23 | thor | 10 | 1.0 | 10× | – | S-M01 議事録アップロード + transcript |
| T-UC-24 | thor | 10 | 1.0 | 10× | – | S-N01 商談ドラフト |
| T-UC-25 | thor | 8 | 0.8 | 10× | – | S-O01 自動スケジュール |
| T-UC-26 | thor | 4 | 0.4 | 10× | – | S-PUB01 利用規約 |
| T-UC-27 | thor | 4 | 0.4 | 10× | – | S-PUB02 プライバシーポリシー |
| T-UC-28 | thor | 4 | 0.4 | 10× | – | S-PUB03 特商法表記 |
| T-UC-29 | thor | 5 | 0.5 | 10× | – | S-PUB04 データ削除請求 |
| T-UC-30 | thor | 14 | 1.4 | 10× | – | S-T01 運営ダッシュボード（ダーク） |
| T-UC-31 | thor | 8 | 0.8 | 10× | – | S-T02 スキル管理 |
| T-UC-32 | thor | 8 | 0.8 | 10× | – | S-T03 AI 社員テンプレ |
| T-UC-33 | thor | 8 | 0.8 | 10× | – | S-T04 ユーザー管理 |
| T-UC-34 | thor | 8 | 0.8 | 10× | – | S-T05 監査ログ |
| T-UC-35 | wanda | 8 | 0.8 | 10× | – | 横断機能：オンボーディング・ウェルカム |
| T-UC-36 | wanda | 6 | 0.6 | 10× | – | 横断機能：通知センター |
| T-UC-37 | thor | 6 | 0.6 | 10× | – | 横断機能：ユーザープロフィール |
| T-UC-38 | wanda | 5 | 0.5 | 10× | – | 横断機能：WS 切替 |
| T-UC-39 | wanda | 6 | 0.6 | 10× | – | 横断機能：プロジェクト切替 |
| T-UC-40 | wanda | 6 | 0.6 | 10× | – | 横断機能：検索（グローバル） |

## Group I: Integration & Polish（24 件 / Human 153h / AI 14.4h）

| ID | 担当 | Human h | AI h | accel | review | タイトル |
|---|---|---:|---:|---:|---:|---|
| T-I-01 | vision | 6 | 0.6 | 10× | – | E2E：サインアップ → ダッシュボード |
| T-I-02 | vision | 8 | 0.8 | 10× | – | E2E：プロジェクト → タスク再生 → 承認 |
| T-I-03 | vision | 6 | 0.6 | 10× | – | E2E：チャット F-CTX01 完走 |
| T-I-04 | vision | 6 | 0.6 | 10× | – | E2E：退会 → 30 日後 hard delete |
| T-I-05 | vision | 8 | 0.8 | 10× | – | RLS 越境：workspace 完全分離 + 整合性 |
| T-I-06 | vision | 5 | 0.5 | 10× | – | RLS 越境：project + Bridge token |
| T-I-07 | vision | 8 | 0.8 | 10× | – | RLS 越境：client_portal 完全分離（R-T08 最終） |
| T-I-08 | vision | 4 | 0.4 | 10× | – | RLS 越境：service_role + vault + cron |
| T-I-09 | vision | 8 | 0.8 | 10× | – | Lighthouse 性能（全 33 画面 CWV） |
| T-I-10 | vision | 6 | 0.6 | 10× | – | a11y axe 検査（全 33 画面 AA） |
| T-I-11 | tony | 8 | 0.53 | 15× | – | Bridge 配布 macOS .dmg（signed&notarized） |
| T-I-12 | tony | 6 | 0.4 | 15× | – | Bridge 配布 Linux/Windows + npm publish |
| T-I-13 | vision | 10 | 1.0 | 10× | – | F-J02 仕様徹底ループ統合試験（並列 5-10） |
| T-I-14 | vision | 6 | 0.6 | 10× | – | F-J02 retry + 承認フロー試験 |
| T-I-15 | vision | 6 | 0.6 | 10× | – | 並列実行 10 並列 ストレス試験 |
| T-I-16 | vision | 8 | 0.8 | 10× | – | F-CUC01-04 継続更新サイクル試験 |
| T-I-17 | vision | 6 | 0.6 | 10× | – | F-IMP01 影響範囲解析 NetworkX 試験 |
| T-I-18 | vision | 6 | 0.6 | 10× | – | F-CTX01 ハイブリッド文脈構築試験 |
| T-I-19 | tony | 6 | 0.5 | 12× | – | dead code cleanup（knip/depcheck/ts-prune） |
| T-I-20 | wanda | 8 | 0.53 | 15× | – | Storybook 統合（任意・Phase 5+） |
| T-I-21 | tony | 6 | 0.4 | 15× | – | 本番ドメイン・SSL・カスタムドメイン |
| T-I-22 | tony | 4 | 0.27 | 15× | – | 本番監視ダッシュボード（Better Stack） |
| T-I-23 | tony | 4 | 0.27 | 15× | – | 本番ロールバック手順書 |
| T-I-24 | vision | 4 | 0.8 | 5× | 2.0 | ★ 本番リリース判定（v3-gate.yml 10 全 PASS）★ |

---

## 二軸の使い分け（schedule-design 連動）

- 投資家・顧客向けプレゼン → **Human** 列を提示
- 経営判断・実カレンダー → **AI** 列を採用
- 監査・SOC2 / ISO → **Human** 列（プロセスドキュメント基準）
- 売却 DD → **両方併記**

詳細は [`../08_schedule/SCHEDULE.md`](../08_schedule/SCHEDULE.md) と [`decision-log.json`](./decision-log.json) を参照。