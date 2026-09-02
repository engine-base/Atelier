# v3 Core Concepts — distributed-dev

> 2026-05-15 v3 から、distributed-dev は **3-tier AC + N CI gate (project-defined) + work-package boundary (file mutex) + pre-flight audit MD + wave-schedule.json 連携** を CLAUDE.md に必須埋め込み。**project-defined parallel capacity** での「工場の作業員」運用が前提。

このファイルは汎用 v3 概念のみを扱う。プロジェクト固有値 (script path / phase 名 / 並列数 / lint rule 番号 / branch 命名規則 等) は `references/profiles/<project>.md` に集約する (例として `references/profiles/build-factory.md` を同梱)。

## なぜ v3 か (汎用)

v1 / v2 では:
- CLAUDE.md にスコープ境界だけが書かれ、3-tier AC が抽象化されて落ちる
- Done Criteria が「動く」レベルで止まり、N CI gate に対応していない
- work-package boundary が「触らないファイル」リスト止まりで、並列セッションが同 file を edit して conflict 多発
- 事後監査 (audit MD を完了後に書く) で抜けが多発 → pre-flight (着手前) に切替
- wave-schedule.json から Wave ID / 起動順を継承する仕組みがない
- Wave 内で backend layer 完了前に UI layer に着手して spec drift 多発

v3 では:
- **tickets.json の 3-tier AC を CLAUDE.md に逐語コピー**
- **N CI gate (project-defined gate set) を Done Criteria に必須記載**
- **file-level mutex** で同一 file への並列 edit を機械的に防ぐ
- **pre-flight audit MD** を着手前に generate → 埋めてから実装開始
- **wave-schedule.json** から Wave ID + depends_on_waves + parallel_session_count を継承
- **Wave 内も backend-first → UI-second 順序** を維持 (UI task の着手前に backend gate pass を pre-flight audit MD で確認)

## 3-tier AC (汎用)

| Tier | 観点 | 検証手段例 |
|---|---|---|
| Tier 1: Structural | mock / spec との一致 (h1 text / kpi label / btn label / route path 等) | mock-impl-diff lint |
| Tier 2: Functional | EARS 形式 AC で記述された機能要件 / access control matrix / contract | unit + contract test + access control verifier |
| Tier 3: Regression | test cov / lint / type checker / audit MD | CI gate set |

## Foundation → Backend → UI フロー (汎用)

```
Foundation phase (Wave 0)
  ├─ CI/CD pipeline (lint / format / type check / coverage gate)
  ├─ Test infrastructure
  ├─ Access control framework (RLS / RBAC / policy enforcement)
  ├─ Audit / logging infrastructure
  └─ Pre-flight checklist mechanism

   ↓ Foundation gate passes

Backend phase (per slice, Wave 1+)
  ├─ Data layer (entity / migration / access policy)
  ├─ Service layer (business logic)
  ├─ API layer (REST / GraphQL / gRPC) + OpenAPI / IDL
  ├─ Contract test (Schemathesis / Pact / consumer-driven)
  └─ Backend integration test (access matrix / business logic E2E)

   ↓ Backend gate passes

UI phase (per slice, Wave N)
  ├─ Component implementation (against spec / against mock)
  ├─ State management (data fetching / cache)
  ├─ UI integration test (visual regression / interaction)
  └─ Accessibility check

   ↓ UI gate passes

Polish phase (cross-cutting)
  ├─ Performance optimization
  ├─ Security audit
  ├─ Documentation
  └─ Release readiness
```

distributed-dev は **Wave 内も backend-first → UI-second 順序** を維持する責任を持つ:
- 同一 Wave に backend / UI task が混在する場合、UI task の `depends_on_tasks` に backend task を含める
- UI task の pre-flight audit MD に「backend gate passed?」項目を必須化
- UI task のセッション起動前に dependent backend task の gate green を確認

## Vertical Slice (汎用)

backend → UI を 1 機能完結で切り出した E2E feature 単位。Wave 内の主要構成単位 (Backend group / UI group) と整合する。

## Wave 並列実行 (汎用)

| 概念 | 説明 |
|---|---|
| Wave | 並列実行単位 (例: 1 Wave = 数時間 × project-defined parallel capacity) |
| group | Foundation / Backend / UI / Integration / Polish (project-defined naming) |
| depends_on_waves | この Wave 起動の前提となる完了 Wave 群 |
| parallel_session_count_target | 1 Wave 内で並列起動するエージェントセッション数 (project-defined capacity) |
| layer | backend / UI (Wave 内順序判定) |

