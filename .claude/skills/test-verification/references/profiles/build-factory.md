# Build-Factory Profile (test-verification 適用例)

> このファイルは v3 test-verification スキルを Build-Factory プロジェクトに適用するための profile **例**。他プロジェクトは独自 profile を作成する。SKILL.md / v3-core.md は本 profile に依存しない。

---

## script path (placeholder → 具体 path)

| placeholder | Build-Factory 具体 path |
|---|---|
| `<lint_runner>` | `scripts/lint-mock.sh` |
| `<ac_validator>` | `scripts/validate-tickets.py` |
| `<access_control_verifier>` | `scripts/verify-rls-coverage.py` |
| `<mock_impl_diff>` | `scripts/lint-mock-impl-diff.py` |
| `<audit_md_check>` | `scripts/audit-md-check.sh` |
| `<ears_test_generator>` | `scripts/generate-tests-from-ears.py` |
| `<test_dir>` | `backend/tests/` |

---

## phase 名 mapping (Foundation/Backend/UI/Polish → BF Phase)

| 段階 | Build-Factory Phase |
|---|---|
| Foundation phase | Phase 0 (基盤整備) |
| Backend phase | Phase 1 前半 (dogfood / backend 実装) |
| UI phase | Phase 1 後半 (UI 実装) |
| Polish phase | Phase 1.5 (REFACTOR) / Phase 2 (SaaS 公開) |

---

## N CI gate (Build-Factory = 8 gate)

Build-Factory では gate 数 N = 8 を採用。各段階への割当:

| Gate # | 名前 | 段階 | tool | 失敗条件 |
|---|---|---|---|---|
| #1 | lint-mock | Foundation | `scripts/lint-mock.sh` | 19 check のいずれか violation |
| #2 | AC validator | Foundation | `scripts/validate-tickets.py` | 3-tier AC schema 違反 or EARS 形式違反 |
| #6 | pyright strict | Foundation | `pyright` | type error |
| #3 | RLS coverage | Backend | `scripts/verify-rls-coverage.py` | 4 ロール × 7 操作 マトリクス未網羅 |
| #5 | pytest cov | Backend | `pytest --cov --cov-fail-under=70` | カバレッジ < 70% or test failure |
| #7 | tsc strict | UI | `tsc --noEmit` | type error |
| #8 | mock-impl-diff | UI | `scripts/lint-mock-impl-diff.py` | mock の項目が backend response に存在しない |
| #4 | audit MD existence | Polish | `scripts/audit-md-check.sh` | 該当 task の audit MD が存在しない |

### gate-config.yml (Build-Factory 8 gate)

```yaml
name: 8 CI Gate
on: [pull_request]

jobs:
  gate-1-lint-mock:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash scripts/lint-mock.sh

  gate-2-ac-validator:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python3 scripts/validate-tickets.py

  gate-3-rls-coverage:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
    steps:
      - uses: actions/checkout@v4
      - run: python3 scripts/verify-rls-coverage.py

  gate-4-audit-md:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash scripts/audit-md-check.sh

  gate-5-pytest-cov:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pytest --cov --cov-fail-under=70

  gate-6-pyright:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pyright

  gate-7-tsc:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: tsc --noEmit

  gate-8-mock-impl-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python3 scripts/lint-mock-impl-diff.py

  auto-merge:
    needs: [gate-1-lint-mock, gate-2-ac-validator, gate-3-rls-coverage, gate-4-audit-md, gate-5-pytest-cov, gate-6-pyright, gate-7-tsc, gate-8-mock-impl-diff]
    runs-on: ubuntu-latest
    steps:
      - name: Auto-merge PR
        run: gh pr merge --auto --squash
```

---

## Access control roles (Build-Factory = 4 ロール)

Build-Factory では以下 4 ロールを採用:

- `owner` — workspace 所有者
- `admin` — workspace 管理者
- `member` — 一般メンバー
- `guest` — 限定アクセスユーザー (assigned レコードのみ参照)

---

## Access control operations (Build-Factory = 7 操作)

Supabase RLS policy で検証する 7 操作:

1. SELECT own
2. SELECT others
3. INSERT
4. UPDATE own
5. UPDATE others
6. DELETE own
7. DELETE others

---

