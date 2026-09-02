# CI 10 gate の各 AC と実体実装ガイド

`v3-gate.yml` で実装すべき 10 gate の仕様と実体実装のガイド。
soft-pass / notice 逃げ禁止。

| # | gate | 検証内容 | 実体実装 |
|---|---|---|---|
| 1 | lint | ESLint + Prettier + ruff (check + format) | `pnpm -r --if-present run lint` + `ruff check . && ruff format --check .` |
| 2 | 3-tier AC validator | tickets.json 完全性 | `./09_dispatch/scripts/validate.sh` |
| 3 | type check | tsc strict + pyright strict、touched 0-error | tsc + pyright --outputjson + touched filter (python) |
| 4 | coverage | touched files 80% | vitest --coverage で json-summary → filter / pytest --cov + diff-cover |
| 5 | endpoint-existence | openapi.yaml ↔ FastAPI route drift | openapi.yaml parse + apps/api/src の @router decorator grep |
| 6 | mock-impl diff | 06_mockups ↔ apps/web 構造整合 | mockup HTML 数 vs apps/web/app/**/page.tsx 数 |
| 7 | type drift | openapi-typescript で再生成 ↔ types.ts diff | npx openapi-typescript → normalize → shasum 比較 |
| 8 | Schemathesis | uvicorn boot + 実装済 endpoint で contract test | schemathesis run --include-path-regex 実装済 path |
| 9 | screen-API coverage | mock-contract-hints × openapi 100% 突合 | python script で mapping 検証 |
| 10 | RLS isolation | migrations 全 table に RLS+policy 必須 | SQL parse で CREATE TABLE / POLICY / ENABLE RLS をカウント |

## aggregate-status job

10 gate 全てを `needs:` に列挙し、`if: always()` + result aggregation で
1 つでも failure/cancelled なら exit 1 で集約 fail。

## auto-merge + retry × 3

`auto-merge.yml` で `workflow_run` event を捕捉:
- `success` → `gh pr merge --squash --auto`
- `failure` → retry (10s/30s/60s backoff)
  - retry 回数を `gh api repos/.../actions/runs?head_sha=...` でカウント
  - 4 回目で S-E01 escalation issue 自動起票

## 違反検出 (前回までの典型ミス)

- Gate #5 で `INFRA_EXEMPT` リスト (health/metrics/ready) を作らないと
  /health を openapi.yaml に書かない場合に drift 判定される
- Gate #4 vitest が node_modules 配下を拾うなら `**/node_modules/**` glob exclude が必要
- Gate #3 pyright が touched filter なしだと全 file の error を投げる
- Gate #4 pytest を起動する条件で `find apps/api -mindepth 2 -name tests` は depth 1 の
  apps/api/tests を見逃す → `[ -d apps/api/tests ]` 直接 check すべき
