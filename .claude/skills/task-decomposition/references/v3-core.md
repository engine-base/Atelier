# v3 Core Concepts — task-decomposition

> このファイルは task-decomposition skill の v3 コア概念集 (汎用版)。
> プロジェクト固有値 (script path / phase 名 / 並列数 / lint rule 番号 / meta タグ schema 等) は `references/profiles/<project>.md` に分離する。
> SKILL.md 本体はここで定義する汎用概念のみを参照し、プロジェクト固有値はプレースホルダ (`<lint_runner>` 等) で表現する。

---

## なぜ v3 か (汎用)

v1/v2 では「unit test PASS + lint PASS = done」と判定していたが、実装の現場で次のような漏れが構造的に発生した:

- mock / spec / design system と実装画面の **structural drift**
- spec で約束した API / contract が実在せず screens が呼ぶ先がない (**API 不在**)
- entity を増やしたが access control policy (RLS / RBAC) を書き忘れる (**access policy 漏れ**)
- audit MD が `shall implement T-XXX as specified` のような **generic 文言** で形骸化

v3 では **Done 定義を 3-tier に分割し、全 tier 全項目 pass で初めて done** とする構造を採用。さらに **Foundation phase を必ず最先行** し、後続全タスクを CI gate で守る。

---

## 3-tier Acceptance Criteria

各タスクの `acceptance_criteria` は **3 配列** を持つ JSON:

```json
{
  "acceptance_criteria": {
    "structural": [...],
    "functional": [...],
    "regression": [...]
  }
}
```

### Tier 1 — structural (構造一致)

UI を持つタスクで必須 (backend-only / infra タスクは省略可、ただし `[]` を明示)。

| 検証対象 | 検査方法 (project-defined) |
|---|---|
| 画面 mock の `<h1>` テキストと実装 page の `<h1>` が完全一致 | `<mock_impl_diff>` |
| spec の Hero KPI ラベルと実装 KPI コンポーネントの label が一致 | 同上 |
| spec の主要セクション見出し と実装 section 見出しが集合として一致 | 同上 |
| design system token (color / typography / spacing) との一致 | design-system linter |
| API contract (OpenAPI / IDL) との一致 | contract diff tool |

structural 層は **「下層 (data / migration) → 上層 (UI component) の順で deliverable を上げる」** ことを宣言する役割も持つ。各タスクカードの `deliverable_layer` フィールド (`foundation` | `backend` | `ui` | `polish`) と整合させる。

**書式例 (EARS STATE-DRIVEN)**:
```
STATE-DRIVEN: While the page is rendered, the system shall display an h1 element with the exact text "<spec heading>" (matching <spec_path> h1).
```

### Tier 2 — functional (仕様要求一致)

全タスクで必須。**EARS 5 形式のいずれかで記述**。

| 検証対象 | 検査方法 (project-defined) |
|---|---|
| screens の `related_apis` が backend に存在し 200/4xx を正しく返す | `<screens_api_check>` + integration test |
| entities に対する access policy (RLS / RBAC) が存在し unauthorized を拒否 | `<access_control_verifier>` |
| feature.happy_path / error_paths が実装で動く | E2E / integration test |
| EARS 5 形式で spec を逐語表現 | `<ac_validator>` |
| **横断A: 中断・再開耐性** (多ステップ / 状態遷移タスクのみ必須) | 中断点・中断時状態 (draft/pending/incomplete)・再開導線・冪等性 (再試行 / 二重送信 / 往復で重複・不整合なし)・未完状態の期限を E2E / integration test で検証 |
| **横断B: 異常系・エラー処理 (4 レイヤー)** (全タスク必須) | UI (分かりやすいメッセージ / リトライ / loading・空・エラー・オフライン・権限なしの出し分け)・API (4xx/5xx 明確化)・データ (ロールバック / 整合性)・復旧 (失敗→停止→復活 / 外部依存ダウン時フォールバック) の該当レイヤーを検証 |

#### 横断的関心事の必須 AC (functional 層に織り込む)

3-tier AC を「正常系だけ」にしないため、functional 層には以下 2 カテゴリを必ず含める。

- **横断A: 中断・再開耐性** — 多ステップ / 状態遷移を持つタスク (eKYC / 決済 / 申込 / ウィザード等) に必須。
- **横断B: 異常系・エラー処理 (4 レイヤー)** — 全タスクに必須 (該当レイヤーのみ。該当しないレイヤーは省略可)。

