# Build-Factory Profile (例として位置づけ)

> このファイルは v3 distributed-dev skill を Build-Factory プロジェクトに適用するための profile 例。他プロジェクトは独自 profile (`references/profiles/<project>.md`) を作成する。
> SKILL.md / v3-core.md に登場するプレースホルダ (`<lint_runner>` / `<audit_dir>` / `<wave_mutex_check>` 等) を Build-Factory の具体値に解決する。

## script path (placeholder → 具体値)

| placeholder | Build-Factory 具体値 |
|---|---|
| `<lint_runner>` | `bash scripts/lint-mock.sh` |
| `<ac_validator>` | `python3 scripts/validate-tickets.py` |
| `<access_control_verifier>` | `python3 scripts/verify-rls-coverage.py` |
| `<audit_md_check>` | `bash scripts/audit-md-check.sh` |
| `<mock_impl_diff>` | `python3 scripts/lint-mock-impl-diff.py` |
| `<wave_mutex_check>` | `python3 scripts/check-wave-mutex.py` |
| `<work_package_boundary_check>` | `python3 scripts/check-work-package-boundary.py` |
| `<boundary_lint_rule>` | `lint #16 work-package-boundary` (within `scripts/lint-mock.sh`) |
| `<backend_test>` | `pytest` |
| `<backend_type_checker>` | `pyright` |
| `<frontend_type_checker>` | `tsc --noEmit` |

## phase 名 (汎用 → BF naming)

| 汎用 | Build-Factory naming |
|---|---|
| Foundation phase | Phase 0 |
| Backend phase | Phase 1 (dogfood) backend layer |
| UI phase | Phase 1 (dogfood) UI layer |
| Polish phase | Phase 1.5 (REFACTOR) / Phase 2 (SaaS 公開) |

## 並列数 / gate 数

| 汎用 | Build-Factory 値 |
|---|---|
| parallel_session_count_target | **30-50** (1 Wave あたりの Claude Code セッション数) |
| N CI gate | **8** (固定: lint-mock / AC validator / RLS coverage / audit MD / pytest cov ≥70% / pyright / tsc / mock-impl-diff) |
| coverage_threshold | **70%** (Phase 1 ゲート) |
| consecutive_failure_threshold (human エスカ) | **3** |

## 8 CI gate 詳細

| # | gate | tool |
|---|------|------|
| #1 | lint-mock | `bash scripts/lint-mock.sh` (19 check) |
| #2 | AC validator | `python3 scripts/validate-tickets.py` |
| #3 | RLS coverage | `python3 scripts/verify-rls-coverage.py` |
| #4 | audit MD existence | `bash scripts/audit-md-check.sh` |
| #5 | pytest cov ≥70% | `pytest --cov --cov-fail-under=70` |
| #6 | pyright strict | `pyright` |
| #7 | tsc strict | `tsc --noEmit` |
| #8 | mock-impl-diff | `python3 scripts/lint-mock-impl-diff.py` |

## lint rule 番号 (BF specific)

| rule_id | BF lint 番号 | 役割 |
|---|---|---|
| work-package-boundary | lint #16 | PR diff が editable + shared_no_concurrent_edit の subset 検証 / forbidden への変更 reject |
| mock-impl-diff | lint #17 | screen mock の h1 / kpi label / btn label と実装 component の diff |
| screens-API | lint #18 | mock 経由で参照される backend FastAPI router の実在性 |
| entity-table-naming | lint #19 | entities.json の table_name と migration / SQLAlchemy model の整合性 |

`scripts/lint-mock.sh` 内の番号体系。新規 lint 追加時はこのテーブルを更新。

## meta タグ schema

- `bf_meta` = mock HTML の `<meta name="screen-id|feature-id|task-ids|entities|phase">` 形式 (machine-readable)
- distributed-dev は CLAUDE.md `0. 上流出力` の `mock` path から `bf_meta` を読み、関連 task-ids / entities / phase を裏で参照可能

## branch 命名規則

- `<branch_prefix>` = `claude` (snake_case task_id が下に付く)
- 例: T-001-01 → `claude/t-001-01`

## branch-package.json schema (BF specific 拡張)

汎用管理 JSON に加え、Build-Factory では以下を保持:

