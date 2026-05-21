# Atelier アーキテクチャ設計書 v1.0
作成日：2026-05-18 ／ オーナー：高本まさと

## 1. 全体方針

**モジュラーモノリス × 2-tier**：Next.js（フロント+BFF）と Python FastAPI（AI処理層）の2サービス構成。共通DBは Supabase Postgres（Tokyo region）。1人運用＋3ヶ月期限＋並列5-10AIタスクという制約に対する現実解。

**コスト方針**：初期は Free tier 最大活用で月 $0-10 を目標、必要時に段階的に有料化。BYOK でユーザー負担に寄せる。

## 2. システム構成図

```
[ユーザーの PC]
  ├─ [Atelier Bridge Desktop]                  ← Vibeyard fork (MIT)
  │   ├─ pty-manager (node-pty + xterm.js)
  │   ├─ claude CLI / codex CLI / gemini CLI
  │   ├─ git worktree per task
  │   └─ SSE → Atelier Cloud
  │
  └─ [Browser] ←──────────┐
                          |
        [Claude Desktop / MCP Client]
                          |
                          | MCP Protocol
                          |
[Next.js on Vercel] ←REST/SSE→ [Python FastAPI on Fly.io Tokyo]
    |                          ├─ Task Dispatcher (Hermes port, MIT)
    |                          │   ├─ HERMES_KANBAN_TASK env worker spawn
    |                          │   ├─ kanban_show / complete / block / unblock 7 tools
    |                          │   ├─ サーキットブレーカ + PID ポーリング
    |                          │   └─ 構造化ハンドオフ (summary + metadata)
    |                          ├─ Anthropic API (Claude + web_search)
    |                          ├─ Voyage AI (embed/rerank)
    |                          ├─ Whisper API (議事録)
    |                          └─ ↑ Bridge と双方向通信 (SSE/WebSocket)
    |                          |
    └─[Supabase Tokyo region]──┘
        ├─ Postgres 16 + pgvector
        ├─ Auth + RLS
        ├─ Storage
        ├─ Realtime
        └─ Vault (BYOK keys, ツール内 AI 用のみ)

[Inngest] (cron / scheduled jobs)
[Sentry] [Langfuse OSS] [Better Stack] (observability)
```

**実装フロー（工程 7）の詳細：**

1. ユーザーが Web UI でタスクを再生 → Next.js → FastAPI Dispatcher
2. Dispatcher が依存関係を解決し、Ready 列のタスクを並列実行枠まで pop
3. Dispatcher が Bridge へ WebSocket で worker spawn 指示（task_id, profile, worktree_path）
4. Bridge がローカルで `git worktree add` → PTY で `claude` CLI を `HERMES_KANBAN_TASK=<id>` env 付きで起動
5. claude プロセスは Hermes 互換の `kanban_show()` で自分のタスク詳細を取得し実装
6. 完了時に `kanban_complete(summary, metadata)` を呼び、結果が Atelier クラウドへ反映
7. Dispatcher が F-J02 スコア閾値で Awaiting (人間判断) or Done (自動承認) に振り分け
8. 失敗時はサーキットブレーカが最大 3 回再試行、超過で Blocked に固定

## 3. 技術スタック一覧

### フロント
- Next.js 15 (App Router) + TypeScript strict
- Tailwind CSS + shadcn/ui
- **assistant-ui**（チャット基盤、Thread/Composer/Status/Context）
- **tool-ui**（Tool Call カード表示）
- **Lucide React**（アイコン統一、絵文字禁止）
- Zustand + TanStack Query + React Hook Form + Zod
- Drizzle ORM (Edge Runtime対応)

### バックエンド（AI処理層）
- Python 3.12 + FastAPI + uv + ruff + pyright strict
- Anthropic SDK + Claude Agent SDK
- **Task Dispatcher**: Hermes Agent (MIT) port — `HERMES_KANBAN_TASK` env worker spawn / 7 kanban tools / サーキットブレーカ / 構造化ハンドオフ
- LangGraph（人間承認・スコアループ）+ Inngest（cron）
- LlamaIndex + Cognee + Voyage AI（RAG）
- LLMLingua（プロンプト圧縮）
- Whisper API + Unstructured.io
- 自前 LLMClient 抽象化（chat/stream/tool/search/embed/count）
- MCP Server 同居
- asyncpg + SQLAlchemy 2.0 Core