## file-level mutex / work-package boundary (汎用)

### 4 区分

| 区分 | 意味 | CI 検証 |
|---|---|---|
| `editable` | 作成・編集 OK | boundary lint で diff が editable + shared_no_concurrent_edit の subset であることを確認 |
| `shared_no_concurrent_edit` | Wave 内で他 task と共有、同時編集禁止 | Wave 起動時 mutex check で同 file を editable に持つ task が複数あれば block |
| `readonly` | 読むが変更しない | boundary lint で diff にこの file が含まれたら fail |
| `forbidden` | 絶対に触らない | boundary lint で diff にこの file が含まれたら fail |

### tickets.json での記述例

```json
{
  "task_id": "<task_id>",
  "work_package_boundary": {
    "editable": ["<editable file paths>"],
    "shared_no_concurrent_edit": ["<shared file paths>"],
    "readonly": ["<readonly file paths>"],
    "forbidden": ["<forbidden file paths or directories>"]
  }
}
```

### Wave 内 mutex 検出

Wave mutex check tool が Wave 起動時に検出:
- Wave 内の全 task の `shared_no_concurrent_edit` を集約
- 同 file を `editable` に持つ task が複数あれば Wave 起動を block
- 順次実行に切り替え (Wave 分割) or task の boundary を絞り直すよう警告

### 違反検出

boundary lint rule:
- PR diff の変更 file が `editable` の subset であることを検証
- `forbidden` への変更があれば fail
- `shared_no_concurrent_edit` への変更は OK だが警告 (Wave mutex 取得済か確認)

## pre-flight audit MD (汎用)

着手前に template から生成して埋める。事後監査ループは廃止。

### template の汎用構造

```markdown
# audit: <task_id>

## pre-flight (着手前 / 必須)

### 既存実装の調査
- 関連 file: (grep 結果)
- 既存パターン: (どの file の何関数を参考にするか)
- 落とし穴: (既知の bug / 非互換)

### 3-tier AC の現状評価
- Tier 1 structural: 何% 満たされているか
- Tier 2 functional: 既存 endpoint で何件 pass か
- Tier 3 regression: cov / lint / type の現状値

### Wave 内 layer 順序チェック (v3)
- foundation prerequisite passed? (Y/N + 根拠)
- backend gate passed? (Y/N + 根拠 / UI layer の場合は必須)
- UI 着手可能? (Y/N / UI layer の場合)

### 触る予定ファイル
| file | 区分 (editable/shared/readonly/forbidden) | 理由 | 変更規模 |
|---|---|---|---|

### 実装方針
- alternatives: (検討した案)
- chosen: (選定理由)

## post-implementation (完了後 / 任意)

### 実装後の AC pass 状況
- Tier 1/2/3 の最終状態

### drift 発見
- スコープ外で見つけた drift: TODO(drift) として記録した item 一覧
```

project 固有の追加項目 (例: project-specific lint rule のチェック等) は profile に記載する。

## CI gate auto-merge (汎用)

### N gate の構成原則

project-defined gate set。各 gate は機械的・観測可能な tool で判定し、全 gate green で auto-merge。連続 N 失敗で human エスカ。

汎用 gate カテゴリ例:
- Foundation gate: lint / format / AC validator
- Backend gate: access control coverage / API contract / test coverage threshold
- UI gate: type check / mock-impl drift / visual regression
- Polish gate: audit MD existence / perf budget / security scan

具体的な tool / コマンドは profile に記載。

## Phase gate 機械判定 (汎用)

Foundation → Backend → UI → Polish の各 phase 完了は Wave 完了サマリー (auto-merged / retried / escalated / rolled-back の 4 カテゴリ + drift 検出件数) で判定。詳細は integration スキル側。

## CLAUDE.md v3 schema (汎用)

