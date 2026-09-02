# v3 Core Concepts — test-verification

> 2026-05-15 v3 から、test-verification は **3-tier AC を test レベルに 1:1 マッピング** + **EARS AC から test 自動生成** + **N CI gate (project-defined) を Foundation → Backend → UI → Polish の段階で構成** + **Access control role × operation matrix** + **Schemathesis/Pact contract test** を組み込む。

このドキュメントは **完全に汎用** で、特定プロジェクトを前提としない。プロジェクト固有値 (script path / role 名 / operation 名 / coverage 閾値 / gate 数) は `references/profiles/<project>.md` で注入する。

---

## なぜ v3 拡張が必要か (汎用)

v1 / v2 では:
- 「リスク高い箇所を重点的に」の方針で test 配分を決めるため、AC との対応が手作業
- EARS 形式 AC があっても test に翻訳する手順が定義されていない
- access control policy が test 漏れ (role × operation × OK/NG マトリクスが網羅されない)
- mock ↔ 実装の drift が CI で検出されないため、並列実装中に drift が蓄積
- 「CI が green」と「全 gate 全 pass」の差分が言語化されていない

v3 では:
- **task-decomposition の 3-tier AC (structural/functional/regression) を test レベルに直接マッピング**
- **EARS AC から自動的に test case 生成** (EVENT-DRIVEN → 正常系 / UNWANTED → 異常系)
- **N CI gate (project-defined, e.g., 5-10) を 4 段階で構成** し、Auto-merge の判定基準を統一
- **access-control verifier** で role × operation × OK/NG マトリクスを必ずカバー
- **Schemathesis (OpenAPI fuzz) + Pact** で frontend ↔ backend contract を回帰検証

---

## 入力 (上流出力 pull)

### task-decomposition 出力
- `tickets.json` — 全 task の 3-tier AC
  - `structural` (mock/spec 一致) → test レベル: mock-impl drift lint
  - `functional` (EARS API/access-control) → test レベル: unit + contract + integration
  - `regression` (test/lint/type/coverage) → test レベル: CI gate 自動化

### api-design 出力
- `openapi.yaml` — Schemathesis input
- `ears-ac-seed.json` — EARS AC → test case 変換ソース
- `lint-mapping.json` — mock ↔ API の lint 検証対象

### functional-breakdown 出力
- `entities.json` — access control policy 定義 (role × operation)
- `roles.json` — project-defined roles (e.g., 3-10 roles)

### architecture-design 出力
- `foundation_gates.json` — N CI gate 定義 (project-defined)

---

## 3-tier AC ↔ test レベル 1:1 マッピング (汎用)

| 3-tier AC | test レベル | tool (汎用名) | gate 段階 |
|---|---|---|---|
| **structural** (mock/spec 一致) | mock-impl drift lint | `<mock_impl_diff>` | UI gate |
| **functional.api** (EARS EVENT-DRIVEN / UNWANTED) | unit test + contract test | pytest/vitest + Schemathesis | Backend gate |
| **functional.access_control** (role × operation × OK/NG) | access-control test | `<access_control_verifier>` | Backend gate |
| **functional.acceptance** (E2E ユーザーフロー) | E2E (Playwright/Cypress) | Playwright/Cypress | UI gate |
| **regression.coverage** (project-defined threshold) | coverage check | coverage tool | Backend gate |
| **regression.lint** (lint rules) | mock-lint + AC validator | `<lint_runner>` + `<ac_validator>` | Foundation gate |
| **regression.type** (strict type check) | type check | pyright / tsc / mypy | Foundation gate |
| **regression.audit** (audit MD existence) | audit MD lint | `<audit_md_check>` | Polish gate |

---

## Foundation → Backend → UI → Polish 段階構成 (汎用)

```
Foundation gate
  ├─ lint / format
  ├─ AC validator (3-tier AC schema + EARS form)
  └─ type check (strict)
        ↓ pass
Backend gate
  ├─ access-control coverage (role × operation matrix)
  ├─ API contract test (Schemathesis / Pact verify)
  └─ coverage threshold (project-defined, e.g., 70-90%)
        ↓ pass
UI gate
  ├─ tsc strict
  ├─ mock-impl drift lint
  └─ visual regression (任意)
        ↓ pass
Polish gate
  ├─ audit MD existence
  ├─ perf budget (任意)
  └─ security scan (任意)
        ↓ pass
auto-merge
```

各段階の不合格は下流段階を skip させる (block 関係)。これにより CI 時間と料金を最小化しつつ、根本問題から順に解決する。

---

## EARS AC → test case 自動生成 (汎用)

### 変換ルール

```
EVENT-DRIVEN: When [event], the system shall [expected].
  ↓
def test_<endpoint>_<event_short>():
    # Arrange: setup [event] preconditions
    # Act: trigger [event]
    response = client.<method>(<path>, ...)
    # Assert: [expected]
    assert response.status_code == <2xx>
    assert response.json() == <expected_body>
```

