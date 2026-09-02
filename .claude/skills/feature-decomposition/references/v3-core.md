# v3 Core Concepts — feature-decomposition

> 2026-05-15 v3 から、feature-decomposition の機能オブジェクトと Sprint 構成に **Foundation 先行 / Vertical Slice / Group A-E 命名 / project-defined parallel capacity Wave / CI gate 連携 / functional-breakdown pull** を採用。
> ここで定義する内容は、上流の functional-breakdown の 4 JSON を input とし、下流の task-decomposition で tickets に細分化される。
> プロジェクト固有値の適用例は `references/profiles/build-factory.md` を参照。

---

## なぜ v3 か (汎用)

v1 / v2 では:
- Sprint 構成が汎用的 (Sprint 1-N) で Foundation (lint / CI gate) を後回しにできた → 実装着手後に gate を作る = ザル
- 機能オブジェクトに spec 紐付けが無く、task-decomposition が re-derive する必要があった (情報重複 + drift)
- 並列度が暗黙で「グループ A/B」のような無命名分類 → task-decomposition の Group と整合せず
- 既存実装 drift の入力経路がなく、drift 修正タスクが Sprint に組み込まれなかった

v3 では:
- **Foundation phase = Group A** を必ず最初に固定
- functional-breakdown の 4 JSON を pull して各機能に紐付け
- Group A-E を task-decomposition と共通の語彙で使う
- functional-breakdown の `legacy_drift_notes` を Group D / E 機能として分離

---

## 3-tier AC (汎用)

下流 task-decomposition で各 task が満たす必要のある acceptance criteria を 3 tier に整理する。feature-decomposition は各機能の `vertical_slice_components` がこの 3 tier 全部を埋められるよう設計責任を持つ。

| Tier | 内容 | feature-decomposition で担保するもの |
|---|---|---|
| **Structural** | mock / spec / impl の構造一致 (画面 ↔ component / API ↔ router 実在性 / entity ↔ table 命名) | screen_ids / api_endpoints / entity_ids が functional-breakdown と 1:1 対応 |
| **Functional** | 業務ロジックの正しさ (EARS 形式 AC) | ears_ac_seed (機能の仕様 AC ドラフト) を必須付与 |
| **Regression** | 既存機能を壊さない / lint / 型 / coverage | vertical_slice_components.tests が空でない / CI gate 適合チェック |

---

## Foundation → Backend → UI フロー

```
Group A: Foundation phase
  ├─ CI/CD pipeline (lint / format / type check / coverage gate)
  ├─ Test infrastructure (unit / integration / e2e)
  ├─ Access control framework (RLS / RBAC / policy enforcement)
  ├─ Audit / logging infrastructure
  └─ Pre-flight checklist mechanism + decision record (ADR) 起票

   ↓ Foundation gate passes (機械判定 OK で Backend 解禁)

Group B: Backend phase (per slice / per feature)
  ├─ Data layer (entity / migration / access-control policy)
  ├─ Service layer (business logic)
  ├─ API layer (REST / GraphQL / gRPC) + OpenAPI / IDL
  ├─ Contract test (consumer-driven)
  └─ Backend integration test (access-control matrix / business logic E2E)

   ↓ Backend gate passes

Group C: UI phase (per slice / per feature)
  ├─ Component implementation (against spec / against mock)
  ├─ State management (data fetching / cache)
  ├─ UI integration test (visual regression / interaction)
  └─ Accessibility check

   ↓ UI gate passes

Group D: Integration test phase (cross-cutting)
  ├─ E2E across slices
  ├─ Drift detection (spec / mock / impl 3-way)
  └─ Cross-feature regression

Group E: Drift fix / Polish phase (cross-cutting)
  ├─ Performance optimization
  ├─ Security audit
  ├─ Documentation
  ├─ legacy 整理 / 命名統一 / cleanup
  └─ Release readiness
```

**重要**: Vertical Slice 内も `entities → service → API → tests → screens` の Backend → UI 順序を維持する。UI 先行で API 未定 / data layer 未定だと並列開発が崩壊する。

---

## Group A-E 分類 (task-decomposition と共通)

