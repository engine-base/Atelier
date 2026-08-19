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

修正後 (同じシード入り DB / 該当ファイルを実行):
  tests/routes/test_outputs.py                          29 passed
  tests/routes/test_knowledge.py + test_outputs.py      59 passed
  tests/rls (GAP-172 で作り直した DB に対して)            9 passed
```

**確認できた範囲を正直に書く**: 上記は「元々落ちていた 10 件を含むファイル」を
シード入り DB で実行した結果で、10 件はすべて解消している。全件 (1081 件) の
通し実行は 20 分かかるため別途実施し、結果に差があれば追記する。