```
UNWANTED: If [condition], the system shall [reject].
  ↓
def test_<endpoint>_<condition_short>_rejected():
    # Arrange: setup [condition]
    # Act: trigger
    response = client.<method>(<path>, ...)
    # Assert: rejection
    assert response.status_code == <4xx>
    assert response.json()["error"] == "<code>"
```

```
STATE-DRIVEN: While [state], the system shall [behavior].
  ↓
@pytest.mark.parametrize("state", [True, False])
def test_<endpoint>_state_<state>():
    # Arrange: set state
    # Act + Assert: behavior differs by state
```

### 自動生成 script (汎用 placeholder)

```bash
<ears_test_generator> \
  --ears-ac-seed docs/api-design/<date>_v3/ears-ac-seed.json \
  --output <test_dir>/generated/ \
  --framework pytest
```

出力例:
```
<test_dir>/generated/
├── test_auth_login.py
├── test_auth_logout.py
├── test_auth_signup.py
└── test_auth_mfa_verify.py
```

各 file に `ears_ac_id` コメントで AC 由来を記録 (lint で逆引き検証)。

---

## Access control matrix test (role × operation, 汎用)

### マトリクス定義 (汎用)

- **role 数**: project-defined (e.g., 3-10 roles)
- **operation 数**: project-defined (e.g., 5-8 operations)
- 一般的な operation 例: `SELECT own / SELECT others / INSERT / UPDATE own / UPDATE others / DELETE own / DELETE others` (RBAC) や `read / create / update / delete / approve / reject` (workflow) など
- **期待値**: OK / NG (project-defined matrix)

### 構造例 (role 名・operation 名は profile に書く)

| role        | op_1 | op_2 | op_3 | op_4 | ... |
|-------------|------|------|------|------|-----|
| <role_a>    | OK   | OK   | OK   | OK   | ... |
| <role_b>    | OK   | OK   | OK   | OK   | ... |
| <role_c>    | OK   | NG   | OK   | OK   | ... |
| <role_d>    | OK   | NG   | NG   | NG   | ... |

### テスト生成

各 entity × role 数 × operation 数 = entity 1 件あたりの test case 数

```python
@pytest.mark.parametrize("role,operation,expected", [
    ("<role_a>", "<op_select_own>", "OK"),
    ("<role_a>", "<op_select_others>", "OK"),
    ("<role_c>", "<op_select_others>", "NG"),
    ("<role_c>", "<op_delete_others>", "NG"),
    # ...
])
def test_access_control_<entity>_role_matrix(role, operation, expected):
    # ...
```

### CI gate (Backend gate 内)

```bash
<access_control_verifier> \
  --entities docs/functional-breakdown/<date>_v3/entities.json \
  --roles docs/functional-breakdown/<date>_v3/roles.json \
  --tests <test_dir>/access_control/
```

検証内容:
- entities.json の policies が全 test に登場するか
- role × operation マトリクスが全 entity でカバーされているか
- expected 値 (OK/NG) が roles.json と一致するか

> **注**: 行レベルアクセス制御 (RLS) を採用するシステム (例: Postgres RLS, Supabase) では、policy 自体を DB に書く。RBAC のみの実装ではアプリ層で検証する。verifier はどちらにも対応する設計とする。

---

## N CI gate 仕様 (Foundation/Backend/UI/Polish 段階構成, 汎用)

> gate 数 N と各 gate の具体名・script path は project-defined。下表は段階構成の例。

| 段階 | Gate 名 (例) | tool (汎用 placeholder) | 失敗条件 |
|---|---|---|---|
| Foundation | lint / format | `<lint_runner>` | lint rule violation |
| Foundation | AC validator | `<ac_validator>` | 3-tier AC schema 違反 or EARS 形式違反 |
| Foundation | type check | pyright / tsc / mypy | type error |
| Backend | access-control coverage | `<access_control_verifier>` | role × operation matrix 未網羅 |
| Backend | API contract | Schemathesis (+ Pact verify) | contract violation |
| Backend | coverage | coverage tool | カバレッジ < project-defined or test failure |
| UI | tsc strict | tsc --noEmit | type error |
| UI | mock-impl drift | `<mock_impl_diff>` | mock の項目が backend response に存在しない |
| UI | visual regression (任意) | Playwright/Chromatic | snapshot diff |
| Polish | audit MD existence | `<audit_md_check>` | 該当 task の audit MD が存在しない |
| Polish | perf budget (任意) | Lighthouse / k6 | budget violation |
| Polish | security scan (任意) | npm audit / pip-audit / Snyk | high/critical vuln |

### gate-config.yml (汎用 placeholder 構成)

