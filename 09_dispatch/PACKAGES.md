# Atelier 実装パッケージ（v3.1-dual / 190 packages）

- 信頼源: [`dispatcher.json`](./dispatcher.json)
- Done 定義: [`done-criteria.json`](./done-criteria.json)
- 環境変数雛形: [`.env.template`](./.env.template)
- HTML 版（フィルタ + トグル）: [`PACKAGES.html`](./PACKAGES.html)
- 個別 CLAUDE.md: `packages/<TASK_ID>/CLAUDE.md`（sample 8 件、残りは `scripts/gen-package.sh` で生成）

## サマリ

| 指標 | Human | AI 並列 |
|---|---:|---:|
| パッケージ数 | 190 | 190 |
| 総工数 | 1328.0 h | – |
| AI compute | – | 123.7 h |
| Wall-clock 並列 | – | 27.9 h |
| 人間 review | – | 10.8 h |
| 営業日 | 240 日 | **15 日** |
| 短縮率 | baseline | **10.7×** |

## Wave dispatch 設計

| Wave | Phase | 並列度 | 開始 | 終了 | 実行 |
|---|---|---:|---|---|---|
| W0 | 1_foundation | 5 | 2026-05-20 | 2026-05-21 | parallel |
| W1 | 2_data | 8 | 2026-05-22 | 2026-05-25 | parallel |
| W2 | 3_api | 10 | 2026-05-26 | 2026-05-27 | parallel |
| W3 | 4_ui_foundation | 5 | 2026-05-28 | 2026-05-29 | parallel |
| W4 | 5_ui_parallel | 10 | 2026-06-01 | 2026-06-03 | parallel |
| W5 | 6_integration | 5 | 2026-06-04 | 2026-06-09 | sequential |

## CI gate 10 種（v3-gate.yml）

| # | gate | 閾値 | 所要 |
|---:|---|---|---:|
| 1 | lint | 0 error | 30s |
| 2 | 3-tier-ac-validator | all arrays non-empty | 10s |
| 3 | type-check | 0 error on touched | 60s |
| 4 | coverage | >=80% | 120s |
| 5 | endpoint-existence | 0 missing | 15s |
| 6 | mock-impl-diff | 0 diff | 30s |
| 7 | type-drift | 0 drift | 20s |
| 8 | schemathesis-contract | 0 violation | 90s |
| 9 | screen-api-coverage | 100% | 20s |
| 10 | rls-isolation-matrix | 0 cross | 60s |

## auto-merge ポリシー

