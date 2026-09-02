# spec-sync-orchestrator — SKILL.md への追記パッチ（2026-09-02 / テスト・ラダー + パイプライン連動）

> このスキルの本体 SKILL.md はリポジトリに無く、**ローカルのスキル置き場にある**。
> ローカルのセッションで、この節を SKILL.md の frontmatter 直後に **そのまま挿入**し、
> `description:` の末尾に `v3.2 (2026-09-02): テスト・ラダー L1〜L5 / パイプライン連動 対応` を足す。
> （リポジトリ側では `.claude/rules/common/skill-pipeline.yaml` の S07b / cross_cutting として登録済み）

---

## 🪜 テスト・ラダー（L1〜L5）— このスキルの責務（2026-09-02 追加・必須・省略不可）

> 規約の正本: `.claude/rules/common/test-ladder.md`。パイプラインの正本: `.claude/rules/common/skill-pipeline.yaml`。

### 位置: 横断（S07b）— 仕様が変わるたびに走る「整合の見張り」

- S06 functional-breakdown / S07 api-design / S08 feature-decomposition / S09 task-decomposition の **どれかの成果物が変わったら必ず起動**し、`spec-validator` で A 数値整合 / B クロスリファレンス / C 廃止用語 / F 下流分解カバレッジを検査する。
- **検査対象に「テスト正本」を追加する（v3.2）**:
  - **G 段の整合**: `tickets.json` の `qa_rows.l1` / `qa_rows.l2_flows` と、`apps/web/.qa/test-specs`（画面別・AI・ジャーニー）の `タスク` 列 / `runnable_after` が **両方向に一致**する（`python3 scripts/ci/qa-ladder.py validate` を内部で呼ぶ。片方にしか無い ID は FAIL）。
  - **H 流れのカバレッジ**: feature-decomposition の `journey_candidates`（J-xx）が **全部** `journeys/plan.json` に行として存在する。無い流れは silent-miss として FAIL。
  - **I 画面の取りこぼし**: 実在する画面（`app/**/page.tsx` 等）に対して `screens/*.md` が無いものを FAIL（`qa-coverage.py` の「画面が無い仕様書」と同じ）。
  - **J staging の確定**: `03_architecture/selected-stack.json` の `environments.staging` が無ければ FAIL（`python3 scripts/ci/pipeline-next.py check-staging`）。決まるまで L1〜L3 の実走環境が無い（GAP-246）。
- 結果は `.qa/spec-sync/<日付>/result.json`（`{"status": "PASS"|"FAIL", "checks": [...]}`）に残す。`pipeline-next.py check-spec-sync` がこれを読む。**結果ファイルを残さない実行は「やっていない」と同じ**。
- 検出した silent-miss は **直すのではなく起票する**（gap-tracker + 該当スキルへの差し戻し）。このスキルが台帳を勝手に書き換えない（鉄則3: 正本は 1 冊、変更は明示改訂）。

### パイプライン連動（自動で次へ）

```bash
python3 scripts/ci/pipeline-next.py            # 次に起動するスキル（成果物の有無で機械判定）
python3 scripts/ci/pipeline-next.py check-spec-sync
```
完了時は `result.json` を残してから `pipeline-next.py` を走らせ、出力の「→ 次」に進む。

### spec-dependencies.yaml への追記（assets）

`references` に次の 2 種を足す（Atelier 固有の値）:

```yaml
  - kind: qa_ladder_bidirectional
    description: tickets.json qa_rows ↔ test-specs タスク列 / runnable_after の両方向整合（qa-ladder validate）
    command: python3 scripts/ci/qa-ladder.py validate
  - kind: staging_defined
    description: selected-stack.json environments.staging（provisioned_by / data_policy / owner）が確定していること
    command: python3 scripts/ci/pipeline-next.py check-staging
```
