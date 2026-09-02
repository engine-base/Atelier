# v3 Core Concepts — architecture-design

> 2026-05-15 v3 から、architecture-design に **Foundation phase gate / Access control framework / Vertical Slice 適合性 / project-defined parallel capacity / ADR 起票連携** を採用。
> アーキテクチャ判断の一部として CI gate と並列開発インフラを定義することで、後段の機能分解 / タスク分解 / 実装 / 監査が漏れなく回る土台を作る。

> このファイルは汎用 v3 概念のみを定義する。プロジェクト固有値の適用例は `profiles/build-factory.md` 等を参照。

## なぜ v3 拡張が必要か

v1 / v2 では:
- アーキテクチャが「技術スタック」「DB 構造」「セキュリティ」までで止まり、CI gate (lint / validator) が後付けになり Foundation 整備前に着手 → 漏れ発生
- Access control が「multi-tenant」「tenant_id カラム」レベルで止まり、entity 単位の policy が描けず実装で乖離
- 並列開発対応が暗黙 (worktree / monorepo 戦略未定義) で複数セッションが衝突
- ADR が散発的に起票され、Foundation phase で起票すべき ADR (auth 戦略 / 命名規約) が漏れる

v3 では:
- **Foundation phase gate** をアーキテクチャの一部として明示
- Access control を **per-entity policy** (operation / role / predicate) で設計、framework は project requirements に応じて選択
- **Vertical Slice 適合性** (1 機能 = 画面+API+test+access policy の 1 PR) を STEP 2 で検証
- **Project-defined parallel capacity** (small/medium/large/massive) を STEP 4 で必須項目化
- **ADR 起票プロトコル** を Foundation phase task 群として定義

---

## Foundation → Backend → UI → Polish 汎用フロー

7-layer architecture model はこの 4 phase に対応付けられる:

```
Foundation phase
  ├─ CI/CD pipeline (lint / format / type check / coverage gate)
  ├─ Test infrastructure (backend / frontend / e2e)
  ├─ Access control framework (RLS / RBAC / ACL / policy-based, project-defined)
  ├─ Audit / logging infrastructure
  └─ Pre-flight checklist mechanism

   ↓ Foundation gate passes

Backend phase (per Vertical Slice)
  ├─ Data layer (entity / migration / access policy)
  ├─ Service layer (business logic)
  ├─ API layer (REST / GraphQL / gRPC) + IDL
  ├─ Contract test
  └─ Backend integration test

   ↓ Backend gate passes

UI phase (per Vertical Slice)
  ├─ Component implementation (against spec / mock)
  ├─ State management (data fetching / cache)
  ├─ UI integration test
  └─ Accessibility check

   ↓ UI gate passes

Polish phase (cross-cutting)
  ├─ Performance optimization
  ├─ Security audit
  ├─ Documentation
  └─ Release readiness
```

---

## Foundation phase gate 要件

アーキテクチャ確定時に、N ゲート (project-defined) を **必ず CI に組み込む** ことを保証する:

| # | Gate | script (placeholder) | 検出する漏れ |
|---|---|---|---|
| 1 | mock lint | `<lint_runner>` | 絵文字 / license violation / mock-impl diff / screens-API / entity-table naming 等 |
| 2 | 3-tier AC validator | `<ac_validator>` docs/.../tickets.json | AC が 3-tier 分割なし / EARS 違反 |
| 3 | audit MD validator | `<audit_md_check>` docs/.../<task_id>.md | audit MD 不在 / generic 文言 / impl 行範囲未記入 |
| 4 | access control coverage | `<access_control_verifier>` | entities.json の entity に対する access policy 不在 |
| 5 | unit test + coverage | `<test_runner with coverage gate>` | unit test 失敗 / カバレッジ < threshold |
| 6 | backend type check | `<backend_type_checker>` | backend 型エラー |
| 7 | frontend type check + lint | `<frontend_type_checker> && <frontend_lint>` | TS 型エラー / lint 違反 |
| 8 | mock-impl diff | `<mock_impl_diff> ${SCREEN_IDS}` | mock h1 / KPI / section-h2 と impl の不一致 |

> Gate 数・script 名は project-defined。最低限 (1) lint, (2) AC validator, (5) test+coverage, (6/7) type checker は推奨。

これらは architecture-design の出力 `foundation_gates.json` に展開される。

### foundation_gates.json schema

```json
{
  "version": "v3",
  "created_at": "YYYY-MM-DD",
  "merge_gates": [
    {
      "id": 1,
      "name": "mock lint",
      "script": "<lint_runner>",
      "blocking": true,
      "owner_task": "T-V3-INFRA-02",
      "detects": [],
      "depends_on": []
    }
  ],
  "ci_workflow_path": ".github/workflows/v3-gate.yml",
  "retry_protocol": {
    "max_attempts": 3,
    "on_failure": "human_escalation",
    "escalation_to": "PM"
  }
}
```

### v3-gate.yml (GitHub Actions テンプレ)

