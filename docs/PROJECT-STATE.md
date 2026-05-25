# Atelier — Project State Snapshot

> 最終更新: 2026-05-26
> 目的: スマホ含むどの Claude セッションでも 1 ファイル読むだけで「今どこまで進んだか」
> 「次は何をするか」が把握できるようにする。
>
> 信頼源は `07_tasks/tickets.json`。本ファイルは人間/AI 向けの **読みやすい要約** であり、
> 不整合があれば tickets.json を正とする。

---

## フェーズ

- 計画フェーズ: ✅ 12 スキル全完走
- 実装フェーズ: 🔨 Wave 0 完了 → Wave 1 Group D 進行中

---

## 完了済み (merged to main)

### Wave 0 Foundation
- T-F-05, T-F-06, T-F-08, T-F-14, T-F-15, T-F-20, T-F-21, T-F-22, T-F-28
- monorepo (pnpm + Turborepo) / Next.js 15 / FastAPI + uv / Husky + lint-staged
- Vercel + Supabase + Fly.io NRT + Sentry EU 接続済
- CI v3-gate.yml 13 gate 稼働

### Wave 1 Group D — Schema (T-D-01 ~ T-D-13)
全 13 タスク merged。主要 entity:
- users / workspaces / workspace_memberships
- projects / phases / workflow_outputs
- ai_employees / templates / skills
- chat_threads / chat_messages
- tasks (v3.1 Hermes 互換 10 フィールド) / task_executions / acceptance_criteria
- mocks / comments
- client_invitations
- knowledge_nodes (pgvector 1024-dim, HNSW index, Voyage AI 連携)
- approval_inbox
- audit_logs / consents / external_uploads (append-only, RESTRICTIVE deny)
- mcp_tokens / byok_api_keys (Supabase Vault)
- cron_schedules + シードデータ

### Wave 1 Group D — RLS (T-D-14 ~ T-D-21)
全 8 タスク merged:
- T-D-14: users / workspace_memberships
- T-D-15: workspaces / projects
- T-D-16: tasks / executions / acceptance_criteria
- T-D-17: chat / mocks / comments / approval_inbox (`user_is_comment_target_owner()` helper)
- T-D-18: knowledge_nodes (scope=common は member 全員、employee_specific は将来 T-F-40)
- T-D-19: audit_logs / consents / external_uploads (R-T08)
- T-D-20: mcp_tokens / byok_api_keys / cron
- T-D-21: ai_employees / templates / skills / phases / workflow_outputs

### Infrastructure / Skill enforcement
- `scripts/begin-task.sh` — STEP 0/2/3 atomic 実行 (PR #112)
- `.husky/pre-commit` — JIT skill skip を構造的に拒否 (PR #112)
- `scripts/verify_rls_isolation.py` — 19 entity 全て R-T08 runtime 検証 (PR #113)
- tickets.json: T-D-18 design_decisions_inline + T-F-40 follow-up 起票 (PR #114)
- `docs/JIT-SKILL.md`, `docs/PROJECT-STATE.md` — モバイル portability 確保 (本 PR)

---

## 進行中 (Group D 残タスク)

| ID | タイトル | 優先度 | 備考 |
|---|---|---|---|
| **T-D-22** | クライアント別 JWT 経路完全分離 RLS (R-T08 致命級) | 🚨 致命級 | 経営者承認必須 (3h) |
| T-D-23 | Service Role bypass + Bridge token 経路 | 高 | T-D-22 依存 |
| T-D-24 | シードデータ：AI 社員 10 名 + skill templates | 中 | 独立 |
| T-D-25 | シードデータ：法令ページ (terms/privacy/特商法) | 中 | 独立 |
| **T-D-26** | Drizzle 型自動生成同期 | 中 | T-D-01〜13 依存済 → **即着手可** |
| T-D-27 | SQLAlchemy 型自動生成同期 | 中 | 独立 |
| T-D-28 | Migration 順序検証 + rollback テスト | 中 | 独立 |
| T-D-29 | DB index 設計 (パフォーマンス) | 中 | 独立 |
| T-D-30 | DB バックアップ + リストア手順 | 中 | 独立 |
| T-D-31〜35 | RLS 越境試験 (workspace/project/client_portal/Bridge/cron) | 高 | T-D-22 依存 |

---

## 次の推奨タスク

### 第一候補: **T-D-26 (Drizzle 型自動生成同期)**
- 依存: T-D-01〜13 (完了済)
- 致命級でない → AI 単独 merge 可
- 着手コマンド: `./scripts/begin-task.sh T-D-26`

### 第二候補: T-D-24 / T-D-25 / T-D-27 (シード or 型同期、独立タスク)

### 致命級 (要経営者承認, 着手前に必ず escalate):
- **T-D-22** — R-T08 クライアント別 JWT 完全分離 RLS

---

## 守るべき絶対ルール (CLAUDE.md より)

1. 信頼源は `07_tasks/tickets.json` のみ
2. 静的 CLAUDE.md / audit MD を Git に commit しない (JIT 方式)
3. `./09_dispatch/scripts/validate.sh` PASS 維持
4. 1 ブランチ = 1 タスク
5. files_changed_predicted 以外を触らない
6. AI 学習デフォルト OFF を維持
7. R-T08 (クライアント別 JWT 完全分離) は致命級
8. `./scripts/begin-task.sh T-X-Y` を毎タスク必ず実行
9. selected-stack の確定済技術を必ず使う
10. AC 定量条件 (80%/0-error/100%) を絶対に下げない
11. files_changed_predicted を 1 文字も逸脱しない
12. 「あとで」「placeholder」「TODO」を gap tracker (`_TRACK:`) に登録
13. 「動けばいい」モード禁止

---

## 関連ファイル

- `docs/JIT-SKILL.md` — JIT skill 本体 (self-contained)
- `CLAUDE.md` — Atelier 作業ルール
- `07_tasks/tickets.json` — 信頼源
- `09_dispatch/scripts/validate.sh` — gate 13 種 validator
- `scripts/begin-task.sh` — タスク着手 atomic executor
- `scripts/verify_rls_isolation.py` — R-T08 runtime 検証