**書式例 (横断A 中断・再開 / 冪等性)**:
```
STATE-DRIVEN: While the multi-step flow is incomplete, the system shall persist its state as [draft|pending|incomplete] and allow resume from the last completed step until [未完状態の期限].
UNWANTED: If the same request is retried, double-submitted, or round-tripped, the system shall not create duplicate records or leave inconsistent state.
```

**書式例 (横断B 異常系 4 レイヤー)**:
```
STATE-DRIVEN: While the screen is in [loading|空|エラー|オフライン|権限なし], the system shall display the corresponding state with a clear message and (where recoverable) a retry path.   ← UI
UNWANTED: If a [4xx|5xx] condition occurs, the system shall return a clear error, and on data writes shall roll back to preserve integrity.   ← API + データ
EVENT-DRIVEN: When an external dependency is down, the system shall stop safely, fall back to [degraded behavior], and recover without data loss.   ← 復旧
```

**EARS 5 形式**:

| 形式 | 書式 |
|---|---|
| **UBIQUITOUS** | The system **shall** ... |
| **EVENT-DRIVEN** | When [event], the system **shall** ... |
| **STATE-DRIVEN** | While [state], the system **shall** ... |
| **OPTIONAL** | Where [feature is enabled], the system **shall** ... |
| **UNWANTED** | If [unwanted condition], the system **shall not** ... |

### Tier 3 — regression (退行検知)

全タスクで必須。CI gate を逐語的にここに書く。

| 検証対象 | 検査方法 (project-defined) |
|---|---|
| unit test PASS | test runner (project-defined) |
| lint PASS | linter (project-defined rule set) |
| 静的型チェック PASS | type checker (project-defined: pyright / tsc / mypy 等) |
| coverage ≥ 閾値 | coverage tool (閾値は project-defined、推奨 70%) |
| (UI task のみ) E2E PASS | browser automation (project-defined) |

### タスク種別ごとの必須 Tier

| タスク category | structural | functional | regression |
|---|:---:|:---:|:---:|
| frontend (画面実装) | required | required | required |
| backend (API 実装) | optional | required | required |
| db (schema/migration/policy) | optional | required (access policy) | required |
| test | optional | required | required |
| infra (lint/CI) | optional | required | required |
| cleanup | optional | optional | required |

省略する場合は明示的に `"structural": []` を書く。`null` や field 欠落は validator が reject する。

**横断的関心事の必須化**: `functional` が required の全タスクは、横断B (異常系 4 レイヤーの該当レイヤー) を必ず含める。さらに多ステップ / 状態遷移を持つタスクは横断A (中断・再開／冪等性) も必ず含める。正常系のみの `functional` は不可 (validator / audit MD validator が reject 対象)。

### audit MD への展開

`structural` / `functional` / `regression` の各項目は audit MD (`<audit_dir>/<task_id>.md`) で **逐語マッピング** する:

```markdown
## Tier 1: Structural
- [ ] AC-S1: spec h1 「<text>」== impl <h1> → <impl_path>:<lines>
- [ ] AC-S2: spec KPI N labels == impl → <impl_component>:<lines>

## Tier 2: Functional (AC verbatim)
- [ ] AC-F1: EVENT-DRIVEN When <method> <path> ... → <impl_path>:<lines>
- [ ] AC-F2: UNWANTED If caller not authorized ... → <impl_path>:<lines>
- [ ] 横断A 中断・再開: STATE-DRIVEN While flow incomplete ... (中断時状態 + 再開導線 + 未完期限) → <impl_path>:<lines> (多ステップ・状態遷移タスクのみ、該当なしは N/A)
- [ ] 横断A 冪等性: UNWANTED If retried / double-submitted ... → <impl_path>:<lines> (同上)
- [ ] 横断B 異常系 UI: STATE-DRIVEN While loading/空/エラー/オフライン/権限なし ... → <impl_path>:<lines>
- [ ] 横断B 異常系 API+データ: UNWANTED If 4xx/5xx ... (+ ロールバック) → <impl_path>:<lines>
- [ ] 横断B 復旧: EVENT-DRIVEN When external dep down ... → <impl_path>:<lines> (該当なしは N/A)

## Tier 3: Regression
- [ ] test runner: N/N PASS
- [ ] coverage: NN% (>= threshold)
- [ ] type checker: 0 errors
- [ ] lint: K/K OK

## Decision: DONE | BLOCKED | GAP
```

generic 文言 (`shall implement T-XXX as specified by feature F-XXX` 等) は **不可**。`<audit_md_validator>` が generic phrase を検出して reject する。