```yaml
# .github/workflows/v3-gate.yml
name: v3 merge gate

on:
  pull_request:
    branches: [main]

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup runtimes
        run: |
          # backend / frontend runtime セットアップ (project-defined)
          echo "setup runtime placeholder"

      - name: Install deps
        run: |
          # 例: uv sync && cd frontend && pnpm install --frozen-lockfile
          echo "install deps placeholder"

      - name: Gate 1 — mock lint
        run: <lint_runner>

      - name: Gate 2 — 3-tier AC validator
        run: <ac_validator> docs/task-decomposition/<date>_v3/tickets.json

      - name: Gate 3 — audit MD validator
        run: |
          for f in docs/audit/<date>_v3/T-V3-*.md; do
            <audit_md_check> "$f"
          done

      - name: Gate 4 — access control coverage
        run: <access_control_verifier>

      - name: Gate 5 — unit test + coverage
        run: <test_runner with coverage gate>

      - name: Gate 6 — backend type check
        run: <backend_type_checker>

      - name: Gate 7 — frontend type check + lint
        run: cd frontend && <frontend_type_checker> && <frontend_lint>

      - name: Gate 8 — mock-impl diff
        if: contains(github.event.pull_request.labels.*.name, 'has-frontend')
        run: <mock_impl_diff> ${SCREEN_IDS}
```

---

## Access control framework (v3 必須)

STEP 3 で entities.json の各 entity に対する access policy 戦略を決める。

framework は project requirements に応じて選択:
- **RLS (Row-Level Security)**: PostgreSQL native / Supabase 等で広く採用、DB レイヤで強制
- **RBAC (Role-Based Access Control)**: アプリレイヤで role → permission マッピング
- **ACL (Access Control List)**: object 単位の許可リスト
- **Policy-based (ABAC, OPA 等)**: 属性 + ポリシー言語で表現

### 設計テンプレ (per-entity)

```json
{
  "access_control": {
    "framework": "RLS | RBAC | ACL | policy-based",
    "default_enable": true,
    "auth_provider": "<chosen>",
    "tenant_isolation_pattern": "account_scoped | workspace_scoped | user_scoped | none",
    "policy_naming_convention": "<table>_<actor>_<operation>",
    "predicates_lib": {
      "self_only": "<predicate, e.g. auth.uid() = id>",
      "owner_only": "<predicate, e.g. auth.uid() = user_id>",
      "tenant_member": "<predicate, e.g. EXISTS (...)>"
    },
    "service_role_bypass": true
  },
  "table_naming": {
    "entity_case": "PascalCase",
    "table_case": "snake_case_plural",
    "forbidden_prefixes": [],
    "reserved_words_strategy": "use_singular_when_conflict"
  }
}
```

### entity 単位の policy 配列 (entities.json から pull)

```json
{
  "id": "E-001",
  "name": "User",
  "table_name": "users",
  "access_policies": [
    {"name": "users_self_select", "operation": "SELECT", "role": "authenticated", "predicate": "<predicate>"},
    {"name": "users_self_update", "operation": "UPDATE", "role": "authenticated", "predicate": "<predicate>"},
    {"name": "users_admin_all", "operation": "ALL", "role": "service_role", "predicate": "true"}
  ]
}
```

### entity-table-naming lint で検証する項目

- entity name が project-defined case (例: PascalCase)
- table name が project-defined case (例: snake_case_plural)
- forbidden_prefixes に該当しない (project-defined)
- 予約語衝突時は singular 使用 (project-defined)

---

## Vertical Slice 適合性 (STEP 2 必須検証)

アーキテクチャが「1 機能 = 画面+API+test+access policy を 1 PR で完結する」を支えられるかを検証:

| 検証項目 | OK の条件 |
|---|---|
| ディレクトリ構造 | frontend/<screen>/ + backend/<resource>/ + tests/<task_id>/ + migrations/<entity>/ が同 PR で扱える |
| ビルドツール | monorepo 構造で frontend/backend 同 commit でビルド可能 |
| 型同期 | API スキーマから client 型を自動生成 (例: OpenAPI → openapi-typescript) |
| Migration 連携 | DB migrations が同 PR に含まれる場合、CI で適用順序保証 |
| test 一括実行 | 1 PR で backend + frontend + e2e が並列実行可能 |

NG パターン:
- frontend / backend が別リポ → Vertical Slice が 2 PR に分割 → AC 整合困難
- 型生成が手動 → spec ↔ impl drift の温床
- Migration がアプリ起動後に手動 → CI gate で検知できない

---

## Project-defined parallel capacity 対応 (STEP 4 必須項目)

並列セッションを支える設計。capacity は project-defined:

| capacity 段階 | 並列数の目安 |
|---|---|
| small | 1-5 |
| medium | 10-30 |
| large | 30-100 |
| massive | 100+ |

### git 戦略