```json
{
  "version": "v3",
  "task_id": "T-XXX-YY",
  "branch_name": "claude/t-xxx-yy",
  "base_branch": "main",
  "wave_id": "W<N>",
  "depends_on_waves": ["W<N-1>"],
  "parallel_session_count_target": 40,
  "group": "B",
  "layer": "backend",
  "work_package_boundary": {
    "editable": [],
    "shared_no_concurrent_edit": [],
    "readonly": [],
    "forbidden": []
  },
  "upstream_paths": {
    "task": "docs/task-decomposition/<date>_v<N>/tickets.json",
    "mock": "docs/mocks/<date>_v<N>/<screen_id>.html",
    "api": "docs/api-design/<date>_v<N>/openapi.yaml",
    "ears_ac_seed": "docs/api-design/<date>_v<N>/ears-ac-seed.json",
    "entities": "docs/functional-breakdown/<date>_v<N>/entities.json",
    "wave": "docs/schedule-design/<date>_v<N>/wave-schedule.json",
    "pre_flight_audit": "docs/audit/<date>_v3/<task_id>.md"
  },
  "done_criteria_3tier": {
    "tier1_structural": ["lint #17 mock-impl-diff 0 件"],
    "tier2_functional": ["EARS AC 全件 pass", "RLS 4×7 matrix pass", "Schemathesis pass"],
    "tier3_regression": ["pytest cov ≥70%", "pyright 0 error", "tsc 0 error", "lint #1-19 全 pass", "audit MD commit"]
  },
  "ci_gates": ["lint-mock", "AC-validator", "RLS-coverage", "audit-md", "pytest-cov-70", "pyright", "tsc", "mock-impl-diff"],
  "auto_merge": true,
  "consecutive_failure_threshold": 3,
  "status": "ready",
  "next_skill": "integration"
}
```

## technology stack (例示用)

- access control: Supabase RLS (4 ロール: owner / admin / member / guest × 7 操作: SELECT own/others, INSERT, UPDATE own/others, DELETE own/others = 28 マトリクス)
- vector DB: pgvector
- AI stack: 3-layer (claude-agent-sdk / anthropic-python / LiteLLM)
- hosting: Vercel + Oracle Cloud + Supabase
- CI runner: GitHub Actions

## 数値例

- screens: 43
- tasks: 187 (全 Wave 完了時)
- backend tests: 8000+

## audit MD path

- `<audit_dir>` = `docs/audit/<date>_v3/`
- template: `docs/audit/<date>_v3/_template.md`
- 各 task: `docs/audit/<date>_v3/<task_id>.md`
- 例: `docs/audit/2026-05-13_v3/T-001-01.md`

## upstream output path (BF dogfood の実値)

| path | 実値 (例) |
|---|---|
| `<task_dir>` | `docs/task-decomposition/2026-05-09_v1/` |
| `<api_dir>` | `docs/api-design/<date>_v<N>/` |
| `<fb_dir>` | `docs/functional-breakdown/2026-05-09_v1/` |
| `<schedule_dir>` | `docs/schedule-design/<date>_v<N>/` |
| `<test_dir>` | `docs/test-verification/<date>_v<N>/` |
| `<mock_dir>` | `docs/mocks/2026-05-09_v1/` |

## CLAUDE.md の Phase 別秘匿レベル

- **Phase 1 (内製 dogfood)**: 秘匿緩和 (BF プロジェクト名 / ENGINE BASE 言及 OK)
- **Phase 2 (SaaS 公開)**: クライアント名・企業固有名詞・ビジネスロジック秘匿。コードコメント / 変数名 / ログに固有名詞を入れない

## design token

- 主色: ENGINE BASE green `#1a6648` (Tailwind 上は `eb-500`)
- icon: Lucide Icons のみ (絵文字禁止)
- font: Noto Sans JP + JetBrains Mono

## 固有名詞

- project name: Build-Factory
- company: ENGINE BASE
- responsible person: 高本まさと

## 適用方法

distributed-dev skill 起動時に「Build-Factory profile (references/profiles/build-factory.md) を適用」と明示すれば、SKILL.md / v3-core.md のプレースホルダがすべて上記具体値に解決される。