```markdown
# 実装タスク: <task_id> - <title>

## 0. 上流出力 (この task の context を構成する path)
- task: <task_dir>/tickets.json (entry: <task_id>)
- mock: <mock_dir>/<screen_id>
- api: <api_dir>/openapi.yaml (path: <method> <endpoint>)
- ears_ac_seed: <api_dir>/ears-ac-seed.json (endpoint: <method> <endpoint>)
- entities: <fb_dir>/entities.json (entity: <entity_id>)
- wave: <schedule_dir>/wave-schedule.json (wave_id: <wave_id>)
- pre_flight_audit: <audit_dir>/<task_id>.md (着手前に埋める)

## 1. Wave / 起動情報
- wave_id: W<N>
- depends_on_waves: [W<N-1>, ...]
- parallel_session_count_target: <N>
- group: <Foundation | Backend | UI | Integration | Polish>
- layer: backend / UI

## 2. 実装する内容 (1〜2 文)

## 3. work-package boundary (file mutex)

### editable
### shared_no_concurrent_edit
### readonly
### forbidden

## 4. 実装仕様

### EARS AC (api-design ears-ac-seed.json から逐語コピー)
### 型定義 (openapi.yaml から自動生成済 / 人手 edit 禁止)
### 処理フロー
### access control policy (entities.json から)

## 5. Done Criteria (3-tier AC + N CI gate)

### Tier 1: Structural (mock/spec 一致)
### Tier 2: Functional (EARS API + access control + Contract)
### Tier 3: Regression (test / lint / type / coverage / audit MD)

### N CI gate auto-merge

## 6. pre-flight audit MD (着手前に必ず実行)

## 7. 完了報告の形式

## 8. 注意事項 (機械的 boundary)
```

## start-cmd.sh / done-cmd.sh (汎用構造)

### start-cmd.sh (Wave 起動時にエージェントが最初に実行)

```bash
#!/bin/bash
set -e

TASK_ID="$1"

# 1. branch を切る (idempotent)
git checkout main
git pull
git checkout -b "<branch_prefix>/${TASK_ID,,}" 2>/dev/null || git checkout "<branch_prefix>/${TASK_ID,,}"

# 2. pre-flight audit MD を生成 (まだ無ければ)
AUDIT_PATH="<audit_dir>/${TASK_ID}.md"
if [ ! -f "$AUDIT_PATH" ]; then
  cp "<audit_dir>/_template.md" "$AUDIT_PATH"
fi

# 3. Wave mutex check
<wave_mutex_check> --task "$TASK_ID"

# 4. CLAUDE.md を表示 (エージェントが読む)
cat ".claude/branches/${TASK_ID}.md"
```

### done-cmd.sh (Done Criteria を全て CI で検証)

```bash
#!/bin/bash
set -e

TASK_ID="$1"

# 1. all N gates (project-defined gate set)
<lint_runner>
<ac_validator>
<access_control_verifier>
<audit_md_check>
<backend_test> --cov --cov-fail-under=<threshold>
<backend_type_checker>
<frontend_type_checker>
<mock_impl_diff>

# 2. work-package boundary check
<work_package_boundary_check> --task "$TASK_ID"

# 3. push + create PR
git push -u origin HEAD
# PR 作成 + auto-merge は CI runner / GitHub Actions 等で実行
```

## 入力 (上流出力 pull)

| 上流 | pull する内容 |
|---|---|
| task-decomposition | tickets.json の 1 task entry (3-tier AC + work_package_boundary + dependencies) |
| api-design | ears-ac-seed.json の該当 endpoint AC + openapi.yaml の該当 path |
| functional-breakdown | screens.json (mock_path / h1_text) + entities.json (access_control_policies) |
| schedule-design | wave-schedule.json の該当 wave (wave_id / depends_on_waves / parallel_session_count_target) |
| test-verification | gate-config.yml + ears-test-mapping.json (test ID 対応) |

## 出力

| 下流 | このスキルが供給する情報 |
|---|---|
| コーディングエージェントセッション (1 task ごと) | CLAUDE.md + start-cmd.sh + done-cmd.sh |
| integration | branch-package.json (どのブランチを統合するか / 4 区分の boundary) |
| CI runner | done-cmd.sh の N gate 実行プラン |

## connections (汎用 / project profile で具体化)

各 path / script / 並列数の具体値は `references/profiles/<project>.md` を参照。

## 互換性

- v1: freeze
- v3 (新出力): 3-tier AC 埋め込み + N CI gate auto-merge + file-level mutex + pre-flight audit MD + Wave 連携 + Wave 内 backend-first 順序維持
