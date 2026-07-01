# Atelier テスト仕様書（human-grade-qa test-plan 成果物）

- `test-specs/screens/*.md` … 画面別テスト項目（9列・26画面・計393 TC）。**正本（single source）**。
- `テスト仕様書_クライアント版.xlsx` / `テスト仕様書_エンジニア版.xlsx` … 上記から決定論生成した2系統 Excel。
- `test-specs/{rls-matrix,zero-state,mock-fidelity,scale-capacity}.md` + `traceability.json` … 横断軸。

## 再生成（鉄則3: ソースから決定論生成・完成物は手編集しない）
```
python3 ~/.claude/skills/human-grade-qa/scripts/build_xlsx.py apps/web/.qa/test-specs apps/web/.qa
```

## 結果ステータスの正直な状態
- 各 TC の「結果」列は**空=planned**。**実機実行(login→画面→操作→DB突合)は未実施**。
- 理由: ローカル Postgres 無し・Docker 停止で API が実データを返せず **BLOCKED**。
- **env-free で実施済み（証拠あり）**: I4-S 到達性スイープ（死リンク1件検出→修正 #245→再スイープ0）、
  視覚忠実度 段1 token照合（実装値=DESIGN-atelier.md 一致・ハードコード色0）。
- 解除条件: Docker起動→`supabase start`→`supabase db reset`(migration)→web+API起動→Chrome MCP で393件実走。