| Code | 内容 | Phase (project-defined naming) |
|---|---|---|
| **A** | Foundation (CI/CD pipeline / lint / type check / coverage gate / 3-tier AC validator / access-control framework / audit infra / pre-flight mechanism / ADR) | Foundation phase |
| **B** | Backend (data layer / service / API / contract test / backend integration test) | Backend phase |
| **C** | UI (component / state management / UI integration test / accessibility) | UI phase |
| **D** | Integration test (E2E across slices / drift detection / cross-feature regression) | Integration phase |
| **E** | Drift fix / Polish (refactor / performance / security / docs / cleanup / 命名 migration) | Polish phase |

新規プロジェクトで Group A-E を再利用する場合:
- **Group A (Foundation) は必須** = 最初に必ず完成
- B-E は対象プロジェクトに合わせて内容を置き換え可
- 不要 Group は空にして良いが、code は埋める (連番が崩れない方が下流 task-decomposition で扱いやすい)
- プロジェクト固有事情で 5 group を細分化する場合 (例: Backend を B-1/B-2、Polish を F/G/H/I/J など) は profile (`references/profiles/<project>.md`) に細分化マッピングを定義する

---

## Vertical Slice の定義

v3 では「1 機能 = 画面 + API + test + access-control + resume + error の bundle」を default とする。

```json
{
  "id": "F-V3-AUTH",
  "name": "認証",
  "vertical_slice_components": {
    "entities": ["E-001 User", "E-038 AuthSession"],
    "api_endpoints": [
      "POST /api/auth/login",
      "POST /api/auth/logout",
      "POST /api/auth/signup",
      "POST /api/auth/password-reset",
      "POST /api/auth/mfa/enroll",
      "POST /api/auth/mfa/verify"
    ],
    "access_control_policies": ["auth_sessions:user_own_select", "users:self_select", "users:self_update"],
    "tests": ["e2e/auth/login.spec.ts", "backend/tests/test_auth_*.py"],
    "middleware": ["require_auth", "rate_limit"],
    "resume": {
      "interruption_points": ["signup ウィザード途中離脱", "mfa 登録中の離脱"],
      "pending_state": ["users.status=pending_verification", "AuthSession 未確立"],
      "resume_path": "再開 URL から続きのステップへ",
      "idempotency_key": "signup_request_id",
      "pending_ttl": "24h で pending user を失効"
    },
    "error": {
      "ui": ["invalid_credentials メッセージ", "rate_limit 時のリトライ抑止表示"],
      "api": ["401 invalid_credentials", "409 conflict", "429 rate_limited", "5xx"],
      "data": ["signup 失敗時に user/session を残さない (tx ロールバック)"],
      "recovery": ["MFA SaaS ダウン時のフォールバック導線", "失敗→停止→再試行"]
    },
    "screens": ["S-001 login", "S-002 signup", "S-003 password_reset", "S-004 mfa_setup"]
  }
}
```

**順序の意図**: entities → api_endpoints → access_control_policies → tests → middleware → **resume → error** → screens (Backend → UI)。 resume と error は Backend 側の振る舞いを規定するため screens の前に置く。

Vertical Slice の利点:
- 1 機能を 1 並列セッション (= 1 PR) で完結できる
- structural + functional + regression の 3-tier AC を 1 commit で満たせる
- レイヤー間 (FE/BE/DB) の境界で wait が発生しない

例外 (Vertical Slice にしない場合):
- Group A (Foundation) : 単独 task
- Group B 内の DB schema migration: 1 entity = 1 task (migration 番号で順序保証)
- Group E の cleanup / rename: 単独 task

### resume / error 必須コンポーネント (横断A / 横断B)

Vertical Slice の構成要素には、 happy path のコンポーネント (entities / api / screens 等) に加えて、 以下 2 つを **必須コンポーネント**として扱う:

