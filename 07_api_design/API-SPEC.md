# Atelier API 設計書 v1.0

**作成日**：2026-05-20
**API 契約凍結**：2026-05-20T13:30:00+09:00
**スキル**：api-design v3.1（Mock-Driven Contract Generation 採用）
**オーナー**：高本まさと

## 1. 設計方針

- **スタイル**：REST
- **バージョニング**：URL バージョニング（`/api/v1/`）
- **ベース URL**：`https://atelier.app/api/v1`
- **レスポンス形式**：JSON
- **日時形式**：ISO 8601（TIMESTAMPTZ）
- **ID 形式**：UUID v7（時系列ソート可能）
- **ページネーション**：カーソル方式（デフォルト）+ 一部オフセット方式
- **総 endpoint 数**：**119**

## 2. 認証・認可（4 系統）

| 系統 | role | 用途 | 主な使用 endpoint |
|---|---|---|---|
| **一般 JWT**（Supabase Auth）| authenticated | Web / MCP 経由の一般ユーザー | `/auth/*`, `/workspaces/*`, `/projects/*` ほぼ全て |
| **クライアント別 JWT**（R-T08 致命級リスク対応）| client_portal | クライアント招待ポータル | `/client/*` |
| **MCP Token** | mcp_client | 外部 MCP クライアント（Claude デスクトップ等）| `/mcp/*` |
| **Service Role**（含 Bridge worker）| service_role | バックエンド内部 + Hermes 互換 kanban tools | `/kanban/*` |

**JWT トークン仕様**：
- Access Token：15 分
- Refresh Token：7 日（httpOnly Cookie）
- クライアント別 JWT は `project_id` のみクレーム（users / workspaces テーブルへのアクセス禁止）

## 3. エンドポイント一覧（カテゴリ別）

| カテゴリ | endpoint 数 | implementation_path |
|---|---|---|
| auth | 11 | `apps/api/src/routes/auth.py` |
| workspaces | 9 | `apps/api/src/routes/workspaces.py` |
| projects | 8 | `apps/api/src/routes/projects.py` |
| employees | 4 | `apps/api/src/routes/employees.py` |
| chat (F-CTX01) | 8 | `apps/api/src/routes/chat.py` |
| workflow | 7 | `apps/api/src/routes/workflow.py` |
| tasks | 11 | `apps/api/src/routes/tasks.py` |
| kanban-tools (Hermes 互換) | 7 | `apps/api/src/routes/kanban_tools.py` |
| executions / bridge | 6 | `apps/api/src/routes/{executions,bridge}.py` |
| approval-inbox | 2 | `apps/api/src/routes/approval_inbox.py` |
| mocks | 3 | `apps/api/src/routes/mocks.py` |
| client-portal | 6 | `apps/api/src/routes/client_*.py` |
| knowledge | 7 | `apps/api/src/routes/knowledge.py` |
| meetings | 3 | `apps/api/src/routes/meetings.py` |
| sales | 4 | `apps/api/src/routes/sales.py` |
| cron | 4 | `apps/api/src/routes/cron.py` |
| admin | 8 | `apps/api/src/routes/admin/*.py` |
| public | 4 | `apps/api/src/routes/public.py` |
| mcp | 2 | `apps/api/src/mcp/server.py` |
| byok / consents | 5 | `apps/api/src/routes/{byok,consents}.py` |
| **合計** | **119** | |

**全 endpoint のパス・メソッド・implementation_path**：`lint-mapping.json` に列挙

## 4. エンドポイント詳細

主要 17 endpoint の完全仕様（リクエスト・レスポンス・outputs_4xx・ears_ac_seed）は `ears-ac-seed.json` 参照。全 119 endpoint の機械可読仕様は `openapi.yaml` 参照。

### 重要 endpoint サマリ

| メソッド | パス | 説明 |
|---|---|---|
| POST | `/auth/signup` | 新規登録 + 同意取得（terms / privacy / cross_border）|
| POST | `/auth/signin` | サインイン（5 回失敗で 15 分ロック）|
| DELETE | `/auth/account` | 退会申請（30 日猶予開始）|
| POST | `/chat-threads/:id/messages/stream` | SSE ストリーミング（F-CTX01 文脈構築）|
| POST | `/tasks/:id/play` | タスク再生（dispatcher → Bridge worker）|
| POST | `/kanban/complete` | Hermes 互換完了報告（F-J02 スコア閾値振分）|
| GET | `/approval-inbox` | 5 種統合（task/phase/scope/knowledge/comment）|
| POST | `/approval-inbox/:id/decide` | 承認/差し戻し/保留 |
| POST | `/client/auth/signin` | クライアント別 JWT 発行（R-T08 対応）|
| GET | `/admin/dashboard` | 運営 KPI |

