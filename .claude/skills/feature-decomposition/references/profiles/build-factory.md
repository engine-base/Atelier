# Build-Factory Profile (例として位置づけ)

> このファイルは feature-decomposition skill を Build-Factory プロジェクトに適用するための **profile 例**。他プロジェクトは独自 profile (`references/profiles/<project>.md`) を作成する。
> SKILL.md / references/v3-core.md は完全汎用化されており、profile を呼び出さなければ project-agnostic なまま動く。

---

## script path

| 汎用名 | Build-Factory での実体 |
|---|---|
| `<lint_runner>` | `scripts/lint-mock.sh` |
| `<ac_validator>` | `scripts/validate-tickets.py` |
| `<access_control_verifier>` | `scripts/verify-rls-coverage.py` |
| `<audit_md_check>` | `scripts/audit-md-check.sh` |
| `<mock_impl_diff>` | `scripts/lint-mock-impl-diff.py` |

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

---

## CI gate 8 件 (Build-Factory 固有)

| # | Gate | 検出する漏れ |
|---|---|---|
| 1 | mock lint (rule_id 1-19) | 絵文字 / AGPL / mock-impl diff / screens-API / entity-table naming |
| 2 | 3-tier AC validator | AC 形式違反 / EARS 違反 |
| 3 | audit MD validator | generic 文言 / 不在 |
| 4 | RLS coverage | RLS policy 不足 |
| 5 | pytest + coverage (≥70%) | unit test 失敗 / カバレッジ不足 |
| 6 | pyright strict | Python 型エラー |
| 7 | TypeScript strict (tsc) | TS 型エラー |
| 8 | mock-impl diff | structural mismatch |

---

## rule_id mapping

| 汎用 rule_id | Build-Factory `lint-mock.sh` 内番号 |
|---|---|
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
| backend framework | FastAPI (modular monolith, 13+ domain modules) |
| frontend framework | Next.js 15 (App Router) + shadcn/ui |

---

## Group A-J 細分化マッピング (Build-Factory 固有)

汎用 5 group (A-E) を Build-Factory の歴史的事情で 10 group (A-J) に細分化している。

| 汎用 Group | Build-Factory Group | 内容 |
|---|---|---|
| **A (Foundation)** | A | Infrastructure (lint #17-19 / 3-tier AC validator / pyright/coverage gate / ADR 起票) |
| **B (Backend)** | B (sub-1) | AUTH backend (API + middleware + tests) |
|  | C | DB schema 完成 + RLS policy 全実装 |
|  | G | 確定 gap 修正 (backend 寄り) |
| **C (UI)** | B (sub-2) | AUTH frontend |
|  | E | 未実装画面 (Vertical Slice = UI 主体) |
| **D (Integration test)** | D | 重大 drift 修正 (root画面 / KPI/h1 統一 / 不在 API 実装) |
| **E (Drift fix)** | F | 既存画面 REFACTOR (R-1〜R-4 適用) |
|  | H | v1 freeze 宣言 / audit retrofit |
|  | I | 余剰整理 (dead table / dead router) |
|  | J | 命名 migration (bf_ prefix 廃止) |

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
- Slice 1: Foundation (Group A)
- Slice 2: AUTH (Group B)
- Slice 3: DB + RLS (Group C)
- Slice 4: 重大 drift 修正 (Group D)
- Slice 5: 未実装画面 (Group E)
- Slice 6: REFACTOR (Group F)
- Slice 7: 確定 gap 修正 + audit (Group G/H)
- Slice 8: cleanup + rename (Group I/J)

---

## 数値例 (Build-Factory 実績)

- screens: **43**
- features: **30** (+ v3 drift / refactor で増減)
- entities: **43**
- roles: **6**
- tasks: **187** (v1 113 → v2 縦スライス再分解 187)
- backend tests: **8000 pass / 10 skip / 0 fail**
- audit MD: **146+ 件**

---

## 固有名詞

- project name: **Build-Factory**
- company: **株式会社 ENGINE BASE**
- responsible person: **高本まさと** (masato@engine-base.com)
- design token primary color: **ENGINE BASE green `#1a6648` (eb-500)**
- icon library: **Lucide** (絵文字禁止)
- font: **Noto Sans JP + JetBrains Mono**
- ADR ディレクトリ: `docs/decisions/` (ADR-001〜012)

---

## 出力先 path (Build-Factory)

| 出力 | path |
|---|---|
| feature-decomposition v1 | `docs/feature-decomposition/2026-05-09_v1/` (freeze) |
| feature-decomposition v3 | `docs/feature-decomposition/<date>_v3/` |
| 上流 functional-breakdown | `docs/functional-breakdown/2026-05-09_v1/` |
| 下流 task-decomposition | `docs/task-decomposition/2026-05-09_v1/` (v1) / `docs/task-decomposition/2026-05-14_v2/` (v2 縦スライス) |
| audit MD | `docs/audit/2026-05-13_v2/<TASK-ID>.md` |

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