| コンポーネント | 必須条件 | 何を防ぐか |
|---|---|---|
| **resume (中断・再開)** | 多ステップ / 状態遷移を伴う機能 (登録・決済・本人確認・申込・問い合わせ・ウィザード・長時間処理・外部リダイレクト) で必須。`interruption_points / pending_state / resume_path / idempotency_key / pending_ttl` を埋める | 途中離脱したユーザーが再開できない / 二重決済 / pending 放置 |
| **error (異常系・復旧)** | 全機能で必須。`ui / api / data / recovery` の 4 レイヤーを埋める | エラーで画面が固まる / 4xx・5xx 未定義 / 中途半端なデータ書き込み / 外部依存ダウンで全停止 |

- 中断概念の無い単一ステップ機能は `resume: null` で良いが、 多ステップ機能で `null` のまま起票するのは **設計失敗**。
- error は全機能で空にできない (片方でも欠けると happy path 起票とみなす)。`api.outputs_4xx` が空は禁止。
- 規模により «各機能の slice 内に内包» か «横断的な resume/error 基盤を Group A/B の独立機能化» かを選ぶ。共通基盤 (idempotency store / 共通エラーハンドラ / retry / circuit breaker / pending 失効バッチ) は Foundation/Backend 側に置き、 各機能はそこに depends_on する。

---

## Wave 並列実行 (project-defined parallel capacity)

- **Sprint** = 経営/PM 視点の集約単位 (1-2 週間相当)
- **Wave** = 並列セッション視点の execution 単位 (1 wave = N parallel × 2-4h)
- **Phase** = リリース判定の境界 (project-defined naming, e.g., dogfood / public release / cleanup)
- **N (parallel capacity)** = project-defined。例: 10 / 30-50 / 100+

```
Foundation phase ─ Sprint 0 ─ Wave 0 ─ Group A
                                ↓ (gate 整備完了 → 後続解禁)
Backend phase ───── Sprint 1 ─ Wave 1 ─ Group B
UI phase ────────── Sprint 1 ─ Wave 2 ─ Group C
Integration phase ─ Sprint 2 ─ Wave 3 ─ Group D
Polish phase ────── Sprint 3 ─ Wave 4-N ─ Group E
```

各 Wave 内も backend-first → UI-second の順序を維持する。

---

## file-level mutex / work-package boundary

並列セッションが同じ file を編集すると merge conflict になる。feature-decomposition では各機能の `vertical_slice_components` が「他機能と被らない file scope」になるよう設計する:

- entity 1 つ = 1 機能 (entity ↔ table ↔ migration の 1:1 boundary)
- API endpoint group = 1 機能 (router file ↔ service file の boundary)
- screen 1 つ = 1 機能 (frontend page file の boundary)

下流 distributed-dev / integration スキルが file mutex を運用する。feature-decomposition は **boundary 設計** が主責任。

---

## pre-flight audit MD

各機能 → task に展開された後、着手前に audit MD で「想定どおりの修正範囲か / drift 発生しないか」を 1 ファイルで確認する mechanism。feature-decomposition では各機能の `pre_flight_template_path` (任意) を指定して、下流 task が audit MD を生成しやすくする。

---

## CI gate auto-merge (project-defined gate set)

各機能は task-decomposition で細分化された後、project-defined CI gate 全 pass で自動 merge される。代表的な gate:

| 例 Gate | 検出する漏れ |
|---|---|
| mock lint (rule_id 群) | 絵文字 / ライセンス違反 / mock-impl diff / API 実在性 / table 命名 |
| 3-tier AC validator | AC 形式違反 / EARS 違反 |
| audit MD validator | generic 文言 / 不在 |
| access-control coverage | RLS / RBAC policy 不足 |
| test coverage (≥ threshold) | unit test 失敗 / カバレッジ不足 |
| backend type check (strict) | Python / Java / Go 型エラー |
| frontend type check (strict) | TypeScript 型エラー |
| mock-impl diff | structural mismatch |

具体的な gate 集合と数 (例: 5 / 8 / 12) はプロジェクト固有 — profile に列挙。feature-decomposition は **各機能の `vertical_slice_components` がプロジェクトで定義された CI gate 全件を満たす設計になっているか** を検証する。例えば:
- `screens` が空 → mock-impl diff gate は不要
- `entities` が空 → access-control coverage gate は不要
- `tests` が空 → test coverage 不可 → **設計失敗**

---