```yaml
name: N CI Gate (Foundation -> Backend -> UI -> Polish)
on: [pull_request]

jobs:
  # ----- Foundation gate -----
  foundation-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash <lint_runner>

  foundation-ac-validator:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python3 <ac_validator>

  foundation-type-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pyright

  # ----- Backend gate -----
  backend-access-control-coverage:
    needs: [foundation-lint, foundation-ac-validator, foundation-type-check]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python3 <access_control_verifier>

  backend-contract-test:
    needs: [foundation-lint, foundation-ac-validator, foundation-type-check]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: schemathesis run docs/api-design/openapi.yaml --base-url http://localhost:8000

  backend-coverage:
    needs: [foundation-lint, foundation-ac-validator, foundation-type-check]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pytest --cov --cov-fail-under=<project-defined-threshold>

  # ----- UI gate -----
  ui-tsc:
    needs: [backend-access-control-coverage, backend-contract-test, backend-coverage]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: tsc --noEmit

  ui-mock-impl-diff:
    needs: [backend-access-control-coverage, backend-contract-test, backend-coverage]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python3 <mock_impl_diff>

  # ----- Polish gate -----
  polish-audit-md:
    needs: [ui-tsc, ui-mock-impl-diff]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash <audit_md_check>

  # ----- auto-merge -----
  auto-merge:
    needs: [polish-audit-md]
    runs-on: ubuntu-latest
    steps:
      - name: Auto-merge PR
        run: gh pr merge --auto --squash
```

---

## Contract test (Schemathesis + Pact, 汎用)

### Schemathesis (OpenAPI → fuzz)

api-design 出力の `openapi.yaml` を入力に property-based test を自動生成:

```bash
schemathesis run openapi.yaml \
  --base-url http://localhost:8000 \
  --checks all \
  --hypothesis-database :memory:
```

### Pact (frontend ↔ backend contract)

- frontend が consumer pact を生成 → broker に push
- backend (provider) が pact verify CI で検証
- contract 違反は Backend gate で fail

---

## ears-test-mapping.json (v3 新規出力)

```json
{
  "version": "v3",
  "skill": "test-verification",
  "mappings": [
    {
      "ears_ac_id": "F-001-AC-01",
      "ears_form": "EVENT-DRIVEN",
      "ears_text": "When POST /api/auth/login is called with valid email+password, the system shall return 200 with { access_token, refresh_token, user_id }.",
      "test_id": "TC-001",
      "test_file": "<test_dir>/generated/test_auth_login.py",
      "test_function": "test_auth_login_valid_credentials",
      "test_level": "unit+contract",
      "gate": "backend-coverage"
    },
    {
      "ears_ac_id": "F-001-AC-02",
      "ears_form": "UNWANTED",
      "ears_text": "If credentials are invalid, the system shall return 401 with generic message (no user enumeration).",
      "test_id": "TC-002",
      "test_file": "<test_dir>/generated/test_auth_login.py",
      "test_function": "test_auth_login_invalid_credentials_rejected",
      "test_level": "unit+contract",
      "gate": "backend-coverage"
    }
  ]
}
```

---

## connections (連携先, 汎用)

| 上流 | このスキルが受け取る情報 |
|---|---|
| **task-decomposition** | tickets.json (3-tier AC) |
| **api-design** | openapi.yaml / ears-ac-seed.json / lint-mapping.json |
| **functional-breakdown** | entities.json (access control policy) / roles.json |
| **architecture-design** | foundation_gates.json (N gate 定義) |

| 下流 | このスキルが供給する情報 |
|---|---|
| **distributed-dev** | gate-config.yml → ブランチ実装パッケージに含める |
| **integration** | N CI gate auto-merge 仕様 |
| **CI runner** | gate-config.yml をそのまま使用 |

---

## 互換性

- v1: freeze
- v3 (新出力): 3-tier AC マッピング + EARS 自動生成 + N CI gate 段階構成 + access-control matrix + Schemathesis/Pact 必須

---

## プロジェクト固有値の注入

実プロジェクトでは以下を `references/profiles/<project>.md` で定義する:

- `<lint_runner>`: lint 実行 script の path
- `<ac_validator>`: AC schema validator script の path
- `<access_control_verifier>`: access-control matrix verifier script の path
- `<mock_impl_diff>`: mock ↔ 実装 drift lint script の path
- `<audit_md_check>`: audit MD existence check script の path
- `<ears_test_generator>`: EARS AC → test case 自動生成 script の path
- `<test_dir>`: test 配置 directory の path
- role 名一覧 (e.g., owner / admin / member / guest)
- operation 名一覧 (e.g., SELECT own / SELECT others / INSERT / UPDATE own / UPDATE others / DELETE own / DELETE others)
- coverage 閾値 (e.g., 70 / 80 / 90)
- gate 数 N と各 gate の具体名
- 連続失敗数 (e.g., 3) と human エスカ通知先

profile は **例** であり、必須ではない。プロジェクトごとに自由に書く。