- 必須 Tier: structural, functional, regression
- 必須 gate 数: **10 / 10**
- retry: 最大 3 回 / backoff [10, 30, 60]
- blocking task: require-human-approval
- critical gate: require-executive-approval
- escalation: S-E01-chat (#executive)

## ブランチ命名規則

```
<prefix>/<task_id_lower>-<slug>

prefixes: NEW→feat, REFACTOR→refactor, REUSE→feat, FIX→fix, ARCHIVE/cleanup→chore
```

## サンプル CLAUDE.md（8 件生成済）

| ID | 種別 | ブランチ |
|---|---|---|
| [T-F-07](./packages/T-F-07/CLAUDE.md) | ★ blocking | `feat/t-f-07-github-actions-ci-cd-v3-gate-yml-10-gate` |
| [T-F-27](./packages/T-F-27/CLAUDE.md) | ★ blocking | `feat/t-f-27-atelier-bridge--vibeyard-fork` |
| [T-D-22](./packages/T-D-22/CLAUDE.md) | R-T08 | `feat/t-d-22-jwt--rls-r-t08` |
| [T-A-18](./packages/T-A-18/CLAUDE.md) | 通常 | `feat/t-a-18-sse--f-ctx01` |
| [T-A-45](./packages/T-A-45/CLAUDE.md) | ★ blocking | `feat/t-a-45-openapi--ts--screen-api-coverage-100` |
| [T-UC-14](./packages/T-UC-14/CLAUDE.md) | 通常 | `feat/t-uc-14-s-i01--6` |
| [T-I-07](./packages/T-I-07/CLAUDE.md) | R-T08 | `feat/t-i-07-rls--clientportal--r-t08` |
| [T-I-24](./packages/T-I-24/CLAUDE.md) | 通常 | `feat/t-i-24-v3-gate-yml-10--pass` |

## 残り 182 パッケージの生成方法

```bash
# 任意のタスク 1 件
./scripts/gen-package.sh T-A-01

# 全件一括生成（Wave 着手時に Bridge 自動実行）
for id in $(jq -r '.packages[].id' dispatcher.json); do
  ./scripts/gen-package.sh $id
done
```

## 全 190 パッケージ一覧（Wave / 担当 / 二軸時間）

| ID | Branch | Wave | 担当 | Human h | AI h | Wall h | blocking |
|---|---|---:|---|---:|---:|---:|:---:|
| T-F-01 | `feat/t-f-01-pnpm-turborepo` | W0 | tony | 4 | 0.27 | 0.27 | – |
| T-F-02 | `feat/t-f-02-ts-python` | W0 | tony | 4 | 0.27 | 0.27 | – |
| T-F-03 | `feat/t-f-03-next-js-15-app-router` | W0 | tony | 6 | 0.4 | 0.4 | – |
| T-F-04 | `feat/t-f-04-fastapi` | W0 | tony | 6 | 0.4 | 0.4 | – |
| T-F-05 | `feat/t-f-05-supabase--tokyo-region` | W0 | strange | 4 | 0.27 | 0.27 | – |
| T-F-06 | `feat/t-f-06-vercel-fly-io` | W0 | tony | 6 | 0.4 | 0.4 | – |
| ★T-F-07 | `feat/t-f-07-github-actions-ci-cd-v3-gate-yml-10-gate` | W0 | tony | 14 | 0.93 | 1.43 | ★ |
| T-F-08 | `feat/t-f-08-sentry-langfuse-better-stack` | W0 | tony | 8 | 0.53 | 0.53 | – |
| T-F-09 | `feat/t-f-09-atelier` | W0 | wanda | 8 | 0.53 | 0.53 | – |
| T-F-10 | `feat/t-f-10-drizzle-orm` | W0 | tony | 6 | 0.4 | 0.4 | – |
| T-F-11 | `feat/t-f-11-asyncpg-sqlalchemy-2-0` | W0 | tony | 5 | 0.33 | 0.33 | – |
| T-F-12 | `feat/t-f-12-llmclient` | W0 | tony | 10 | 0.67 | 0.67 | – |
| T-F-13 | `feat/t-f-13-langgraph-inngest` | W0 | tony | 12 | 0.8 | 0.8 | – |
| T-F-14 | `feat/t-f-14-voyage-ai--pgvector` | W0 | tchalla | 10 | 0.67 | 0.67 | – |
| T-F-15 | `feat/t-f-15-prompt-caching-batch-api-llmlingua` | W0 | tony | 8 | 0.53 | 0.53 | – |
| T-F-16 | `feat/t-f-16-shadcn-ui-assistant-ui-tool-ui` | W0 | wanda | 10 | 0.67 | 0.67 | – |
| T-F-17 | `feat/t-f-17-resend-react-email` | W0 | tony | 5 | 0.33 | 0.33 | – |
| T-F-18 | `feat/t-f-18-task` | W0 | vision | 6 | 0.4 | 0.4 | – |
| T-F-19 | `feat/t-f-19-supabase-vault-byok` | W0 | strange | 6 | 0.4 | 0.4 | – |
| T-F-20 | `feat/t-f-20-inngest-cron` | W0 | tony | 6 | 0.4 | 0.4 | – |
| T-F-21 | `feat/t-f-21-anthropic-websearch` | W0 | tony | 4 | 0.27 | 0.27 | – |
| T-F-22 | `feat/t-f-22-mcp-server` | W0 | tony | 10 | 0.67 | 0.67 | – |
| T-F-23 | `feat/t-f-23-playwright-e2e` | W0 | vision | 8 | 0.8 | 0.8 | – |
| T-F-24 | `feat/t-f-24-vitest-pytest` | W0 | vision | 5 | 0.5 | 0.5 | – |
| ★T-F-25 | `feat/t-f-25-openapi--ts--pydantic` | W0 | tony | 8 | 0.53 | 1.03 | ★ |
| T-F-26 | `feat/t-f-26-schemathesis-contract-test` | W0 | vision | 6 | 0.6 | 0.6 | – |
| ★T-F-27 | `feat/t-f-27-atelier-bridge--vibeyard-fork` | W0 | tony | 16 | 3.2 | 4.2 | ★ |
| ★T-F-28 | `feat/t-f-28-hermes--kanbantools` | W0 | tony | 12 | 2.4 | 3.4 | ★ |
| T-D-01 | `feat/t-d-01-db--users-workspaces-workspacemembership` | W1 | strange | 6 | 0.5 | 0.5 | – |
| T-D-02 | `feat/t-d-02-db--projects-phases-workflowoutputs` | W1 | strange | 6 | 0.5 | 0.5 | – |
| T-D-03 | `feat/t-d-03-db--aiemployees-templates-skills` | W1 | strange | 5 | 0.42 | 0.42 | – |
| T-D-04 | `feat/t-d-04-db--chatthreads-chatmessages` | W1 | strange | 5 | 0.42 | 0.42 | – |
| T-D-05 | `feat/t-d-05-db--tasks-v3-1-hermes--10` | W1 | strange | 7 | 0.58 | 0.58 | – |
| T-D-06 | `feat/t-d-06-db--taskexecutions-acceptancecriteria` | W1 | strange | 5 | 0.42 | 0.42 | – |
| T-D-07 | `feat/t-d-07-db--mocks-comments` | W1 | strange | 4 | 0.33 | 0.33 | – |
| T-D-08 | `feat/t-d-08-db--clientinvitations` | W1 | strange | 4 | 0.33 | 0.33 | – |
| T-D-09 | `feat/t-d-09-db--knowledgenodes-pgvector` | W1 | strange | 6 | 0.5 | 0.5 | – |
| T-D-10 | `feat/t-d-10-db--approvalinbox` | W1 | strange | 5 | 0.42 | 0.42 | – |
| T-D-11 | `feat/t-d-11-db--auditlogs-consents-externaluploads` | W1 | strange | 5 | 0.42 | 0.42 | – |
| T-D-12 | `feat/t-d-12-db--mcptokens-byokapikeys` | W1 | strange | 5 | 0.42 | 0.42 | – |
| ★T-D-13 | `feat/t-d-13-db--cronschedules` | W1 | strange | 5 | 0.42 | 0.72 | ★ |
| T-D-14 | `feat/t-d-14-rls-users-workspacememberships-per-entit` | W1 | strange | 7 | 0.58 | 0.58 | – |
| T-D-15 | `feat/t-d-15-rls-workspaces-projects` | W1 | strange | 6 | 0.5 | 0.5 | – |
| T-D-16 | `feat/t-d-16-rls-tasks-executions-acceptancecriteria` | W1 | strange | 6 | 0.5 | 0.5 | – |
| T-D-17 | `feat/t-d-17-rls-chat-mocks-comments-approvalinbox` | W1 | strange | 6 | 0.5 | 0.5 | – |
| T-D-18 | `feat/t-d-18-rls-knowledgenodes-scope-per-entity` | W1 | strange | 5 | 0.42 | 0.42 | – |
| T-D-19 | `feat/t-d-19-rls-auditlogs-consents-externaluploads` | W1 | strange | 5 | 0.42 | 0.42 | – |
| T-D-20 | `feat/t-d-20-rls-mcptokens-byokapikeys-cron` | W1 | strange | 5 | 0.42 | 0.42 | – |
| T-D-21 | `feat/t-d-21-rls-aiemployees-templates-skills-phases` | W1 | strange | 6 | 0.5 | 0.5 | – |
| T-D-22 | `feat/t-d-22-jwt--rls-r-t08` | W1 | strange | 10 | 2.5 | 5.5 | – |
| T-D-23 | `feat/t-d-23-service-role-bypass-bridge-token` | W1 | strange | 6 | 0.5 | 0.5 | – |
| T-D-24 | `feat/t-d-24-ai--10--skill-templates` | W1 | strange | 4 | 0.33 | 0.33 | – |
| T-D-25 | `feat/t-d-25-terms-privacy` | W1 | strange | 3 | 0.25 | 0.25 | – |
| T-D-26 | `feat/t-d-26-drizzle` | W1 | strange | 4 | 0.33 | 0.33 | – |
| T-D-27 | `feat/t-d-27-sqlalchemy` | W1 | strange | 4 | 0.33 | 0.33 | – |
| T-D-28 | `feat/t-d-28-migration--rollback` | W1 | strange | 4 | 0.33 | 0.33 | – |
| T-D-29 | `feat/t-d-29-db-index` | W1 | strange | 6 | 0.5 | 0.5 | – |
| T-D-30 | `feat/t-d-30-db` | W1 | strange | 5 | 0.42 | 0.42 | – |
| T-D-31 | `feat/t-d-31-rls--workspace` | W1 | vision | 6 | 0.6 | 0.6 | – |
| T-D-32 | `feat/t-d-32-rls--project` | W1 | vision | 5 | 0.5 | 0.5 | – |
| T-D-33 | `feat/t-d-33-rls--clientportal-r-t08` | W1 | vision | 8 | 0.8 | 0.8 | – |
| T-D-34 | `feat/t-d-34-rls--bridge-token-scope` | W1 | vision | 5 | 0.5 | 0.5 | – |
| T-D-35 | `feat/t-d-35-rls--cron-vault-mcptokens` | W1 | vision | 4 | 0.4 | 0.4 | – |
| T-A-01 | `feat/t-a-01-api-signup--f-legal-004` | W2 | thor | 8 | 0.67 | 0.67 | – |
| T-A-02 | `feat/t-a-02-api-signin-5` | W2 | thor | 6 | 0.5 | 0.5 | – |
| T-A-03 | `feat/t-a-03-api-magic-link-oauth-google-github` | W2 | thor | 10 | 0.83 | 0.83 | – |
| T-A-04 | `feat/t-a-04-api--jwt-refresh` | W2 | thor | 6 | 0.5 | 0.5 | – |
| T-A-05 | `feat/t-a-05-api--30--f-legal-002` | W2 | thor | 8 | 0.67 | 0.67 | – |
| T-A-06 | `feat/t-a-06-crud` | W2 | thor | 6 | 0.5 | 0.5 | – |
| T-A-07 | `feat/t-a-07-ws` | W2 | thor | 8 | 0.67 | 0.67 | – |
| T-A-08 | `feat/t-a-08-mcp--api` | W2 | thor | 5 | 0.42 | 0.42 | – |
| T-A-09 | `feat/t-a-09-byok-api` | W2 | thor | 6 | 0.5 | 0.5 | – |
| T-A-10 | `feat/t-a-10-crud` | W2 | thor | 7 | 0.58 | 0.58 | – |
| T-A-11 | `feat/t-a-11-dashboard-activities-api` | W2 | thor | 6 | 0.5 | 0.5 | – |
| T-A-12 | `feat/t-a-12-30` | W2 | thor | 5 | 0.42 | 0.42 | – |
| T-A-13 | `feat/t-a-13-ai--off` | W2 | strange | 5 | 0.42 | 0.42 | – |
| T-A-14 | `feat/t-a-14-ai----api` | W2 | thor | 6 | 0.5 | 0.5 | – |
| T-A-15 | `feat/t-a-15-ai` | W2 | thor | 4 | 0.33 | 0.33 | – |
| T-A-16 | `feat/t-a-16-crud` | W2 | thor | 6 | 0.5 | 0.5 | – |
| T-A-17 | `feat/t-a-17-task` | W2 | thor | 6 | 0.5 | 0.5 | – |
| T-A-18 | `feat/t-a-18-sse--f-ctx01` | W2 | thor | 14 | 1.17 | 1.17 | – |
| T-A-19 | `feat/t-a-19-task` | W2 | thor | 5 | 0.42 | 0.42 | – |
| T-A-20 | `feat/t-a-20-task` | W2 | thor | 7 | 0.58 | 0.58 | – |
| T-A-21 | `feat/t-a-21-workflowoutputs` | W2 | thor | 5 | 0.42 | 0.42 | – |
| T-A-22 | `feat/t-a-22-api` | W2 | thor | 5 | 0.42 | 0.42 | – |
| T-A-23 | `feat/t-a-23-f-imp01--networkx` | W2 | strange | 10 | 0.83 | 0.83 | – |
| T-A-24 | `feat/t-a-24-api-dispatcher` | W2 | thor | 8 | 0.67 | 0.67 | – |
| T-A-25 | `feat/t-a-25-task` | W2 | thor | 8 | 0.67 | 0.67 | – |
| T-A-26 | `feat/t-a-26-crud` | W2 | thor | 6 | 0.5 | 0.5 | – |
| T-A-27 | `feat/t-a-27-task` | W2 | thor | 5 | 0.42 | 0.42 | – |
| T-A-28 | `feat/t-a-28-hermes--kanbantools-7` | W2 | tony | 14 | 1.17 | 1.17 | – |
| T-A-29 | `feat/t-a-29-pid` | W2 | tony | 8 | 0.67 | 0.67 | – |
| T-A-30 | `feat/t-a-30-api-bridge` | W2 | thor | 8 | 0.67 | 0.67 | – |
| T-A-31 | `feat/t-a-31-sse` | W2 | thor | 6 | 0.5 | 0.5 | – |
| T-A-32 | `feat/t-a-32-5--decide` | W2 | thor | 10 | 0.83 | 0.83 | – |
| T-A-33 | `feat/t-a-33-crud` | W2 | thor | 5 | 0.42 | 0.42 | – |
| T-A-34 | `feat/t-a-34-api` | W2 | thor | 6 | 0.5 | 0.5 | – |
| T-A-35 | `feat/t-a-35-jwt-signin-project-view-r-t08` | W2 | thor | 8 | 0.67 | 0.67 | – |
| T-A-36 | `feat/t-a-36-crud-voyage-semantic` | W2 | tchalla | 10 | 0.83 | 0.83 | – |
| T-A-37 | `feat/t-a-37-task` | W2 | tchalla | 7 | 0.58 | 0.58 | – |
| T-A-38 | `feat/t-a-38-whisper-transcription` | W2 | steve | 8 | 0.67 | 0.67 | – |
| T-A-39 | `feat/t-a-39-task` | W2 | steve | 6 | 0.5 | 0.5 | – |
| T-A-40 | `feat/t-a-40-cron--crud-inngest` | W2 | tony | 6 | 0.5 | 0.5 | – |
| T-A-41 | `feat/t-a-41-admin-dashboard-users` | W2 | thor | 6 | 0.5 | 0.5 | – |
| T-A-42 | `feat/t-a-42-admin--ai` | W2 | thor | 6 | 0.5 | 0.5 | – |
| T-A-43 | `feat/t-a-43-admin` | W2 | thor | 4 | 0.33 | 0.33 | – |
| T-A-44 | `feat/t-a-44-api--4` | W2 | thor | 5 | 0.42 | 0.42 | – |
| ★T-A-45 | `feat/t-a-45-openapi--ts--screen-api-coverage-100` | W2 | tony | 6 | 1.2 | 3.2 | ★ |
| T-US-01 | `feat/t-us-01-appshell---main` | W3 | wanda | 8 | 0.8 | 0.8 | – |
| T-US-02 | `feat/t-us-02-ws` | W3 | wanda | 6 | 0.6 | 0.6 | – |
| T-US-03 | `feat/t-us-03-jwt-cookie-refresh` | W3 | thor | 6 | 0.6 | 0.6 | – |
| ★T-US-04 | `feat/t-us-04-api--openapi-typescript` | W3 | tony | 6 | 0.6 | 1.1 | ★ |
| T-US-05 | `feat/t-us-05-tanstack-query` | W3 | wanda | 5 | 0.5 | 0.5 | – |
| T-US-06 | `feat/t-us-06-errorboundary-sentry` | W3 | wanda | 4 | 0.4 | 0.4 | – |
| T-US-07 | `feat/t-us-07-realtime` | W3 | wanda | 8 | 0.8 | 0.8 | – |
| T-US-08 | `feat/t-us-08-dialog-toast` | W3 | wanda | 5 | 0.5 | 0.5 | – |
| T-US-09 | `feat/t-us-09-ai` | W3 | wanda | 4 | 0.4 | 0.4 | – |
| T-US-10 | `feat/t-us-10-task` | W3 | wanda | 6 | 0.6 | 0.6 | – |
| T-US-11 | `feat/t-us-11-react-hook-form-zod` | W3 | wanda | 5 | 0.5 | 0.5 | – |
| T-US-12 | `feat/t-us-12-i18n--v1` | W3 | wanda | 4 | 0.4 | 0.4 | – |
| T-US-13 | `feat/t-us-13-a11y--wcag-2-2-aa` | W3 | wanda | 6 | 0.6 | 0.6 | – |
| T-US-14 | `feat/t-us-14-pdf` | W3 | wanda | 4 | 0.4 | 0.4 | – |
| T-US-15 | `feat/t-us-15-task` | W3 | wanda | 6 | 0.6 | 0.6 | – |
| T-US-16 | `feat/t-us-16-admin` | W3 | wanda | 6 | 0.6 | 0.6 | – |
| T-US-17 | `feat/t-us-17-task` | W3 | wanda | 3 | 0.3 | 0.3 | – |
| T-US-18 | `feat/t-us-18-tailwind` | W3 | wanda | 4 | 0.4 | 0.4 | – |
| T-UC-01 | `feat/t-uc-01-s-a01` | W4 | thor | 14 | 1.4 | 1.4 | – |
| T-UC-02 | `feat/t-uc-02-s-a03` | W4 | thor | 12 | 1.2 | 1.2 | – |
| T-UC-03 | `feat/t-uc-03-s-b01` | W4 | thor | 10 | 1.0 | 1.0 | – |
| T-UC-04 | `feat/t-uc-04-s-b02` | W4 | thor | 14 | 1.4 | 1.4 | – |
| T-UC-05 | `feat/t-uc-05-s-b03` | W4 | thor | 8 | 0.8 | 0.8 | – |
| T-UC-06 | `feat/t-uc-06-s-c01-ai` | W4 | wanda | 8 | 0.8 | 0.8 | – |
| T-UC-07 | `feat/t-uc-07-s-c02-ai` | W4 | wanda | 8 | 0.8 | 0.8 | – |
| T-UC-08 | `feat/t-uc-08-s-e01--assistant-ui-sse-tool-ui` | W4 | thor | 20 | 2.0 | 2.0 | – |
| T-UC-09 | `feat/t-uc-09-s-e01` | W4 | wanda | 6 | 0.6 | 0.6 | – |
| T-UC-10 | `feat/t-uc-10-s-f01` | W4 | thor | 14 | 1.4 | 1.4 | – |
| T-UC-11 | `feat/t-uc-11-s-f02` | W4 | thor | 8 | 0.8 | 0.8 | – |
| T-UC-12 | `feat/t-uc-12-s-g01` | W4 | thor | 12 | 1.2 | 1.2 | – |
| T-UC-13 | `feat/t-uc-13-s-h01` | W4 | thor | 8 | 0.8 | 0.8 | – |
| T-UC-14 | `feat/t-uc-14-s-i01--6` | W4 | thor | 18 | 1.8 | 1.8 | – |
| T-UC-15 | `feat/t-uc-15-s-i02--6` | W4 | thor | 14 | 1.4 | 1.4 | – |
| T-UC-16 | `feat/t-uc-16-s-i03---sse` | W4 | thor | 14 | 1.4 | 1.4 | – |
| T-UC-17 | `feat/t-uc-17-s-j01--5` | W4 | thor | 12 | 1.2 | 1.2 | – |
| T-UC-18 | `feat/t-uc-18-s-k01` | W4 | thor | 10 | 1.0 | 1.0 | – |
| T-UC-19 | `feat/t-uc-19-s-k02` | W4 | thor | 8 | 0.8 | 0.8 | – |
| T-UC-20 | `feat/t-uc-20-s-l01` | W4 | thor | 8 | 0.8 | 0.8 | – |
| T-UC-21 | `feat/t-uc-21-s-l02` | W4 | thor | 4 | 0.4 | 0.4 | – |
| T-UC-22 | `feat/t-uc-22-s-l03` | W4 | thor | 10 | 1.0 | 1.0 | – |
| T-UC-23 | `feat/t-uc-23-s-m01--transcript` | W4 | thor | 10 | 1.0 | 1.0 | – |
| T-UC-24 | `feat/t-uc-24-s-n01` | W4 | thor | 10 | 1.0 | 1.0 | – |
| T-UC-25 | `feat/t-uc-25-s-o01` | W4 | thor | 8 | 0.8 | 0.8 | – |
| T-UC-26 | `feat/t-uc-26-s-pub01` | W4 | thor | 4 | 0.4 | 0.4 | – |
| T-UC-27 | `feat/t-uc-27-s-pub02` | W4 | thor | 4 | 0.4 | 0.4 | – |
| T-UC-28 | `feat/t-uc-28-s-pub03` | W4 | thor | 4 | 0.4 | 0.4 | – |
| T-UC-29 | `feat/t-uc-29-s-pub04` | W4 | thor | 5 | 0.5 | 0.5 | – |
| T-UC-30 | `feat/t-uc-30-s-t01` | W4 | thor | 14 | 1.4 | 1.4 | – |
| T-UC-31 | `feat/t-uc-31-s-t02` | W4 | thor | 8 | 0.8 | 0.8 | – |
| T-UC-32 | `feat/t-uc-32-s-t03-ai` | W4 | thor | 8 | 0.8 | 0.8 | – |
| T-UC-33 | `feat/t-uc-33-s-t04` | W4 | thor | 8 | 0.8 | 0.8 | – |
| T-UC-34 | `feat/t-uc-34-s-t05` | W4 | thor | 8 | 0.8 | 0.8 | – |
| T-UC-35 | `feat/t-uc-35-task` | W4 | wanda | 8 | 0.8 | 0.8 | – |
| T-UC-36 | `feat/t-uc-36-task` | W4 | wanda | 6 | 0.6 | 0.6 | – |
| T-UC-37 | `feat/t-uc-37-task` | W4 | thor | 6 | 0.6 | 0.6 | – |
| T-UC-38 | `feat/t-uc-38-ws` | W4 | wanda | 5 | 0.5 | 0.5 | – |
| T-UC-39 | `feat/t-uc-39-task` | W4 | wanda | 6 | 0.6 | 0.6 | – |
| T-UC-40 | `feat/t-uc-40-task` | W4 | wanda | 6 | 0.6 | 0.6 | – |
| T-I-01 | `feat/t-i-01-e2e` | W5 | vision | 6 | 0.6 | 0.6 | – |
| T-I-02 | `feat/t-i-02-e2e` | W5 | vision | 8 | 0.8 | 0.8 | – |
| T-I-03 | `feat/t-i-03-e2e--f-ctx01` | W5 | vision | 6 | 0.6 | 0.6 | – |
| T-I-04 | `feat/t-i-04-e2e---30--hard-delete` | W5 | vision | 6 | 0.6 | 0.6 | – |
| T-I-05 | `feat/t-i-05-rls--workspace` | W5 | vision | 8 | 0.8 | 0.8 | – |
| T-I-06 | `feat/t-i-06-rls--project-bridge-token` | W5 | vision | 5 | 0.5 | 0.5 | – |
| T-I-07 | `feat/t-i-07-rls--clientportal--r-t08` | W5 | vision | 8 | 0.8 | 0.8 | – |
| T-I-08 | `feat/t-i-08-rls--servicerole-vault-cron` | W5 | vision | 4 | 0.4 | 0.4 | – |
| T-I-09 | `feat/t-i-09-lighthouse---33--cwv` | W5 | vision | 8 | 0.8 | 0.8 | – |
| T-I-10 | `feat/t-i-10-a11y-axe---33--aa` | W5 | vision | 6 | 0.6 | 0.6 | – |
| T-I-11 | `feat/t-i-11-bridge--macos-dmg-signednotarized` | W5 | tony | 8 | 0.53 | 0.53 | – |
| T-I-12 | `feat/t-i-12-bridge--linux-windows-npm-publish` | W5 | tony | 6 | 0.4 | 0.4 | – |
| T-I-13 | `feat/t-i-13-f-j02---5-10` | W5 | vision | 10 | 1.0 | 1.0 | – |
| T-I-14 | `feat/t-i-14-f-j02-retry` | W5 | vision | 6 | 0.6 | 0.6 | – |
| T-I-15 | `feat/t-i-15-10` | W5 | vision | 6 | 0.6 | 0.6 | – |
| T-I-16 | `feat/t-i-16-f-cuc01-04` | W5 | vision | 8 | 0.8 | 0.8 | – |
| T-I-17 | `feat/t-i-17-f-imp01--networkx` | W5 | vision | 6 | 0.6 | 0.6 | – |
| T-I-18 | `feat/t-i-18-f-ctx01` | W5 | vision | 6 | 0.6 | 0.6 | – |
| T-I-19 | `chore/t-i-19-dead-code-cleanup-knip-depcheck-ts-prune` | W5 | tony | 6 | 0.5 | 0.5 | – |
| T-I-20 | `feat/t-i-20-storybook---phase-5` | W5 | wanda | 8 | 0.53 | 0.53 | – |
| T-I-21 | `feat/t-i-21-ssl` | W5 | tony | 6 | 0.4 | 0.4 | – |
| T-I-22 | `feat/t-i-22-better-stack` | W5 | tony | 4 | 0.27 | 0.27 | – |
| T-I-23 | `feat/t-i-23-task` | W5 | tony | 4 | 0.27 | 0.27 | – |
| T-I-24 | `feat/t-i-24-v3-gate-yml-10--pass` | W5 | vision | 4 | 0.8 | 2.8 | – |