## 5. 共通仕様・エラーハンドリング

### レスポンス封筒

```json
// 単一
{ "data": { ... } }

// 一覧（カーソル）
{ "data": [...], "meta": { "next_cursor": "...", "limit": 20 } }

// エラー
{ "error": { "code": "...", "message": "...", "details": [...], "request_id": "uuid" } }
```

### エラーコード一覧

25 種を `lint-mapping.json` の `ErrorCode` enum に定義。代表例：
- `UNAUTHENTICATED` / `INVALID_CREDENTIALS` / `ACCOUNT_LOCKED`
- `FORBIDDEN` / `NOT_FOUND` / `CONFLICT`
- `VALIDATION_ERROR` / `CONSENT_REQUIRED`
- `RATE_LIMITED` / `BYOK_QUOTA_EXCEEDED`
- `INVALID_LIFECYCLE_STAGE` / `DEPENDENCIES_NOT_MET` / `BRIDGE_OFFLINE`
- `INVITATION_EXPIRED` / `INVALID_INVITATION_TOKEN`

### レート制限

- 認証系：5/min/ip
- Magic Link / パスワードリセット：3/min/ip + 1/min/email
- 一般 GET：100/min/user
- 一般 POST/PATCH/DELETE：60/min/user
- チャット送信：30/min/user
- タスク再生：10/min/user
- MCP Server：100/min/token

### CORS

許可オリジン：`atelier.app`, `*.atelier.app`, `*.vercel.app`, `localhost:3000`

### キャッシュ

- `/public/legal/*`：CDN + 1h
- `/auth/me`：60s
- `/knowledge/search`：Redis 24h
- `/tasks`, `/executions`：キャッシュ無し

## 6. CI Gate（v3-gate.yml）

10 種のゲートを定義。Phase 別有効化：

| Gate # | チェック | 失敗時 | 適用 phase |
|---|---|---|---|
| 1 | lint（ruff / eslint）| Block | Foundation〜 |
| 2 | 3-tier AC validator | Block | Phase 5〜 |
| 3 | type check（pyright / tsc）| Block | Foundation〜 |
| 4 | coverage ≥ 80% | Warn → Block | Phase 6 |
| 5 | endpoint-implementation-existence | Block | Phase 3〜 |
| 6 | mock-impl-diff | Block | Phase 5〜 |
| 7 | 型生成同期 drift | Block | Phase 3〜 |
| 8 | contract test (Schemathesis) | Block | Phase 3〜 |
| 9 | 画面 ↔ API カバレッジ 100% | Block | Phase 3 完了時 |
| 10 | RLS 越境テスト | Block | Phase 2 完了時〜 |

## 7. 型自動生成パイプライン

```bash
pnpm run gen:api
# 1. FastAPI → OpenAPI YAML
# 2. openapi-typescript → TS 型
# 3. datamodel-code-generator → Pydantic スキーマ
# 4. drift check（CI gate #7）
```

## 8. 変更履歴

| 日付 | バージョン | 内容 |
|---|---|---|
| 2026-05-20 | v1.0 | 初版・**API 契約凍結** |

## 9. 関連ファイル

- `openapi.yaml` — 機械可読仕様（信頼源）
- `types.ts` — TypeScript 型定義
- `screen-api-coverage.json` — 画面 ↔ API 逆引きマトリクス（v3.1）
- `ears-ac-seed.json` — Tier 2 functional AC source
- `lint-mapping.json` — endpoint-implementation-existence check 用
- `decision-log.json` — 設計判断ログ

## 10. 次工程への引き継ぎ

**task-decomposition skill** が `decomposition_mode: api_first` モードで実行する際の入力：

- 上記 7 ファイルすべて
- `04_functional_breakdown/` 配下（screens.json / features.json / entities.json / roles.json / traceability-matrix.json *予定*）
- `06_mockups/` 配下（33 画面）

→ 6 Phase 構成（Foundation / Data / API / UI Foundation / UI Parallel / Integration）でタスク分解
→ Phase 3 (API Layer) 完了時に **API 契約凍結** マイルストーン
→ Phase 5 (UI Parallel) で 33 画面を並列実装可能化