## RLS マトリクス (4 ロール × 7 操作 = 28 case / entity)

| ロール | SELECT own | SELECT others | INSERT | UPDATE own | UPDATE others | DELETE own | DELETE others |
|---|---|---|---|---|---|---|---|
| owner | OK | OK | OK | OK | OK | OK | OK |
| admin | OK | OK | OK | OK | OK | OK | OK |
| member | OK | NG | OK | OK | NG | OK | NG |
| guest | OK (assigned only) | NG | NG | NG | NG | NG | NG |

各 entity (E-001 User / E-002 Workspace 等) × 4 ロール × 7 操作 = 28 test case (entity 1 件あたり)。

```python
@pytest.mark.parametrize("role,operation,expected", [
    ("owner", "select_own", "OK"),
    ("owner", "select_others", "OK"),
    ("member", "select_others", "NG"),
    ("member", "delete_others", "NG"),
    # ...
])
def test_rls_<entity>_role_matrix(role, operation, expected):
    # ...
```

### gate #3 (RLS coverage) 実行コマンド

```bash
python3 scripts/verify-rls-coverage.py \
  --entities docs/functional-breakdown/<date>_v3/entities.json \
  --roles docs/functional-breakdown/<date>_v3/roles.json \
  --tests backend/tests/rls/
```

---

## Coverage 閾値

- **全体**: 70% (gate #5 = `pytest --cov --cov-fail-under=70`)
- **ビジネスロジック / 認証 / データ操作**: 80% 推奨
- **ユーティリティ / 型変換**: 60% 推奨

---

## 連続失敗エスカレーション

- 連続 **3 失敗** で human エスカ
- 通知先: Slack (#engineering) + メール (masato@engine-base.com)

---

## EARS 自動生成 script 実行例

```bash
python3 scripts/generate-tests-from-ears.py \
  --ears-ac-seed docs/api-design/2026-05-15_v3/ears-ac-seed.json \
  --output backend/tests/generated/ \
  --framework pytest
```

出力例:
```
backend/tests/generated/
├── test_auth_login.py
├── test_auth_logout.py
├── test_auth_signup.py
└── test_auth_mfa_verify.py
```

各 file に `ears_ac_id` コメントで AC 由来を記録 (lint #19 で逆引き検証)。

---

## technology stack (Build-Factory)

- **access control**: Supabase RLS (Postgres Row-Level Security)
- **DB**: Postgres 15 + pgvector + pg_trgm
- **backend test**: pytest + pytest-cov + pytest-asyncio
- **frontend test**: Vitest + Playwright
- **contract test**: Schemathesis (OpenAPI fuzz) + Pact (consumer/provider)
- **type check**: pyright (strict) + tsc (strict)
- **CI**: GitHub Actions

---

## 数値例

- screens: 43
- tasks: 187
- backend tests: 8000+
- gate 数: 8

---

## lint rule mapping

- lint #17 = mock-impl-diff
- lint #18 = screens-API
- lint #19 = entity-table-naming

---

## 固有名詞

- project name: Build-Factory
- company: ENGINE BASE
- responsible person: 高本まさと

---

## ears-test-mapping.json (Build-Factory 例)

```json
{
  "version": "v3",
  "skill": "test-verification",
  "project": "build-factory",
  "mappings": [
    {
      "ears_ac_id": "F-001-AC-01",
      "ears_form": "EVENT-DRIVEN",
      "ears_text": "When POST /api/auth/login is called with valid email+password, the system shall return 200 with { access_token, refresh_token, user_id }.",
      "test_id": "TC-001",
      "test_file": "backend/tests/generated/test_auth_login.py",
      "test_function": "test_auth_login_valid_credentials",
      "test_level": "unit+contract",
      "gate": "gate-5-pytest-cov"
    },
    {
      "ears_ac_id": "F-001-AC-02",
      "ears_form": "UNWANTED",
      "ears_text": "If credentials are invalid, the system shall return 401 with generic message (no user enumeration).",
      "test_id": "TC-002",
      "test_file": "backend/tests/generated/test_auth_login.py",
      "test_function": "test_auth_login_invalid_credentials_rejected",
      "test_level": "unit+contract",
      "gate": "gate-5-pytest-cov"
    }
  ]
}
```
