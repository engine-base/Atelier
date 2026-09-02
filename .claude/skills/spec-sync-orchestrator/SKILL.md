---
name: spec-sync-orchestrator
description: 仕様変更・追加（エンティティ追加・機能追加・画面追加・用語廃止・バージョン昇格・Q認識合わせ反映）を全ドキュメントに完全網羅で波及させるスキル。「全部更新して」「漏れなく反映して」「網羅反映」「依存反映」「エンティティ追加」「機能追加」「画面追加」「用語廃止」「バージョン昇格」「Q-X 反映」「クロスドキュメント同期」「整合性チェック」「依存マップ更新」と言われたら起動する。影響範囲スキャン → 並列反映 → 三段監査（数値整合・クロスリファレンス・廃止用語）→ 修復ループの完全自動化。pre-commit hook 経由でも起動可能。 v3.2 (2026-09-02): テスト・ラダー L1〜L5 / パイプライン連動 対応
tab: 設計・定義
builtin: true
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

`ladder_gates`（新設の節。A〜F と同じ run で必ず走らせる）に次を置く（Atelier 固有の値）— assets/spec-dependencies.yaml に反映済み:

```yaml
  - kind: qa_ladder_bidirectional
    description: tickets.json qa_rows ↔ test-specs タスク列 / runnable_after の両方向整合（qa-ladder validate）
    command: python3 scripts/ci/qa-ladder.py validate
  - kind: staging_defined
    description: selected-stack.json environments.staging（provisioned_by / data_policy / owner）が確定していること
    command: python3 scripts/ci/pipeline-next.py check-staging
```

## 🔒 恒久ガードレール G4：振る舞い波及監査（Tier D）＋ 依存マップの surface/side_effect 必須

数値/参照/廃止語の監査だけでは「新しい振る舞いが全サーフェスに着地したか」を見られない。
モデル/機能変更時は **Tier D：振る舞い波及（behavioral completeness）** を追加実行する。

- 新規に必須化された各要素（エンティティ項目 / 課金項目 / 状態×アクション）について次を全て検証：
  (a) **API** が返す、(b) **会員可視の画面**が消費する、(c) **状態×副作用マトリクス(G1)**に AC がある、
  (d) 該当する **外部副作用**（課金停止/再開等）が全遷移に配線される。いずれか欠落で **BLOCKER**（修復ループ対象）。
- `spec-dependencies.yaml` は各概念を **{docs, api, schema, screens, side_effects}** まで写像する。
  **screens か side_effects の線が無い概念は BLOCKER**（地図の穴を検出→マップ追記提案）。

> 由来：請求モデル全面変更時、「課金項目→会員契約画面の表示」「操作ごとの課金副作用」が依存マップに無く、
> 数値・参照・廃止語は通ったのに会員側表示と休会/再開の課金制御が落ちた事故。


# spec-sync-orchestrator スキル

## このスキルの役割

仕様変更・追加が発生した時、依存マップから影響範囲を機械的に抽出し、並列エージェントで一斉反映、四段監査（A数値整合/Bクロスリファレンス/C廃止用語/F下流分解カバレッジ）で完全性を検証する。**1 回の宣言で全ドキュメント・コード・スキーマの完全同期を実現する。** 機能追加時は下流の機能分解(08)・タスク分解(09)への波及まで Tier F で検証し、欠落時は `feature-decomposition`/`task-decomposition` スキルへハンドオフする。

---

## ⛔ 絶対ルール

1. **必ず影響範囲スキャン → 承認 → 反映 → 監査の順を守る** — スキップ禁止
2. **四段監査の全PASSが完了条件** — A/B/C/F のいずれかが FAIL なら修復ループへ（F=下流分解カバレッジ）
3. **修復ループは最大3回** — 4回目に到達したら手動介入要求で停止
4. **silent/verbose の自動判定** — 全PASSは silent、FAIL は verbose
5. **全実行を `.spec-sync/runs/<id>.json` に永続化** — 例外なし
6. **依存マップ未登録の概念検出時は警告 + マップ追加提案** — 暗黙の見逃しゼロ

---

## STEP 構成

```
STEP 1: 変更宣言の受付と分類
STEP 2: 影響範囲スキャン（依存マップ照合）
STEP 3: 事前承認（dry-run）
STEP 4: 並列反映実行
STEP 5: 三段監査 + 自動修復ループ
STEP 6: 完了出力（silent or verbose）
```