---

## Foundation → Backend → UI フロー

v3 では **下層 (data / contract) → 上層 (UI / component) の順** に deliverable を上げる。タスクカードの `deliverable_layer` フィールドで明示する。

```
Foundation phase (deliverable_layer: foundation)
  ├─ CI/CD pipeline (lint / format / type check / coverage gate)
  ├─ Test infrastructure
  ├─ Access control framework (RLS / RBAC / policy enforcement)
  ├─ Audit / logging infrastructure
  ├─ AC validator / spec validator (EARS / 3-tier schema)
  └─ Pre-flight audit MD mechanism

   ↓ Foundation gate passes

Backend phase (deliverable_layer: backend)
  ├─ Data layer (entity / migration / access policy)
  ├─ Service layer (business logic)
  ├─ API layer (REST / GraphQL / gRPC) + OpenAPI / IDL
  ├─ Contract test (consumer-driven / Schemathesis / Pact)
  └─ Backend integration test (access policy matrix / business logic E2E)

   ↓ Backend gate passes

UI phase (deliverable_layer: ui)
  ├─ Component implementation (against spec / against mock / against design system)
  ├─ State management (data fetching / cache)
  ├─ UI integration test (visual regression / interaction)
  └─ Accessibility check

   ↓ UI gate passes

Polish phase (deliverable_layer: polish)
  ├─ Performance optimization
  ├─ Security audit
  ├─ Documentation
  └─ Release readiness
```

### task-decomposition での適用ルール

- 各タスクカードに `deliverable_layer: foundation | backend | ui | polish` を必ず付与
- **Foundation tasks (Group A) は他の Group の prerequisite** として扱う (`depends_on` で明示)
- Vertical Slice タスク (1 画面 = backend + UI を 1 タスク) は `deliverable_layer: backend` (中核が backend のため) とし、UI 部分は同タスク内で `structural` AC として扱う
- Polish tasks は他全タスク完了後に着手する

---

## Vertical Slice

v3 では「1 機能 = 画面 + API + test + access policy の bundle」を default とする。

- 1 タスクで `screens` / `api_endpoints` / `entities` / `access_policies` / `tests` をまとめて実装
- 利点:
  - 1 タスクを 1 並列セッション (= 1 PR) で完結できる
  - 3-tier AC を 1 commit で全 tier 満たせる
  - レイヤー間 (FE/BE/DB) の境界で wait が発生しない

例外 (Vertical Slice にしない場合):
- Foundation (Group A) : 単独 task
- DB schema migration: 1 entity = 1 task (migration 番号で順序保証)
- Cleanup / rename: 単独 task

---

## Wave 単位の並列実行

依存 DAG ベースで **Wave** に分け、同 Wave 内のタスクは並列実行する。

```
Wave 0 = Foundation phase (project-defined naming) — 必ず単独
Wave 1+ = Backend phase per slice
Wave N = UI phase per slice
Wave M = Polish phase
```

- 各 Wave 内のタスク数は **N parallel sessions (project-defined parallel capacity)** を超えない
- 各 Wave の所要時間は project-defined (典型: 2-4h)

---

## file-level mutex / work-package boundary

並列実行時の conflict を事前に防ぐため、各タスクの `files_changed` で **file 単位の mutex** を確保する。

- 同じ file を 2 タスクが同時に触らないよう Wave 内で boundary を切る
- migration / DB schema は順序保証が必要なため別 Group に分離
- 共通 component (Button / Input 等) は別タスクで先行実装し、それを使うタスクで `depends_on` する

---

## pre-flight audit MD

各タスクに `audit_md_path` を割り当て、**着手前に template から手動執筆**する。

- auto-generated は禁止 (generic 文言の隠れ蓑になる)
- template は 3-tier AC を逐語的に展開した checklist 形式
- `<audit_md_validator>` で generic phrase を検出して CI gate で block

---

## CI gate auto-merge

各 PR は **N CI gates (project-defined gate set)** 全 pass したときのみ main にマージ可能。1 つでも fail → auto-merge 不可。

### 汎用 gate カテゴリ