## Phase gate 機械判定

各 phase の完了は **mechanical / observable な tool** で判定する (人間判断ではない):

| Phase | 機械判定の例 |
|---|---|
| Foundation gate pass | CI pipeline 構築完了 (1st green run) + lint runner exists + AC validator exists + ADR file exists |
| Backend gate pass | 全 Backend feature の PR auto-merged + access-control coverage 100% + API contract test pass |
| UI gate pass | 全 UI feature の PR auto-merged + mock-impl diff 0 + accessibility check pass |
| Integration gate pass | E2E suite 全 pass + drift detection 0 |
| Polish gate pass | release readiness checklist 全 ✅ |

下流 integration スキルが Phase gate 判定の責任を持つ。feature-decomposition は **各機能を正しい phase に配置** する責任。

---

## 機能オブジェクトの v3 拡張フィールド

```json
{
  "id": "F-V3-XXX",
  "name": "機能名",
  "category": "auth | payment | crud | notification | search | admin | infra | cleanup",
  "group": "A | B | C | D | E (or project-defined sub-group)",
  "phase": "Foundation | Backend | UI | Integration | Polish (project-defined naming)",
  "sprint": 0 | 1 | 2 | 3,
  "wave": 0 | 1 | 2 | ...,

  // 既存フィールド
  "role": "...",
  "input": [...],
  "output": [...],
  "dependencies": ["F-V3-YYY"],
  "independence": "high | medium | low",
  "difficulty": "easy | medium | hard",
  "estimated_days": 2,
  "risk": "...",

  // v3 新規: functional-breakdown の 4 JSON から pull
  "screen_ids": ["S-001", "S-002"],
  "entity_ids": ["E-001 User"],
  "api_endpoints": [
    {"method": "POST", "path": "/api/auth/login", "auth": "public"}
  ],
  "access_control_policies": ["users:self_select"],
  "ears_ac_seed": [
    "EVENT-DRIVEN: When POST /api/auth/login is called ..."
  ],

  // v3 新規: 横断A 中断・再開 (多ステップ / 状態遷移機能は必須 / それ以外は null)
  "resume_handling": null | {
    "interruption_points": [...],
    "pending_state": [...],
    "resume_path": "...",
    "idempotency_key": "...",
    "pending_ttl": "..."
  },
  "resume_feature_ref": null,

  // v3 新規: 横断B 異常系・エラー (4 レイヤー / 全機能必須 / 空禁止)
  "error_handling": {
    "ui": [...],
    "api": [...],
    "data": [...],
    "recovery": [...]
  },

  // v3 新規: Vertical Slice 定義 (Backend → UI 順序 / resume・error を screens の前に含む)
  "vertical_slice_components": {
    "entities": [...],
    "api_endpoints": [...],
    "access_control_policies": [...],
    "tests": [...],
    "middleware": [...],
    "resume": null | {...},
    "error": {...},
    "screens": [...]
  },

  // v3 新規: drift 入力 (functional-breakdown の legacy_drift_notes が source)
  "drift_origin": null | {
    "source_screen_id": "S-006",
    "diff_severity": "high",
    "recommendation": "..."
  }
}
```

---

## 入力 (上流 skill から pull する内容)

STEP 1 で functional-breakdown の 4 JSON path を確認し、pull する:

```
## 入力情報の確認
- functional-breakdown 出力: <project-defined output dir>
  - screens.json: N 件
  - features.json: N 件
  - roles.json: R 件
  - entities.json: E 件
  - (任意) addendum.json: 0 or N 件
- drift 検知出力 (legacy_drift_notes): N 件 → Group D / E 機能候補
```

各機能の v3 拡張フィールドは functional-breakdown 出力から **逐語コピー** する:
- `screen_ids` ← screens.json の id
- `entity_ids` ← entities.json の id
- `api_endpoints` ← features.json の api_endpoints[]
- `access_control_policies` ← entities.json の access_control_policies[].name
- `ears_ac_seed` ← features.json の ears_ac_seed[]

これにより spec ↔ feature ↔ task の 3 階層が情報的に同期する。

---

## 出力 (下流 skill に渡す内容)