---

### ▶ STEP 1：変更宣言の受付と分類

**入力**: ユーザーの自然言語宣言

**処理**:
1. 変更タイプを分類: `add-entity` / `add-feature` / `add-screen` / `deprecate-term` / `version-bump` / `q-alignment` / `custom`
2. 対応する change-playbook を `assets/change-playbooks/<type>.md` から読み込み
3. 複数変更の同時宣言は個別変更に分解（順序は依存関係から自動決定）

**新規モジュールの OSS/ライブラリ評価（必須）**:
機能追加で新規モジュールが要る時は、**自作前提にせず枯れた OSS/ライブラリの第一候補・ライセンス・セルフホスト可否を必ず明記**する（詳細 `assets/change-playbooks/add-feature.md` の STEP4）。機密データを扱うモジュールはセルフホスト可能なものを優先。プロジェクトの `docs/selected-libraries.md` を正準として参照・追記。

**スコープ限定リネーム（client_terminology）**:
用語変更が「特定の閲覧者にだけ別名で見せる」場合（例: クライアント向けには `スキル`→`担当業務`・`ツール` を非表示にするが、運営コンソールは `スキル/ツール` を維持）は、**グローバルな `deprecated_terms` に登録しない**。登録すると運営側の正規表記まで FAIL になるため。代わりに、機能定義へ `policies.client_terminology: {hide: [...], show: [...]}` を持たせ、対象（クライアント向けモック・要件定義のクライアント節）だけ書き換える。監査 C は「クライアント向けファイル群に hide 用語が露出していないか」をスコープ限定で確認し、運営向けファイルは除外する。詳細は `assets/change-playbooks/deprecate-term.md` の「スコープ限定リネーム」節。

**出力（最小限）**:
```
## 変更宣言の解析
- 種別: <type>
- 対象: <target>
- playbook: assets/change-playbooks/<type>.md
- 推定影響: 次STEPで正確抽出

(複数変更時は箇条書きで分解結果を表示)
```

**深掘りチェック**:
- 分類不能 → `custom` 扱いで対話深掘り
- 複数変更 → 依存関係を解析し順序決定

**止まり方**: 「検出した変更タイプで合っていますか? 違えば訂正してください」

---

### ▶ STEP 2：影響範囲スキャン

**処理**:
1. `assets/spec-dependencies.yaml` を読み込み
2. `assets/scripts/spec-scan.py --concept <id>` を実行（依存マップから影響ファイル+該当行を抽出）
3. 結果を構造化

**出力**:
```
## 影響範囲レポート

### Source of Truth
- {file}:{line} — {current_value}

### Mirrors / 該当箇所 (N件)
| File | Line | Current | Expected |
|------|------|---------|----------|
| ... | ... | ... | ... |

### 関連参照（クロスリファレンス）
- E-XXX が新規参照される箇所: [files...]

### 並列実行プラン
- グループ1（独立・並列）: A, B, C
- グループ2（グループ1完了後）: D, E
```

**深掘りチェック**:
- 依存マップ未登録の概念 → 警告 + マップ追加提案
- ファイルアクセス不可 → エラー停止 + 修復提案

**止まり方**: 「この影響範囲で正しいですか? 追加・除外したいファイルはありますか?」

---

### ▶ STEP 3：事前承認（dry-run）

**処理**:
1. 各影響箇所の具体的な編集内容を生成（before → after）
2. 並列グループを最終確定
3. 推定所要時間を計算

**出力**:
```
## 反映プラン（dry-run）

### 変更内容（先頭5件・詳細は --verbose）
1. {file_A}:L82 「3方式」 → 「2方式」
2. ...

### 並列実行プラン
- Group 1: N 並列
- Group 2: M 並列

### 推定所要時間: 〜N分
```

**深掘りチェック**:
- 破壊的変更（DROP相当）→ 二重確認要求
- 不可逆操作 → 明示警告

**止まり方**: 「この反映プランで実行しますか? (yes / 修正 / 中止)」

---

### ▶ STEP 4：並列反映実行

**処理**:
1. グループごとに Agent (general-purpose) を spawn
2. 各エージェントに `references/agent-prompts.md` のテンプレートで指示
3. エージェント完了通知を集約
4. 失敗時は最大2回リトライ

