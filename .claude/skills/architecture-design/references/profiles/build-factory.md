# Build-Factory Profile (例として位置づけ)

> このファイルは architecture-design v3 skill を Build-Factory プロジェクトに適用するための profile **例**。他プロジェクトは独自 profile (`references/profiles/<project>.md`) を作成する。

## プロジェクト概要

- project name: **Build-Factory**
- company: 株式会社 ENGINE BASE
- responsible person: 高本まさと
- 性質: SaaS 型「開発工場 OS」(ヒアリング → 要件定義 → アーキ → 機能分解 → タスク → 実装 → テスト → 進捗 → 納品 を 1 つの Web アプリで完結)
- 1 人で 10 案件を並列運用、実行者は AI 社員 (BMAD 10 ペルソナ)

## script path (汎用 placeholder の具体化)

| placeholder | Build-Factory 実体 |
|---|---|
| `<lint_runner>` | `bash scripts/lint-mock.sh` |
| `<ac_validator>` | `python3 scripts/validate-tickets.py` (旧 `validate-ears-ac.py`) |
| `<access_control_verifier>` | `python3 scripts/verify-rls-coverage.py` |
| `<audit_md_check>` | `python3 scripts/validate-audit-md.py` |
| `<mock_impl_diff>` | `bash scripts/lint-mock-impl-diff.sh` |
| `<backend_type_checker>` | `pyright --strict` |
| `<frontend_type_checker>` | `tsc --noEmit` |
| `<frontend_lint>` | `pnpm run lint` |
| `<test_runner with coverage gate>` | `pytest --cov --cov-fail-under=70` |

## phase 名 (汎用 → BF 固有)

| 汎用名 | Build-Factory 実体 |
|---|---|
| Foundation phase | Phase 0 |
| Backend phase | Phase 1 (dogfood) 前半 |
| UI phase | Phase 1 (dogfood) 後半 |
| Polish phase | Phase 1.5 (REFACTOR) / Phase 2 (SaaS 公開) |

## 並列数 / CI gate 数