### デスクトップクライアント（Atelier Bridge）
- **Vibeyard fork (MIT, elirantutia/vibeyard)** をベース、Atelier ブランド化
- Electron + TypeScript + node-pty + xterm.js
- 流用：pty-manager / claude-cli・codex-cli・gemini-cli 接続 / セッション再開 / カンバン UI / swarm モード
- 追加：Atelier クラウドへの SSE 接続 / 9 工程ワークフロー連動 / AI 社員 Skill 自動注入 / Hermes 互換タスクハンドオフ
- 削除：P2P セッション共有 / 埋め込みブラウザ / Vibeyard 独自 AI Readiness Score
- 配布：macOS (.dmg signed&notarized) / Linux (.deb, .AppImage) / Windows (.exe NSIS+portable) / npm `atelier-bridge`

### データ層
- Supabase Postgres 16（Tokyo region）+ pgvector
- 25 エンティティ、UUID v7、ソフトデリート、TIMESTAMPTZ
- Drizzle ORM（TS側）+ asyncpg（Python側）
- Supabase CLI でマイグレーション管理

### インフラ
- Vercel Hobby (Next.js) + Fly.io Tokyo (FastAPI) + Supabase Tokyo
- Cloudflare DNS, Vercel Edge CDN
- Resend (メール), Stripe (Phase 8)
- 全て Free tier 開始

### CI/CD
- GitHub Actions（8 merge gate）
- pnpm workspaces + Turborepo
- trunk-based + worktree、branch `<agent>/<task_id>`、squash auto-merge

### 観測
- Sentry Free（エラー）
- Langfuse OSS（LLM トレース・コスト）
- Better Stack Free（死活監視）
- Vercel/Fly.io/Supabase Dashboard（メトリクス）

## 4. DB設計方針

- **PostgreSQL 16 + pgvector**、別エンジン不要
- **UUID v7 PK** + **ソフトデリート**（30日後ハード削除）+ **TIMESTAMPTZ**
- **snake_case_plural** 命名、`idx_<table>_<col>` インデックス
- **per-entity RLS policy**：通常ユーザー JWT と クライアント招待 JWT を完全分離
- **マイグレーション**：Supabase CLI、番号順、CI で staging 自動適用
- 主要 ENUM 19 種定義済み

## 5. インフラ・デプロイ構成

| 環境 | URL例 | ホスティング |
|---|---|---|
| local | localhost | Supabase CLI Docker |
| preview | `atelier-pr-N.vercel.app` | Vercel Preview + Supabase preview branch + Fly.io review |
| staging | `staging.atelier.app` | Vercel + Supabase staging + Fly.io |
| production | `atelier.app` | Vercel + Supabase production + Fly.io Tokyo |

### CI/CD フロー
```
PR open
  → Foundation Phase Gate (8 merge gate, 並列実行)
    1. mock lint (ESLint + Prettier + ruff + shellcheck + no-emoji)
    2. 3-tier AC validator
    3. audit MD validator
    4. RLS coverage
    5. unit test + coverage (≥80%)
    6. type check backend (pyright strict)
    7. type check frontend + lint (tsc + ESLint --max-warnings 0)
    8. mock-impl diff (has-frontend label)
  → preview deploy
  → squash auto-merge
  → staging 自動デプロイ
  → production (手動承認)
```

## 5.5. Hybrid Context Construction Layer（重要設計）

本ツールのチャット品質の心臓部。「直近 N 件 slicing」ではなく **DB-as-truth + セマンティック関連性ベース** でコンテキストを構築する。

```
[ FastAPI 内 context/builder.py の構築フロー ]

ユーザー発話
    ↓
1. AI 社員ペルソナ（system_prompt + tone_preset + skills metadata）  ← 静的
2. 直近メッセージ 5-10 件                                              ← 短期記憶（テンポ）
3. プロジェクト現在状態スナップショット（DB SELECT, 常に最新）          ← DB-as-truth
     - 現在 phase / 最新 workflow_outputs / アクティブ tasks / 未承認 inbox
4. セマンティック関連メッセージ（Voyage embedding + リランカー）        ← 長期記憶
     - スレッド内優先、cross-thread は同プロジェクト内に限定
     - 時間減衰（古いものは段階的に重み低下）
5. RAG ナレッジ検索（社員別優先 + 共通フォールバック）                   ← アカウント横断知見
6. 言及エンティティの最新値 SELECT（NER 風抽出）                        ← DB-as-truth
7. 合計トークン 80% 超過時のみ LLMLingua 圧縮（state/knowledge は保護） ← コスト最適化
    ↓
LLMClient.chat() に統合プロンプト
```

