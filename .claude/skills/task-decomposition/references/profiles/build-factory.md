# Build-Factory Profile (例として位置づけ)

> このファイルは task-decomposition skill を Build-Factory プロジェクトに適用するための **profile 例**。他プロジェクトは独自 profile (`references/profiles/<project>.md`) を作成する。
> SKILL.md / references/v3-core.md は完全汎用化されており、profile を呼び出さなければ project-agnostic なまま動く。

---

## script path

| 汎用名 | Build-Factory での実体 |
|---|---|
| `<lint_runner>` | `scripts/lint-mock.sh` |
| `<ac_validator>` | `scripts/validate-tickets.py` / `scripts/validate-ears-ac.py` |
| `<audit_md_validator>` | `scripts/validate-audit-md.py` |
| `<access_control_verifier>` | `scripts/verify-rls-coverage.py` |
| `<audit_md_check>` | `scripts/audit-md-check.sh` |
| `<mock_impl_diff>` | `scripts/lint-mock-impl-diff.sh` (lint #17) |
| `<screens_api_check>` | lint #18 in `scripts/lint-mock.sh` |
| `<test_runner>` (backend) | `pytest --cov --cov-fail-under=70` |
| `<test_runner>` (frontend) | `vitest --coverage` / `playwright test` |
| `<type_checker>` (backend) | `pyright --strict` |
| `<type_checker>` (frontend) | `tsc --noEmit` |

---

## phase 名 mapping

| 汎用 | Build-Factory |
|---|---|
| Foundation phase | Phase 0 |
| Backend phase | Phase 1 (dogfood) — backend 部分 |
| UI phase | Phase 1 (dogfood) — frontend 部分 |
| Polish phase | Phase 1.5 (REFACTOR) / Phase 2 (SaaS 公開) |

---

## 並列数 / CI gate 数

| 汎用 | Build-Factory 値 |
|---|---|
| `N parallel sessions` (project-defined parallel capacity) | **30-50 parallel Claude Code sessions** |
| `N CI gates` (project-defined gate set) | **8 CI gates** |
| 1 Wave 所要時間 | 2-4h |
| retry 回数閾値 | 3 回連続失敗 → human エスカレーション |

---

## CI gate 8 件 (Build-Factory 固有)

| # | Gate | script / command | 検出する漏れ |
|---|---|---|---|
| 1 | mock lint (rule_id 1-19) | `bash scripts/lint-mock.sh` | 絵文字 / AGPL / ARCHIVE / tickets メタ / secrets / langgraph / litellm-in-runner / domain-boundaries / self-provider-routing / self-tool-trim / template-skeleton / self-constitution-inject / mock-impl diff / screens-API / entity-table naming |
| 2 | 3-tier AC validator | `python3 scripts/validate-ears-ac.py docs/task-decomposition/2026-05-15_v3/tickets.json` | AC が 3-tier に分かれてないタスク / EARS 形式違反 |
| 3 | audit MD validator | `python3 scripts/validate-audit-md.py docs/audit/2026-05-15_v3/${TASK_ID}.md` | audit MD 不在 / generic 文言 / 3-tier 欠落 / impl 行範囲未記入 |
| 4 | RLS coverage | `python3 scripts/verify-rls-coverage.py` | entities.json の entity に対する RLS policy 不在 |
| 5 | pytest + coverage | `pytest --cov --cov-fail-under=70` | unit test 失敗 / カバレッジ < 70% |
| 6 | pyright strict | `pyright --strict` | Python 型エラー |
| 7 | TypeScript strict | `cd frontend && tsc --noEmit && pnpm run lint` | TS 型エラー / ESLint 違反 |
| 8 | mock-impl diff (structural AC nonempty 時のみ) | `bash scripts/lint-mock-impl-diff.sh ${SCREEN_IDS}` | mock h1 / KPI / section-h2 と impl の不一致 |

---

## rule_id mapping (lint-mock.sh 内番号)

| 汎用 rule_id | Build-Factory `lint-mock.sh` 内番号 |
|---|---|
| `emoji-ban` | lint #1 |
| `agpl-license-ban` | lint #2 |
| `archive-residue` | lint #3 |
| `tickets-meta` | lint #4 |
| `secrets-detection` | lint #5 |
| `langgraph-ban-in-runner` | lint #6 |
| `litellm-ban-in-runner` | lint #7 |
| `domain-boundaries` | lint #8 |
| `self-provider-routing` | lint #9 |
| `self-tool-trim` | lint #10 |
| `template-skeleton-completeness` | lint #11 |
| `self-constitution-injection` | lint #12 |
| (rule 13-16 は内部 reserved) | lint #13-16 |
| `mock-impl-diff` | lint #17 |
| `screens-API` | lint #18 |
| `entity-table-naming` | lint #19 |

---

## meta タグ schema

- `bf_meta` = `<meta name="screen-id|feature-id|task-ids|entities|phase">` (mock HTML 埋め込み)

---

## technology stack

| 汎用 | Build-Factory 採用 |
|---|---|
| access control | Supabase RLS |
| vector DB | pgvector |
| AI stack | 3-layer (claude-agent-sdk / anthropic-python / LiteLLM) |
| hosting | Vercel + Oracle Cloud + Supabase |
| backend framework | FastAPI (modular monolith, 13+ domain modules) + Python 3.13 + uv + ruff + pyright |
| frontend framework | Next.js 15 (App Router) + shadcn/ui + Tailwind CSS 4 |
| auth | Supabase Auth (GoTrue) + 2FA (TOTP) + OAuth |

---

## task ID pattern

- 汎用 pattern: `T-<group_code>-<NN>`
- Build-Factory v3: `T-V3-<GROUP_CODE>-<NN>` (例: `T-V3-AUTH-01`, `T-V3-RLS-12`, `T-V3-DRIFT-03`, `T-V3-FIX-04`)
- Build-Factory v1: `T-XXX-NN` (例: `T-001-04`)
- Build-Factory v2 縦スライス: `T-S<slice>-<NN>` (例: `T-S0-13`)

---

## Group A-J 細分化マッピング (Build-Factory 固有)

汎用 5 group (A-E) を Build-Factory の歴史的事情で 10 group (A-J) に細分化している。

| 汎用 Group | Build-Factory Group | 内容 | deliverable_layer |
|---|---|---|---|
| **A (Foundation)** | A | Infrastructure (lint #17-19 / 3-tier AC validator / pyright/coverage gate / ADR 起票) | foundation |
| **B (Backend)** | B (sub-1) | AUTH backend (API + middleware + tests) | backend |
|  | C | DB schema 完成 + RLS policy 全実装 | backend |
|  | G | 確定 gap 修正 (backend 寄り) | backend |
| **C (UI)** | B (sub-2) | AUTH frontend | ui |
|  | E | 未実装画面 (Vertical Slice = UI 主体) | ui (vertical slice 込み) |
| **D (Integration test)** | D | 重大 drift 修正 (root画面 / KPI/h1 統一 / 不在 API 実装) | backend |
| **E (Polish)** | F | 既存画面 REFACTOR (R-1〜R-4 適用) | polish |
|  | H | v1 freeze 宣言 / audit retrofit | polish |
|  | I | 余剰整理 (dead table / dead router) | polish |
|  | J | 命名 migration (bf_ prefix 廃止) | polish |

新規プロジェクトでは汎用 5 group (A-E) で十分。Build-Factory は v1 から v3 への移行履歴を保つため 10 group を維持している。

---

## Sprint ↔ Wave ↔ Phase 対応 (Build-Factory 値)

```
Phase 0 (Infrastructure) ─ Sprint 0 ─ Wave 0 ─ Group A
                                        ↓ (gate 整備完了 → 後続解禁)
Phase 1 (dogfood 必須) ──── Sprint 1 ─ Wave 1 ─ Group C / B-1 / G
                                      Wave 2 ─ Group B-2 / D / E
                                      Wave 3 ─ (validation only)
Phase 1.5 (REFACTOR) ────── Sprint 2 ─ Wave 4 ─ Group F
Phase 2 (公開前完成) ────── Sprint 3 ─ Wave 5 ─ Group H
                                      Wave 6 ─ Group I / J
                                      Wave 7 ─ (final validation)
```

---

## 8 Slice 構成 (Build-Factory v2 縦スライス)

Build-Factory の 187 task v2 縦スライス再分解では 8 Slice に分割した:
- Slice 0: Foundation (Group A)
- Slice 1: AUTH (Group B)
- Slice 2: DB + RLS (Group C)
- Slice 3: 重大 drift 修正 (Group D)
- Slice 4: 未実装画面 (Group E)
- Slice 5: REFACTOR (Group F)
- Slice 6: 確定 gap 修正 + audit (Group G/H)
- Slice 7: cleanup + rename (Group I/J)

---

## 数値例 (Build-Factory 実績)

- screens: **43**
- features: **30**
- entities: **43**
- roles: **6**
- tasks: **187** (v1 113 → v2 縦スライス再分解 187)
- backend tests: **8000 pass / 10 skip / 0 fail**
- audit MD: **146+ 件**
- ADR: **12 件** (ADR-001〜012)

---

## 固有名詞

- project name: **Build-Factory**
- company: **株式会社 ENGINE BASE**
- responsible person: **高本まさと** (masato@engine-base.com)
- design token primary color: **ENGINE BASE green `#1a6648` (eb-500)**
- icon library: **Lucide** (絵文字禁止)
- font: **Noto Sans JP + JetBrains Mono**

---

## 出力先 path (Build-Factory)

| 出力 | path |
|---|---|
| task-decomposition v1 (freeze) | `docs/task-decomposition/2026-05-09_v1/` |
| task-decomposition v2 縦スライス (freeze) | `docs/task-decomposition/2026-05-14_v2/` |
| task-decomposition v3 | `docs/task-decomposition/<date>_v3/` |
| 上流 functional-breakdown | `docs/functional-breakdown/2026-05-09_v1/` |
| 上流 api-design | `docs/api-design/<date>_v<N>/` |
| 下流 audit MD | `docs/audit/2026-05-13_v2/<TASK-ID>.md` (v2) / `docs/audit/2026-05-15_v3/<TASK-ID>.md` (v3) |
| ADR ディレクトリ | `docs/decisions/` |

---

## CI workflow テンプレート (Build-Factory)

```yaml
# .github/workflows/v3-gate.yml
on:
  pull_request:
    branches: [main]

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Python
        uses: actions/setup-python@v5
        with: { python-version: '3.13' }
      - name: Install deps
        run: uv sync
      - name: Gate 1 — mock lint
        run: bash scripts/lint-mock.sh
      - name: Gate 2 — 3-tier AC validator
        run: python3 scripts/validate-ears-ac.py docs/task-decomposition/2026-05-15_v3/tickets.json
      - name: Gate 3 — audit MD validator
        run: |
          for f in docs/audit/2026-05-15_v3/T-V3-*.md; do
            python3 scripts/validate-audit-md.py "$f"
          done
      - name: Gate 4 — RLS coverage
        run: python3 scripts/verify-rls-coverage.py
      - name: Gate 5 — pytest + coverage
        run: pytest --cov --cov-fail-under=70
      - name: Gate 6 — pyright strict
        run: pyright --strict
      - name: Gate 7 — TS strict
        run: cd frontend && pnpm install --frozen-lockfile && tsc --noEmit && pnpm run lint
      - name: Gate 8 — mock-impl diff
        if: contains(github.event.pull_request.labels.*.name, 'has-frontend')
        run: |
          bash scripts/lint-mock-impl-diff.sh ${SCREEN_IDS}
```

---

## profile 適用方法

prompt 末尾に以下を加える:

```
references/profiles/build-factory.md を適用してください。
```

これにより:
- script path が Build-Factory の実体に解決される
- phase 名が Phase 0/1/1.5/2 で表示される
- 並列数が 30-50 / CI gate 8 件で表示される
- Group A-J 細分化が適用される
- task ID pattern が `T-V3-<GROUP_CODE>-<NN>` になる
- 出力先が `docs/task-decomposition/<date>_v3/` 等になる