**出力（進行中・silent モード時は省略）**:
```
進行中: Group 1 (3/3) → Group 2 (1/2)
```

**深掘りチェック**:
- 並列衝突防止（同ファイル禁止）
- リトライ2回失敗 → STEP 5 へ進み修復ループに委ねる

**止まり方**: 全エージェント完了通知後、自動で STEP 5 へ進む

---

### ▶ STEP 5：四段監査 + 自動修復ループ

**処理**:
1. `assets/scripts/spec-validator.py` を実行
2. 四段監査:
   - **A. 数値整合**: 全 counter の値が一致するか
   - **B. クロスリファレンス**: 全 E-XXX/F-XXX/S-XXX が必須ドキュメントに存在
   - **C. 廃止用語スキャン**: 全 deprecated_terms の active 参照ゼロ
   - **F. 下流分解カバレッジ**: 全 F-XXX が機能分解(08)・タスク分解 tickets(09) に、全 S-XXX が mockup index(06) に存在するか（`downstream_coverage`）。**仕様に機能を足したのにチケット化されない取り残しを検出する**
3. FAIL あれば修復エージェントを spawn → 再検証（最大3ループ）

**Tier F の修復は別スキルへハンドオフ（重要）**:
F の欠落は「下流の分解成果物が古い」ことを意味する。これは spec-sync 単体では生成できない（機能分解・チケット化は専用スキルの仕事）。FAIL の `remediation` に従い、**`feature-decomposition` → `task-decomposition` スキルを順に呼んで欠落機能を分解・チケット化**してから再検証する。`add-feature` 等の playbook STEP にもこのハンドオフを明記済み。

**出力（silent モード: 全PASS時）**:
```
✓ 監査 全PASS (A/B/C/F)
```

**出力（verbose モード: FAIL時）**:
```
✗ 監査 FAIL

A. 数値整合: ✓ PASS
B. クロスリファレンス: ✗ FAIL (1件)
  - E-024 が types.ts に未記載
C. 廃止用語: ✓ PASS
F. 下流分解カバレッジ: ✗ FAIL
  - F-027..F-037 が tickets.json に未存在 → task-decomposition を実行

修復ループ #1 開始...
```

**深掘りチェック**:
- 3 ループでも修復不能 → 手動介入要求 + 詳細ログ
- false positive 検出 → `cross-ref-rules.yaml` 改善提案
- Tier F の `severity: warn`（例 mockup index）は overall を fail させず warnings に記録のみ。`error`（機能分解・tickets）は fail

**止まり方**: 全 PASS で STEP 6 へ自動進行 / 3 ループ失敗で停止

---

### ▶ STEP 6：完了出力

**処理**:
1. `display_mode` を決定（全PASS=silent / FAIL=verbose）
2. 実行ログを `.spec-sync/runs/<run_id>.json` に保存
3. `.spec-sync/latest.json` シンボリックリンク更新
4. FAIL時のみ `.spec-sync/failures/` にハードリンク作成

**出力（silent モード）**:
```
✓ spec-sync 完了
  種別: <type>
  反映: <N>ファイル / <M>箇所
  監査: A/B/C/F 全PASS
  ログ: .spec-sync/runs/<id>.json
```

**出力（verbose モード）**:
```
✗ spec-sync 失敗（修復ループ <N>回到達）

監査結果:
  A. 数値整合: <status>
  B. クロスリファレンス: <status>
  C. 廃止用語: <status>
  F. 下流分解カバレッジ: <status>

FAIL 詳細:
  - <具体的なエラー>

手動介入が必要です。詳細ログ: .spec-sync/runs/<id>.json
```

**オンデマンド出力（要求時のみ）**:
- 「前回のログ見せて」→ `latest.json` の主要セクションを表示
- 「コミットメッセージ草案」→ log から生成
- 「過去の失敗一覧」→ `failures/` をリスト

**深掘りチェック**:
- コミット実行は **ユーザーの明示的指示まで保留**
- 自動 push は禁止

**止まり方**: 報告後・コミット指示待ち

---

## 出力スキーマ

実行ログ `.spec-sync/runs/<run_id>.json`:

```json
{
  "meta": {
    "skill_name": "spec-sync-orchestrator",
    "skill_version": "1.0",
    "run_id": "20260523-143052-deprecate-scratch",
    "executed_at": "2026-05-23T14:30:52Z",
    "executed_by": "<session_id>",
    "project_root": "/home/user/Jobrain",
    "git_branch": "<branch>",
    "status": "completed | in_progress | failed_after_max_loops | aborted_by_user",
    "display_mode": "silent | verbose",
    "log_path": ".spec-sync/runs/<id>.json"
  },
  "change_declaration": {
    "raw_input": "<user input>",
    "parsed_changes": [
      {"type": "<type>", "target": "<target>", "playbook": "<path>", "scope": [...]}
    ]
  },
  "impact_scan": {
    "scanned_files_count": <N>,
    "affected_files_count": <N>,
    "affected_locations_count": <N>,
    "affected_files": [
      {"path": "...", "role": "source_of_truth|mirror", "concept": "...",
       "current_value": "...", "expected_value": "...", "locations": [...]}
    ],
    "parallel_groups": [{"group_id": <N>, "files": [...], "dependency": "..."}]
  },
  "user_approval": {
    "approved_at": "...",
    "approval_method": "explicit_yes|dry_run_only|auto_pre_commit",
    "excluded_files": [],
    "added_files": []
  },
  "execution": {
    "agents_spawned": [
      {"agent_id": "...", "group_id": <N>, "assigned_files": [...],
       "started_at": "...", "completed_at": "...", "status": "...",
       "edits_applied": <N>, "self_check_passed": true|false}
    ],
    "total_edits": <N>,
    "execution_duration_seconds": <N>
  },
  "audit": {
    "loop_count": <N>,
    "loops": [
      {
        "loop_number": <N>,
        "tier_a_numeric_consistency": {"status": "pass|fail", "checks": [...], "failures": [...]},
        "tier_b_cross_reference": {"status": "pass|fail", "checks": [...], "failures": [...]},
        "tier_c_deprecated_terms": {"status": "pass|fail", "checks": [...], "failures": [...]},
        "overall": "pass|fail",
        "repair_agents_spawned": [...]
      }
    ],
    "final_status": "pass|fail_after_max_loops"
  },
  "output": {
    "commit_message_draft": "<draft>",
    "files_changed": [...],
    "git_diff_summary": "...",
    "recommended_next_actions": [...]
  }
}
```

---

## 関連ファイル

- `assets/spec-dependencies.yaml` — 依存マップ（手動メンテ・プロジェクト固有）
- `assets/cross-ref-rules.yaml` — 整合性ルール
- `assets/change-playbooks/` — 変更タイプ別の波及手順
- `assets/scripts/spec-validator.py` — 四段監査スクリプト（A/B/C/F）
- `assets/scripts/spec-scan.py` — 影響範囲スキャンスクリプト
- `assets/hooks/pre-commit` — git pre-commit hook
- `assets/templates/` — レポートテンプレート
- `references/` — 仕様書・スキーマ・ガイド

---

## Provider Fallback

並列エージェント spawn は Claude SDK 依存（高速化目的）。
シーケンシャル実行に Fallback 可能（機能同等・速度低下のみ）。

---

## ライフサイクル

- **繰り返し使用**: 仕様変更ごとに毎回起動
- **pre-commit hook 経由**: 自動起動も可能（validator のみ実行）
- **`spec-dependencies.yaml` のメンテ**: 新規概念追加時に手動更新（playbook が補助）

## 🔌 結線カバレッジ（Tier F 拡張・汎用・再発防止）

機能追加時、コンポーネント(data/api/ui)タスクだけでなく**結線(integration/wiring)タスク**まで分解されているかを点検する。下流分解カバレッジ(Tier F)に以下の観点を加える（プロダクト非依存）:

- 各機能が「部品を end-to-end 価値経路へ結線する integration タスク」を**最低1つ**持つか（持たない＝価値経路が孤立する恐れ）。
- `stub`/`echo`/`Phase-N defer`/「アダプタ境界が not configured でthrow」が**価値経路に残る機能は『未完』**として扱う。
- 検出のヒント（grep可能な兆候）: handler/registry を定義したが register/呼出が無い、実行ループが stub のまま、接続→可用性の写像コードが無い。

`downstream_coverage` を持つプロジェクトでは、機能分解(08)・タスク分解(09) に**結線タスク(deliverable_layer: integration)**が含まれるかも併せて確認する。