feature-decomposition の出力 (機能 JSON) を task-decomposition の STEP 1 input にする:

| feature 側 | task 側 |
|---|---|
| `id` | `feature_id` (1 機能 → N task) |
| `group` | task の `group` (継承) |
| `phase / sprint / wave` | task の `phase / wave` (継承) |
| `screen_ids` | task の `screen_ids` (1 機能の screen を tasks に分散) |
| `entity_ids` | task の `entity_ids` |
| `vertical_slice_components.api_endpoints` | task の `files_changed` (backend/routers/...) |
| `vertical_slice_components.tests` | task の `files_changed` (backend/tests/...) |
| `access_control_policies` | task の `access_control_policies_required` |
| `ears_ac_seed` | task の `acceptance_criteria.functional` |
| `resume_handling` / `resume_feature_ref` | task の 中断・再開 AC + 別タスク化 (二重実行防止 / pending 失効 / 再開導線) |
| `error_handling` (4 レイヤー) | task の 異常系 AC (UI 状態出し分け / outputs_4xx / ロールバック / フォールバック) |
| `estimated_days` | task の `estimate_hours` の合計目安 (1 day ~= 6-8h) |

task-decomposition は 1 機能を **2-8h 粒度の task** に細分化する (Vertical Slice なら 1 機能 = 1 task で済むこともある)。

---

## DAG.md output (v3 新規)

STEP 5 で出力する DAG.md は以下の構造:

```markdown
# DAG / Wave Plan — <project>

## 物量
| 指標 | 値 |
|---|---|
| 総機能数 | N |
| Sprint 数 | N |
| Wave 数 | N |
| 並列度上限 | <project-defined parallel capacity> |
| 推定総工数 | N 日 |

## Sprint 構成
| Sprint | Phase | Group | 機能数 | Wave |
|---|---|---|---:|---|
| 0 | Foundation | A | N | 0 |
| 1 | Backend / UI | B / C | N | 1-2 |
| 2 | Integration | D | N | 3 |
| 3 | Polish | E | N | 4-N |

## 依存 DAG
[Wave 0] Group A 全機能 ─→ [Wave 1] Group B ─→ [Wave 2] Group C ─→ [Wave 3] Group D ─→ [Wave 4+] Group E

## 並列実行可能グループ (Wave 別)
### Wave 0 (Foundation phase)
- F-V3-INFRA-01〜NN (互いに独立)

### Wave 1 (Backend phase)
- F-V3-DB-{users/accounts/...} 等
- F-V3-API-{auth/...} 等

### Wave 2 (UI phase)
- F-V3-SCR-{login/dashboard/...} 等

...

## Risk flags (Bottleneck 候補)
| 機能 | risk | 影響範囲 | mitigation |
|---|---|---|---|
| F-V3-INFRA-03 (lint) | ブロッキング | Wave 1+ 全機能の merge gate | Foundation で必ず最優先完成 / 2 人アサイン |
```

---

## connections (汎用 / project profile で具体化)

| connection | 汎用説明 | profile で具体化 |
|---|---|---|
| 上流 functional-breakdown 出力 path | `<functional-breakdown output dir>` | `docs/functional-breakdown/<date>_v<N>/` |
| 下流 task-decomposition 出力 path | `<task-decomposition output dir>` | `docs/task-decomposition/<date>_v<N>/` |
| feature-decomposition 自身の出力 path | `<feature-decomposition output dir>` | `docs/feature-decomposition/<date>_v<N>/` |
| 並列セッション capacity | N (project-defined) | 例: 10 / 30-50 / 100+ |
| CI gate 集合 | project-defined gate set | profile に gate 列挙 |
| phase 命名 | Foundation / Backend / UI / Integration / Polish | profile で project-specific 名 (e.g., Phase 0/1/1.5/2) |

---

## 互換性

- v1 (旧 Sprint 1-N): freeze。Sprint 0-N 概念は維持 (legacy 参照のみ)
- v3 (新規出力先): Group A-E + project-defined parallel capacity Wave + Vertical Slice
- ローダー (task-decomposition) は v3 を優先 / v1 は legacy 参照のみ