| Gate カテゴリ | 検出する漏れ |
|---|---|
| **lint gate** | コード規約違反 / 禁則 import / spec ⇔ impl drift (rule_id: project-defined) |
| **AC validator gate** | AC が 3-tier に分かれてないタスク / EARS 形式違反 |
| **audit MD validator gate** | audit MD 不在 / generic 文言 / 3-tier 欠落 / impl 行範囲未記入 |
| **access control coverage gate** | entity に対する access policy 不在 |
| **test + coverage gate** | unit test 失敗 / カバレッジ < 閾値 |
| **static type check gate** | 型エラー (project-defined: pyright / tsc / mypy) |
| **structural diff gate** | mock / spec と impl の structural mismatch (UI task のみ) |
| **contract diff gate** | OpenAPI / IDL と impl の不一致 |

各タスクの `acceptance_criteria.regression` 配列に **gate コマンドを逐語的に書く** (例: `The system shall pass <test_runner> for this task ID with coverage >= 70%.`)。

### 失敗時の retry プロトコル

1. CI が PR コメントに失敗内容貼る
2. session orchestrator が同じ task の retry session を起動
3. N 回連続失敗 → human エスカレーション (N は project-defined、典型 3 回)

---

## Phase gate 機械判定

各 phase 境界 (Foundation 完了 / Backend 完了 / UI 完了 / Polish 完了) は **mechanical / observable** に判定する。

- Foundation gate: 全 CI gate script の存在 + 各 script が空入力で 0 終了
- Backend gate: 全 backend task の 3-tier AC PASS + access policy coverage 100%
- UI gate: 全 UI task の structural diff 0 + 全 e2e PASS
- Polish gate: performance / security / docs の checklist 100%

human の主観判定は禁止 (=「だいたい OK」を許さない)。

---

## v3 task object schema

各タスクは以下の必須/任意フィールドを持つ:

```json
{
  "id": "<TASK_ID_PATTERN>",
  "title": "...",
  "category": "backend | frontend | db | test | infra | cleanup",
  "label": "NEW | REFACTOR | REUSE | ARCHIVE | FIX",
  "feature_id": "F-XXX",
  "screen_ids": ["S-XXX"],
  "entity_ids": ["E-XXX <Name>"],
  "legacy_task_id": "T-XXX-NN | null",
  "phase": "<phase_name (project-defined)>",
  "wave": 0,
  "group": "A | B | ... ",
  "deliverable_layer": "foundation | backend | ui | polish",
  "estimate_hours": 4,
  "estimate_sessions": 1,
  "depends_on": ["T-XXX-MM"],
  "files_changed": ["path/to/file (new|modify|delete)"],
  "acceptance_criteria": {
    "structural": [],
    "functional": ["EVENT-DRIVEN: ..."],
    "regression": ["The system shall pass <test_runner> ..."]
  },
  "access_policies_required": ["<table>:<policy_name>"],
  "spec_links": ["<spec_path>"],
  "audit_md_path": "<audit_dir>/<task_id>.md"
}
```

### フィールド定義 (要点)

- **id**: pattern は project-defined (例: `T-V3-<GROUP_CODE>-<NN>`)
- **category**: 列挙値 `backend | frontend | db | test | infra | cleanup`
- **label**: 列挙値
  - `NEW`: 既存実装なし
  - `REFACTOR`: 既存あり、v3 規約に書き直す
  - `REUSE`: 既存そのまま流用 (verify のみ)
  - `ARCHIVE`: 削除予定
  - `FIX`: gap として確定済
- **deliverable_layer**: Foundation→Backend→UI→Polish のどの層に属するか
- **estimate_hours**: 目安 2〜8h (これより大きい場合は分割)
- **estimate_sessions**: ceil(estimate_hours / 4)
- **acceptance_criteria**: 3-tier すべて必須 (空でも `[]`)
- **access_policies_required**: pattern `<table>:<policy_name>` (entity_ids あれば必須)
- **spec_links**: 最低 1 件必須

---

## 分解モードと Group コード

v3.1 から **分解モード** を選択する。各モードで Group 構成が異なる。

### モード判定基準

| 判定軸 | api_first（デフォルト） | vertical_slice（限定） |
|---|---|---|
| UI クライアント数 | 2 種類以上（Web+MCP / 別ポータル / Admin など） | 1 種類のみ |
| AI エージェント並列実装 | yes | no |
| UI モック | 先行完成 or 契約明示 | 未確定で iterating |
| 横断的関心事 | 多い（RLS / 監査 / 認可など） | 少ない |
| 売却・エンタープライズ視野 | yes | no |

**判定**: 1 つでも左列に該当 → `api_first`。すべて右列なら `vertical_slice`。

### API-First モード Group 構成（推奨デフォルト）