```yaml
git_strategy:
  workflow: "trunk-based + worktree"
  branch_naming: "<agent>/<task_id>"  # 例: claude/T-123
  worktree_pattern: "$REPO_ROOT/../worktrees/<task_id>"
  merge_method: "squash + auto-merge (CI 全 gate pass 時)"
  conflict_resolution: "task-decomposition の files_changed で事前衝突回避"
  parallel_session_capacity: "small | medium | large | massive (project-defined)"
```

### monorepo 構造 (汎用例)

```
<project_root>/
├── frontend/             # SPA / SSR framework
│   ├── <screen_root>/
│   └── components/
├── backend/              # API server
│   ├── <resource_root>/
│   ├── services/
│   └── tests/
├── <db_migrations>/      # DB migration ディレクトリ
├── docs/                 # spec / mock / audit
├── scripts/              # lint / validator
└── .github/workflows/v3-gate.yml
```

ツール候補:
- **pnpm workspaces** (Node 系のみで十分な場合 / lightweight)
- **Turborepo** (build cache / 並列 task 実行が必要なら)
- **Nx** (TS + 他言語混在で deep dependency graph 必要なら)

### 衝突回避プロトコル

1. task-decomposition で各 task の `files_changed` を明示
2. 同じファイルを修正する task を別 wave に配置 (DAG で順序保証)
3. それでも衝突したら squash 後に手動 rebase (max 1 round)

---

## ADR 起票プロトコル (v3)

architecture-design は STEP 5 で `adrs-to-create.json` を出力し、Foundation phase で起票すべき ADR を列挙する。

### adrs-to-create.json schema

```json
{
  "version": "v3",
  "foundation_phase_required_adrs": [
    {
      "id": "ADR-XXX",
      "title": "AUTH 戦略 (<chosen>)",
      "category": "authentication",
      "supersedes": [],
      "task_id": "T-V3-INFRA-01",
      "rationale": "...",
      "alternatives_considered": []
    },
    {
      "id": "ADR-YYY",
      "title": "命名規約 (entity case → table case / forbidden prefixes)",
      "category": "naming",
      "supersedes": [],
      "task_id": "T-V3-INFRA-01",
      "rationale": "...",
      "alternatives_considered": []
    },
    {
      "id": "ADR-ZZZ",
      "title": "root画面方針",
      "category": "ui",
      "supersedes": [],
      "task_id": "T-V3-INFRA-01",
      "rationale": "...",
      "alternatives_considered": []
    }
  ],
  "decision_record_skill_handoff": "decision-record スキルへ各 ADR の起票を委譲する"
}
```

連携: 各 ADR は **decision-record** スキルを起動して `docs/decisions/ADR-XXX.md` を生成する。

---

## STEP 4.5-D 拡張: CI/Lint ツール + monorepo

v3 では 4.5-D 開発環境ツール選定に **CI/Lint** と **monorepo tool** を追加:

| サブカテゴリ | 候補例 |
|---|---|
| Linter (backend) | ruff / Black + isort / Pylint / 等 |
| Linter (frontend) | ESLint + Prettier / Biome (高速) |
| Type checker (backend) | pyright (strict) / mypy / 等 |
| Type checker (frontend) | tsc strict |
| Test runner (backend) | pytest + pytest-cov / pytest-asyncio / 等 |
| Test runner (frontend) | Vitest / Jest |
| E2E | Playwright / Cypress |
| coverage tool | pytest-cov / vitest c8 / nyc |
| **monorepo tool (v3 新規)** | **pnpm workspaces / Turborepo / Nx / Lerna (legacy)** |
| **shellcheck (v3 新規)** | shellcheck (lint shell scripts) |

選定後、各ツールが Foundation phase ゲートに組み込まれる。

---

## 入力 (上流 skill から pull する内容)

| 上流 skill | 入力 |
|---|---|
| **requirements** | プロジェクト概要 / 制約 / 優先事項 |
| **functional-breakdown** | screens.json / features.json / roles.json / entities.json (4 JSON) |
| **tech-stack** | selected-stack.json (技術スタック合意済) |

## 出力 (下流 skill に渡す内容)

| 下流 skill | このスキルが供給する情報 |
|---|---|
| **functional-breakdown** | tech_stack (DB type / Auth provider) → entities.json の access policy の predicate ライブラリ選択 |
| **feature-decomposition** | foundation_gates.json → Group A の機能 (lint / AC validator / type checker / coverage gate / ADR 起票) を生成 |
| **task-decomposition** | foundation_gates.json + adrs-to-create.json → Group A の T-V3-INFRA-XX タスクを生成 |
| **distributed-dev** | git_strategy + monorepo 構造 → 並列セッションの worktree / branch 命名 |
| **integration** | merge gate 数 + retry プロトコル → 統合フェーズの基準 |
| **decision-record** | adrs-to-create.json → 各 ADR の起票委譲 |

---

## 互換性

- v1: freeze。基本構造は維持 (legacy 参照のみ)
- v3: 新規出力先。Foundation gate / Access control framework / project-defined parallel capacity 込み
- 既存 ADR: v3 で参照のみ、新規 ADR (auth / 命名 / root screen) が Foundation phase 必須
