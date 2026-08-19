# GAP-173: テストが「運営シードの入っていない DB」でしか通らなかった

API の全件テストを **運営シード適用済みの DB** (= 本番や開発機に近い状態) に対して
走らせると 8 件が落ちる。落ち方はどれも同じで、テスト自身が

```
insert into public.ai_employees (..., name, ...) values (..., 'steve', ...)
→ duplicate key value violates unique constraint "ai_employees_workspace_id_name_key"
```

**フィクスチャの段階で**死ぬ。CI はシードを入れない使い捨て Postgres を使うので
通ってしまい、**実 DB に近いほど落ちる**という逆転が起きていた。

## 原因

`workspaces` には運営シードの AI 社員テンプレを実体化するトリガ
(`workspaces_bootstrap_ai_employees`) が付いている。ワークスペースを作った時点で
jarvis / tony / natasha / steve / peter / strange / wanda / thor … が既に居るので、
テストが同じ名前で insert すると一意制約に当たる。

## 修正

- `tests/routes/_fixtures.py` に `ensure_ai_employee()` を追加。
  「その名前の社員が居ることを保証し、**実際の id を返す**」形に統一した
  (既に居ればその行を使う。`on conflict (workspace_id, name) do update … returning id`)。
- 固定名 (`steve` / `tony` / `jarvis` / `wanda`) を直接 insert していた
  **9 か所すべて**を置き換えた:
  `test_outputs.py` (5) / `test_knowledge.py` / `test_ai_employees.py` /
  `test_chat.py` / `test_flow.py` / `test_mock_generate.py` / `test_skills.py`
- ランダム名を使っていた箇所 (`emp-xxxxxx` 等) は元から衝突しないのでそのまま。

## 実測

```
修正前 (シード入り DB での全件):  10 failed / 1070 passed / 1 skipped
  - 8 件 … ai_employees 一意制約 (このフィクスチャ問題)
  - 2 件 … RLS ロール設定 (GAP-172 で別途修正済み)

修正後 (同じシード入り DB での全件):  1082 passed / 1 skipped / 0 failed
```

**シード入りの実 DB に対して API 全件がグリーンになったのはこれが初めて。**
(内訳: 8 件は本 GAP のフィクスチャ修正、2 件は GAP-172 の DB 構築修正で解消)
全件実行のログは `full-run.txt`。