- N parallel sessions (capacity = **large**) = 30-50
- N CI gates = **8** (lint #1-19 / 3-tier AC validator / RLS coverage / audit MD validator / pytest cov 70% / pyright strict / tsc + ESLint / mock-impl-diff)
- 失敗 retry: **3 回連続失敗で human エスカレーション (PM 確認)**

## lint rule 番号 mapping (BF lint-mock.sh 内番号)

| 汎用 rule_id | BF lint 番号 |
|---|---|
| `mock-impl-diff` | lint #17 |
| `screens-API` | lint #18 |
| `entity-table-naming` | lint #19 |
| 絵文字検出 | lint #1 |
| AGPL 検出 | lint #2 |
| ARCHIVE 残留 | lint #3 |
| tickets.json メタ | lint #4 |
| secrets | lint #5 |
| langgraph in runner | lint #6 |
| litellm in runner | lint #7 |
| domain boundaries | lint #8 |
| self-provider-routing | lint #9 |
| self-tool-trim | lint #10 |
| template-skeleton | lint #11 |
| self-constitution-inject | lint #12 |

## meta タグ schema

- machine-readable meta = `<meta name="screen-id|feature-id|task-ids|entities|phase">`
- 全 43 mock に埋め込み済 (`docs/mocks/2026-05-09_v1/`)

## technology stack

### Frontend
- **Next.js 15** (App Router) + **shadcn/ui** + **Tailwind CSS 4**
- **Lucide Icons** (アイコン唯一の選択肢、絵文字禁止)
- **Recharts** (チャート) / **React Flow** (DAG / Swarm) / **Zustand** (state) / **TanStack Query** (data)
- **GrapesJS core (BSD-3)** = HTML エディタ (Phase 1.5)

### Backend
- **FastAPI** モジュラーモノリス (40+ routers + 50+ services) + Python 3.13 + **uv** + **ruff** + **pyright (strict)**
- **SQLAlchemy 2.0 async** + Pydantic

### DB / Auth (access control framework = **RLS**)
- **Supabase Postgres** + **RLS** + **pgvector** + **pg_trgm** + **pgsodium**
- **pg_cron** + **pg_partman** (Phase 2)
- **Supabase Auth** (GoTrue) + 2FA (TOTP) + OAuth (Anthropic / Slack / GitHub)

### AI Stack (3 層 — ADR-010 / 2026-05-10)
```
Layer 3: claude-agent-sdk + Subagent (Anthropic 公式) ← 中核
Layer 2a (メイン): anthropic-python ← Claude 専用、最高精度
Layer 2b (サブ): LiteLLM ← マルチプロバイダ柔軟性 (縮退)
Layer 1: PostgreSQL + Mem0 + Obsidian + Constitution
```
**禁則**: メイン経路 (claude-runner) で LangGraph / LangChain / LiteLLM を使ってはならない (lint で fail)。

### Hosting (Phase 1 = ¥0/月)
- **Vercel Hobby** (Frontend) — 自動 HTTPS / プレビュー環境
- **Oracle Cloud Free Tier** (Backend、4 vCPU + 24GB RAM 永久無料)
- **Supabase Free** (DB / Auth / Storage)
- **Sentry / Better Stack / GitHub Actions** = Free tier
- **Cloudflare Tunnel** = Backend を Vercel から呼ぶ
- 月額: ¥125 (ドメインのみ)

### Sandbox (OS レベル)
- macOS: **Seatbelt** / Linux: **Landlock + seccomp** (Codex CLI 流)

## 7-layer architecture model (BF 固有)

BF の 7 層 architecture は v3 の Foundation/Backend/UI/Polish に以下のように対応:

| BF Layer | v3 phase | 内容 |
|---|---|---|
| 1. Edge / CDN / Cloudflare Tunnel | Foundation | エントリ |
| 2. Frontend (Next.js + Vercel) | UI | SPA / SSR |
| 3. API (FastAPI router) | Backend | REST endpoint |
| 4. Service (business logic) | Backend | domain service |
| 5. Data (SQLAlchemy / RLS) | Backend / Foundation (RLS framework) | data + access control |
| 6. AI runtime (claude-agent-sdk) | Backend | AI 実行層 |
| 7. Infra (Oracle Cloud + Supabase) | Foundation | hosting |

## 数値例

- screens: **43** (mock 完成)
- features: **30**
- roles: **6**
- entities: **43**
- tasks (v1): **187 (100% done)** / (v2 縦スライス再分解): **113**
- backend tests: **8000 pass / 10 skip / 0 fail**
- audit MD: **146+ 件**
- ADR: **12 件 (ADR-002 superseded / ADR-010 AI スタック / ADR-011 完了判定 / ADR-012 Memory Tool)**

## RLS strategy (BF 実装)

```json
{
  "access_control": {
    "framework": "RLS",
    "default_enable": true,
    "auth_provider": "Supabase Auth (GoTrue)",
    "tenant_isolation_pattern": "account_scoped + workspace_scoped (2 階層)",
    "policy_naming_convention": "<table>_<actor>_<operation>",
    "predicates_lib": {
      "self_only": "auth.uid() = id",
      "owner_only": "auth.uid() = user_id",
      "account_member": "EXISTS (SELECT 1 FROM account_members WHERE account_id = ${table}.account_id AND user_id = auth.uid())",
      "workspace_member": "EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ${table}.workspace_id AND user_id = auth.uid())"
    },
    "service_role_bypass": true
  },
  "table_naming": {
    "entity_case": "PascalCase",
    "table_case": "snake_case_plural",
    "forbidden_prefixes": ["bf_", "tmp_", "old_"],
    "reserved_words_strategy": "use_singular_when_conflict"
  }
}
```

## Phase 0 必須 ADR (BF)

| ADR | title | 決定済 |
|---|---|---|
| ADR-013 | AUTH 戦略 (Supabase Auth + JWT + 2FA) | T-V3-INFRA-01 |
| ADR-014 | 命名規約 (PascalCase entity → snake_case table / `bf_` prefix 廃止) | T-V3-INFRA-01 |
| ADR-015 | root画面方針 (account dashboard / dogfood vs SaaS) | T-V3-INFRA-01 |

## 固有名詞

- project name: **Build-Factory**
- company: **株式会社 ENGINE BASE**
- responsible person: **高本まさと (masato@engine-base.com)**

## design token

- primary color: ENGINE BASE green `#1a6648` (Tailwind 上は `eb-500`)
- icon library: **Lucide Icons** (絵文字禁止 — `design-tokens.md` §8)
- font: **Noto Sans JP** + **JetBrains Mono**
- 規約: [`docs/mocks/2026-05-09_v1/design-tokens.md`](../../../../docs/mocks/2026-05-09_v1/design-tokens.md)

## monorepo 構造 (BF 実装)

```
~/Documents/Build-Factory/
├── frontend/             # Next.js 15 (App Router)
│   ├── app/<screen>/
│   └── components/
├── backend/              # FastAPI モジュラーモノリス
│   ├── routers/
│   ├── services/
│   └── tests/
├── data/                 # Supabase migrations (8 件)
├── docs/                 # spec / mock / audit (146+ MD)
├── scripts/              # lint-mock.sh / validate-tickets.py 等
├── templates/            # 各案件に展開する強制レイヤー (M-31)
└── .github/workflows/v3-gate.yml
```

monorepo tool: pnpm workspaces (frontend/) + uv (backend/) — ハイブリッド。

## git 戦略 (BF 実装)

```yaml
git_strategy:
  workflow: "trunk-based + worktree"
  branch_naming: "claude/<task_id>"  # 例: claude/T-V3-AUTH-01
  worktree_pattern: "$REPO_ROOT/../worktrees/<task_id>"
  merge_method: "squash + auto-merge (CI 全 8 gate pass 時)"
  conflict_resolution: "task-decomposition の files_changed で事前回避"
  parallel_session_limit: "30-50 (Claude Code on web プラン依存)"
```

## 連携ファイル (BF)

- `CLAUDE.md` — セッション引き継ぎ書 (新セッション自動読み込み)
- `docs/HANDOVER.md` — 全フェーズ成果物の統合インデックス
- `docs/decisions/` — 12 ADR
- `docs/architecture/2026-05-09_v1/` — v1 architecture 仕様 (freeze)
- `docs/audit/2026-05-13_v2/` — pre-flight audit MD (146+ 件)
- `docs/task-decomposition/2026-05-14_v2/` — 113 task v2 縦スライス
- `templates/project-bootstrap/` — 各案件展開テンプレ (M-31 / ADR-009)