| Code | 内容 | deliverable_layer | Phase |
|---|---|---|---:|
| **F** | Foundation (CI / lint / type check / coverage gate / framework setup / 観測 / メール / LLM 抽象化 / デザインシステム統合) | foundation | 1 |
| **D** | Data (全 entity migration + 全 RLS / access policy) | foundation | 2 |
| **A** | API (全 endpoint + 全 service + OpenAPI 完全生成 + contract test) | backend | 3 |
| **U-shared** | UI 共通基盤 (レイアウト / ナビ / 共通 component / 型安全 API クライアント / 共通 hooks) | ui | 4 |
| **U-screen** | UI 画面 (各画面 1 タスク、並列実装可) | ui | 5 |
| **I** | Integration (E2E / 横断試験 / 性能 / a11y / cleanup) | polish | 6 |

**Wave 構造**:

```
Wave 0: Group F (Foundation)
Wave 1: Group D (entity 数だけ並列)
Wave 2: Group A (endpoint 数だけ並列、Phase 3 終了時に OpenAPI + TS 型確定)
Wave 3: Group U-shared
Wave 4: Group U-screen (画面数だけ並列 = 最大並列度)
Wave 5: Group I
```

**API-First 必須出力（STEP 2 で）**:

1. **画面 ↔ API 逆引きマトリクス**: 全画面 N 件 × 必要 API endpoint。1 つでもカバーされない画面があれば API レイヤに追加タスクを起票
2. **OpenAPI 仕様完全性チェック**: 全 endpoint について request / response / 4xx パターンが網羅
3. **型生成パイプライン**: OpenAPI → TypeScript 型自動生成のスクリプトをタスク化
4. **画面実装前の契約凍結ポイント**: Phase 3 完了 = API 凍結。以後の変更は影響解析必須

### Vertical Slice モード Group 構成（限定オプション）

| Code | 内容 | deliverable_layer |
|---|---|---|
| **A** | Foundation (lint / AC validator / type check / coverage gate / framework setup) | foundation |
| **B** | Backend Vertical Slice (data + service + API + contract test を機能単位で 1 タスク) | backend |
| **C** | UI Vertical Slice (component + state + UI test を機能単位で 1 タスク) | ui |
| **D** | Integration test (cross-slice E2E / access policy matrix) | backend |
| **E** | Polish (perf / security / docs / drift fix / cleanup / rename) | polish |

プロジェクト profile で細分化する例: `references/profiles/<project>.md` の Group マッピング表を参照。

### モード選択を間違えた場合の影響

| 状況 | 結果 |
|---|---|
| 並列 AI 実装で Vertical Slice 選択 | 各 slice が同じ API を独自に呼ぶ → 契約衝突 / 重複実装 / API drift |
| 複数クライアントで Vertical Slice 選択 | 各 client UI が個別に API を期待 → 後で API 統合工数膨張 |
| 単独 Web で API-First 選択 | Phase 1-3 が長くなり「動くものが見えない」期間が伸びる（実害は小） |

**迷ったら API-First を推奨**: 後で Vertical Slice に切り替えるよりも、API-First → Vertical Slice の移行の方が手戻りが小さい（API 契約は資産として残る）。

---

## 入力 (上流 skill から pull する内容)

- functional-breakdown の 4 JSON (features / screens / entities / roles)
- api-design の OpenAPI / IDL
- architecture-design の layer 構成 + access policy 一覧
- (あれば) UI mock / design system token
- (あれば) 既存実装の drift 検知出力

## 出力 (下流 skill / 実装者に渡す内容)

- タスクカード一覧 (Markdown、PM・実装者向け)
- `tickets.json` (3-tier AC schema、validator 用)
- `DEPENDENCIES.md` (DAG / Wave / CI gate)
- 判断ログ JSON (decision_log / risk_flags / research)
- audit MD template (各タスク 1 件、`<audit_dir>/<task_id>.md`)

---

## connections (汎用 / プロジェクト profile で具体化)

| 連携先 skill | 連携内容 |
|---|---|
| functional-breakdown (上流) | 機能オブジェクト + screen/entity/role を pull、Group A-J マッピング共通化 |
| api-design (上流) | API endpoint 一覧 + EARS AC seed を pull |
| architecture-design (上流) | layer 構成 + access policy boundary を pull |
| schedule-design (下流) | Wave / 並列度 / 工数を pass |
| distributed-dev (下流) | タスクカード + audit MD template を pass |
| test-verification (下流) | 3-tier AC + CI gate を pass |
| integration (下流) | Phase gate 機械判定基準を pass |