**人間直編集の扱い：** ユーザーがモックや成果物を直接編集した時、DB 更新 + audit_logs 記録のみ。チャット履歴への変更イベント注入はしない。次のチャット応答時に F-CTX01 が必ず DB 最新を再 SELECT してコンテキストに含めるため、自動整合する。

**Impact Analyzer（F-IMP01）：** フェーズ間タスク移動・新フェーズ追加・仕様変更時に、tasks.dependencies/prerequisites/blocks のグラフを traverse し、影響を受ける下流タスクを抽出。実装済みタスクに変更が必要なら UI で警告 + 再分解推奨。

**継続的更新サイクル（CUC: F-CUC01〜04）：** 初期一気通貫後の「あとから機能追加・仕様変更」を完全自動化する4機能群。

| 機能 | 役割 |
|---|---|
| F-CUC01 | チャット/出力編集/議事録から変更を検知し、影響工程の再実行を ApprovalInbox 経由で提案 |
| F-CUC02 | タスク状態別の更新ポリシー（pending=自動上書き / in_progress=3択判断 / completed=リファクタタスク自動起票（parent_task紐付け）） |
| F-CUC03 | 成果物の三層出力を版管理で再生成、クライアント招待中はメール通知 |
| F-CUC04 | Inngest cron で日次整合性チェック（削除済タスクID残存・AC陳腐化・mock削除・files_changed重複） |

## 6. セキュリティ方針

- TLS 1.3、HSTS、Mixed Content 禁止
- Supabase Auth + Postgres **RLS**（プライマリ）+ Application Layer 二重チェック
- JWT HTTP-only Cookie + SameSite Lax
- CSP nonce-based、`unsafe-inline` 禁止
- AES-256（at-rest）+ Supabase Vault（BYOK keys）
- 個人情報閲覧 監査ログ 1年保持
- 招待リンク：JWT + 有効期限（数日）+ 使用後失効 + ハッシュ照合
- データ越境同意：サインアップ時にリージョン明示

## 7. 設計トレードオフ一覧

| 採用 | 犠牲 | 妥当性 |
|---|---|---|
| TS + Python 2言語 | 脳内コンテキストスイッチ | AI 機能品質を優先 |
| Vercel + Fly.io 2デプロイ | 単一プラットフォーム簡潔さ | Tokyo region と長時間実行を両立 |
| Inngest 追加 | サービス数増 | cron/イベント駆動の安全性 |
| 自前 LLMClient 抽象化 | Vercel AI SDK 等の便利機能 | プロバイダー切替の確実性 |
| Drizzle ORM | Prisma の成熟エコシステム | Edge + Supabase + RLS 親和性 |
| Supabase ロックイン | ベンダー独立性 | RLS 価値が圧倒的 |
| Free tier 中心の運用 | 制限による運用工夫 | コスト 0 を優先 |

## 8. リスク・未確認事項

致命級リスク：
- R-T08: RLS設計ミスでクライアント漏洩 → Gate #4 RLS coverage で網羅検証
- R-O05: 個人情報漏洩 → 暗号化 + アクセスログ + 48h 通知
- R-L01: 電気通信事業届出未提出 → リリース 1ヶ月前に法務確認

未確認事項：
- Claude Code ブリッジ OAuth 可否（Phase 0 PoC）
- 電気通信事業届出要否（リーガル確認）
- スコア計算式チューニング（Phase 1 実走）
- AI 学習可否デフォルト（ADR-010 で OFF 確定）

## 関連ファイル

- [architecture.json](./architecture.json) — 設計データ
- [selected-stack.json](./selected-stack.json) — 全選定一覧
- [foundation_gates.json](./foundation_gates.json) — Foundation gate 定義
- [adrs-to-create.json](./adrs-to-create.json) — Phase 0 起票必須 ADR 15件
- [v3-gate.yml](./v3-gate.yml) — GitHub Actions テンプレ
- [decision_log.json](./decision_log.json) — 判断ログ
- [architecture-v1.html](./architecture-v1.html) — 人間向け HTML 仕様書
- [er-diagram-v1.html](./er-diagram-v1.html) — ER 図

## 次のスキル

**`functional-breakdown`（機能分解）** に進む。
順序：architecture-design → **functional-breakdown** → feature-decomposition → task-decomposition
