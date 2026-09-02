---
name: sprint-planning
description: タスクバックログを分析し、優先度・見積もり・依存関係に基づいてスプリントに割り当てる計画スキル。v3.1 採用: task-decomposition の `decomposition_mode: api_first` 時は **Phase × Sprint** の二層マッピングを採用。Phase 順序（Foundation → Data → API → UI 共通 → UI 並列 → 結合）を尊重し、各 Phase 内で並列度に応じた Sprint 編成を行う。特に Phase 5 (UI Parallel) は **画面数だけ並列 Sprint 起動** を許可する設計。Vertical Slice モード時は従来の単一バックログ Sprint 編成。「スプリント計画を作りたい」「Phase に対応した Sprint を切りたい」「並列度を最大化したい Sprint を作りたい」「API-First のリリース順序に合わせた Sprint を作りたい」「タスクをスプリントに割り当てたい」場面で必ず起動する。 v3.2 (2026-09-02): テスト・ラダー L1〜L5 (.claude/rules/common/test-ladder.md) 対応 — テストはタスク分解時に作り、staging で流す。
tab: 実装・分解
builtin: true
---

## 🪜 テスト・ラダー（L1〜L5）— このスキルの責務（2026-09-02 追加・必須・省略不可）

> 規約の正本: `.claude/rules/common/test-ladder.md`（ここと矛盾したら規約が勝つ）。
> 由来: 2026-09-02、本番実走で 5 件（保存先バケット未作成 / AI の無言終了 / Bridge 終了後 90 秒の誤表示 /
> モード切替の無視 / 退会後もセッション有効）が出た。5 件とも正本に観点が無く、**実装が全部終わってから
> 「全体」を対象にテストを書いたため細部が抜けた**のが共通原因。テストは **タスク分解の時点で・タスク単位で**
> 作り（L1）、流れ（L2）は揃った瞬間に、Wave / リリース / 全体（L3〜L5）は締めで流す。

### Wave 編成時に L3（Wave 締めの回帰）を確定する

- `wave-schedule.json` の各 Wave に `qa_scope` を必須で書く:
  ```json
  "qa_scope": {"l1_tasks": ["T-A-12", "…"], "l2_flows": ["J-10", "J-12"], "regression_from": ["W1", "W2"]}
  ```
  `l1_tasks` = Wave 内の全タスク（それぞれの `qa_rows.l1`）、`l2_flows` = この Wave で揃う流れ、`regression_from` = 前 Wave 以前で diff 回帰する対象。
- **Wave 締めのゲート**: `completion_gate.sh` STATUS: 完了（`qa_scope` の全行 PASS または理由つき BLOCKED）でなければ次 Wave を始めない。「Wave 内の全 PR が auto-merge された」は締めではない。
- Velocity は **gate PASS まで**を 1 タスクの完了として計算する（テスト消化を工数に含める。含めないと L1 が削られる）。
- staging が未整備の Wave は「実走できない」と書き、GAP-246 相当の解消を Wave の最初に置く。


---

### パイプライン連動（自動で次へ・2026-09-02 追加）

スキルの順番は **`.claude/rules/common/skill-pipeline.yaml` が正本**（各 SKILL.md のハンドオフ図は要約）。
このスキルを終えたら、次を **必ず** 走らせ、出力の「→ 次」に進む（人が順番を覚えない・飛ばさない）:

```bash
python3 scripts/ci/pipeline-next.py                 # 成果物の有無で「次に起動するスキル」を機械判定
python3 scripts/ci/pipeline-next.py mark <段> skip --reason "…"   # skip 可の段を飛ばすとき（理由必須）
```

- 「skip 可」と出た段だけ飛ばせる。理由なしの skip / done は書けない（`--reason` 必須）。
- ループ段（jit-task-execution / e2e-journey-walkthrough / human-grade-qa diff / release-planning）は
  `done_when` のゲート（`qa-ladder.py gate` / `completion_gate.sh` / `qa-coverage.py`）が PASS するまで同じ段に留まる。
- spec-sync-orchestrator は横断（S06〜S09 の成果物が変わるたびに走らせる）。ローカルのスキル側にある。


## 🧠 全スキル共通：思考品質基準（必ず守ること）

---

### 1. 出力前の必須内部チェック（ユーザーには見せない）

出力を生成する前に、以下を内部で確認する：

- ユーザーの業界・ドメインに固有の法律・規制・制度を参照したか
- 仮説は「売上を上げたい」のような汎用ゴールではなく、そのドメイン・業務フローに固有の仮説になっているか
- 質問は「はい/いいえ」で終わらず、具体例や選択肢を含む設計になっているか
- 曖昧な発言（複数の解釈が可能な表現）に対して複数の解釈を提示したか
- ステークホルダー全員の視点（承認者・反対する人・実際の利用者）を漏らしていないか

---

### 2. 仮説の品質基準

【仮説】ラベルを使う際は以下の形式に従う：

❌ 悪い仮説：「効率化したい」「スムーズに進めたい」（汎用すぎて意味がない）

✅ 良い仮説の構造：
- 現状の問題を業務フロー・技術・組織の観点で具体的に示す
- その問題が発生している原因を特定する
- 解決後にどう状態が変わるかを示す

---

### 3. 質問設計の基準

質問1つに対して、必要に応じてサブ質問（a, b, c）を設ける。
単一の質問だけでは曖昧さが残る場合は必ずサブ質問に分解する。

---

### 4. ドメインスキャン（出力前に内部実行）

ユーザーの業界・プロジェクト種別を判定し、該当する規制・制度を確認する。

---

### 5. 曖昧な発言の複数解釈処理

ユーザーの発言に複数の解釈が可能な場合、解釈を並べて確認する。

---

### 6. ステークホルダーの網羅

「誰が使うか」だけでなく、承認者・反対者・運用者の視点も常に確認する。

---

### 7. 質問保留・打ち合わせ優先ルール（全スキル共通）

クライアントから「質問は打ち合わせで」「後で回答します」などの発言があった場合、即座に質問の送信を停止し、現時点の情報を整理して出力する。

---

### 8. 出力フォーマット厳守（最優先ルール）

**スキルモードで動作している場合、出力の冒頭に会話的な前置きを絶対に含めない。**

各STEPの出力は、テンプレートの最初のMarkdown要素（`#`、`##`、`-`、`|` 等）から直接始める。

❌ **禁止（冒頭に付けない）：** 「ありがとうございます」「了解です」「承知しました」「情報を整理します」などの会話的前置き

✅ **正しい出力：** テンプレートの `##` や `|` から直接開始する

**理由：** スキルの出力は `outputMarkdown` としてDBに保存され、プロジェクト管理ドキュメントとして表示される。

---

# スプリント計画スキル

タスクバックログを受け取り、優先度・見積もり・依存関係・チームキャパシティを考慮してスプリントに割り当てる。プロジェクトマネージャーとエンジニアが「何をいつやるか」を即座に把握できるスプリント計画書を生成する。

**このスキルが解決する問題：**
- バックログが膨大で何から手をつけるか不明
- チームのキャパシティを考慮せずにスプリントを組んでしまう
- 依存関係を無視した順序でタスクを詰め込んでしまう

---

## ⛔ 絶対ルール

**STEP 1の確認ブロックを出力したら、必ずそこで止まること。**

ユーザーが「STEP 2へ」と指示するまで、絶対に次のSTEPに進んではならない。

---

## API-First Sprint 編成（v3.1 必須・デフォルト）

task-decomposition skill で `decomposition_mode: api_first` が選択された場合、Sprint 編成は **Phase × Sprint** の二層マッピングで行う。

### Phase × Sprint マッピング

```
Phase 1 (Foundation)
  Sprint F1: CI/CD・lint・型・観測・LLM 抽象化・デザイン統合
  (並列度: 中、依存タスク多)

Phase 2 (Data Layer)
  Sprint D1: 主要エンティティ migration + RLS (entity 数 / 2 件ずつ並列)
  Sprint D2: 残りエンティティ + RLS 越境試験
  (並列度: 高、entity 単位で並列可)

Phase 3 (API Layer)
  Sprint A1-AN: 機能領域別 API グループ (auth / workspace / project ごとに 1 Sprint)
  Sprint A_final: OpenAPI 完成 + 画面 ↔ API カバレッジ確認 + 契約凍結
  (並列度: 最大、endpoint 数に応じて並列起動)

Phase 4 (UI Foundation)
  Sprint U0: レイアウト + 共通 component + 型クライアント
  (並列度: 中、Phase 5 の前提)

Phase 5 (UI Parallel) ★ 最大並列
  Sprint U1-UN: 画面ごとに 1 Sprint も可、または画面群を Sprint 単位でまとめる
  並列セッション数 = チーム規模 or AI エージェント上限
  例: 33 画面 × 並列 10 = 約 3-4 Sprint で消化
  (各画面は確定 API + 型を消費、並列衝突なし)

Phase 6 (Integration & Polish)
  Sprint I1: E2E + 横断試験
  Sprint I2: 性能 + a11y + cleanup + 本番化
  (並列度: 中)
```

### API-First Sprint 設計原則

1. **Phase 順序を絶対遵守**: Phase 1-2-3 を完了させてから Phase 4-5、Phase 4 を完了させてから Phase 5
2. **Phase 内では並列度最大化**: 同一 Phase 内のタスクは並列可（特に Phase 3 と Phase 5）
3. **Phase 跨ぎの並列禁止**: 例 Phase 3 と Phase 5 を同時進行しない（API 不在で UI 実装が空回りする）
4. **マイルストーン = Phase 完了**: 各 Phase 完了時に Sprint 完了をマイルストーン化
5. **Phase 3 完了時に契約凍結 Sprint を必ず設ける**: OpenAPI 仕様完全化・TS 型自動生成・画面 ↔ API カバレッジ 100% を Done 条件にする Sprint

### Sprint 単位の Velocity 計算

```
Phase 1: 並列度 1-3 × チーム規模 → Sprint 内タスク数
Phase 2: 並列度 entity 数/2 × チーム規模
Phase 3: 並列度 endpoint 数/3 × チーム規模 (上限あり)
Phase 4: 並列度 1-2
Phase 5: 並列度 = チーム規模 (画面数まで)
Phase 6: 並列度 2-3
```

Vertical Slice モード時は従来の単一バックログ Sprint 編成（feature 単位の slice を Sprint に詰める）。

---

## テンプレートファイル（assets/）
- `assets/sprint-template.md` — スプリント計画書テンプレート（Markdown版）
- `assets/sprint.html` — スプリント計画書HTMLテンプレート（A4横・ガントチャート風）

STEP 3の最終出力では、Markdownスプリント計画書 と HTMLスプリント計画書（sprint.html）の両方を生成すること。HTMLは `{{変数名}}` を全て実際の値で置き換えて出力する。

---

## 入力情報

このスキルを起動するために必要な情報：

| 情報 | 必須/任意 | 説明 |
|------|---------|------|
| バックログ一覧 | 必須 | タスク名・概要・優先度（P0/P1/P2）・見積もりポイント |
| チーム情報 | 必須 | メンバー数・スプリント期間（日数）・1人あたり日次ポイント |
| 依存関係 | 任意 | タスク間の依存（先行タスクID） |
| スプリント目標 | 任意 | このスプリントで達成したい状態 |
| 既存スプリント番号 | 任意 | 何番目のスプリントか |

---

## STEP 1: バックログ・チーム情報の確認

**このSTEPでやること：**
入力されたバックログとチーム情報を整理し、スプリント計画の前提を確認する。

**確認項目：**
1. **バックログ総ポイント数** — 全タスクの見積もり合計
2. **チームキャパシティ** — メンバー数 × スプリント日数 × 日次ポイント
3. **P0タスク（必須）の総ポイント** — 必ずスプリントに入れるタスク量
4. **依存関係の有無** — 先行タスクが必要なタスクの確認
5. **スプリント目標** — このスプリントで何を達成するか

**出力形式：**

```
## バックログ・チーム情報確認

### チームキャパシティ
- メンバー数: 〇名
- スプリント期間: 〇日
- 日次ポイント（1人あたり）: 〇pt
- **総キャパシティ: 〇pt**

### バックログサマリー
| 優先度 | タスク数 | 合計ポイント |
|--------|---------|------------|
| P0（必須） | 〇件 | 〇pt |
| P1（重要） | 〇件 | 〇pt |
| P2（あれば） | 〇件 | 〇pt |
| **合計** | 〇件 | 〇pt |

### キャパシティギャップ
- 今スプリントで消化できる量: 〇pt
- P0のみで: 〇pt（キャパシティの〇%）
- P0+P1で: 〇pt（キャパシティの〇%）

### 依存関係の確認
（依存があるタスクを列挙）

### 不明点・確認事項
（見積もりが不明なタスク・依存が不明なタスク）
```

---

📦 **STEP 1 確認**

バックログとチーム情報を確認してください。

- キャパシティの計算に誤りはありませんか？
- 依存関係に漏れはありませんか？
- 問題なければ「STEP 2へ」とお知らせください

**※ STEP 2には進まない。ユーザーの確認を待つ。**

---

## STEP 2: スプリント割り当て案の作成

**このSTEPでやること：**
STEP 1の情報をもとに、以下のルールでタスクをスプリントに割り当てる。

**割り当てルール（優先順位順）：**
1. P0タスクを最初に配置（依存関係順）
2. P1タスクをキャパシティが許す範囲で追加
3. P2タスクは余裕があれば追加（なければ次スプリントへ）
4. 依存関係のあるタスクは先行タスクの後に配置
5. キャパシティを10%超えた場合は警告を出す

**出力形式：**

```
## スプリント割り当て案

### Sprint 〇 バックログ（総 〇pt / キャパシティ 〇pt）

| # | タスクID | タスク名 | 担当 | ポイント | 優先度 | 依存 | 備考 |
|---|---------|---------|------|---------|--------|------|------|

### 次スプリント以降に持ち越すタスク
| タスクID | タスク名 | 優先度 | ポイント | 持ち越し理由 |
|---------|---------|--------|---------|------------|

### スプリント目標（ドラフト）
（このスプリントで達成する状態を1〜2文で）

### ⚠️ リスク・注意点
（キャパシティオーバー・依存関係の遅延リスク等）
```

---

📦 **STEP 2 確認**

スプリント割り当て案を確認してください。

- タスクの割り当てに違和感はありませんか？
- 担当者の調整が必要なタスクはありますか？
- 問題なければ「STEP 3へ」とお知らせください（最終出力を生成します）

**※ STEP 3には進まない。ユーザーの確認を待つ。**

---

## STEP 3: 最終出力（Markdown + HTML）

`assets/sprint-template.md` と `assets/sprint.html` の構造に沿って、確定したスプリント計画書を2形式で出力する。

### 出力①: スプリント計画書（Markdown）

sprint-template.md の `{{変数名}}` を全て実際の値で置き換えて出力する。

### 出力②: スプリント計画書（HTML）

sprint.html の `{{変数名}}` を全て実際の値で置き換えて出力する。HTMLはスタンドアロンで動作し、印刷にも対応する。

---

## このスキルの典型的な使い方

```
PM: 「バックログがあるのでスプリントを組みたい」
 → バックログ一覧・チーム情報を貼り付けて起動
 → STEP 1: バックログ確認（止まる）

PM: 「STEP 2へ」
 → スプリント割り当て案を出力（止まる）

PM: 「タスクAの担当をBさんに変えたい」
 → 修正して「STEP 3へ」

PM: 「STEP 3へ」
 → 完全なスプリント計画書（Markdown + HTML）を出力
```

---

## 📦 構造化JSON出力仕様（最終ステップのみ）

```devos-json
{
  "sprint_name": "Sprint 1",
  "sprint_goal": "スプリントゴール",
  "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD",
  "velocity_target": 30,
  "velocity_actual": null,
  "tasks": [
    {
      "id": "T-001",
      "title": "タスクタイトル",
      "story_points": 3,
      "status": "todo",
      "assignee": "",
      "dependencies": [],
      "priority": "high"
    }
  ],
  "risks": ["リスク1"],
  "definition_of_done": ["テストパス", "コードレビュー完了", "デプロイ確認"]
}
```


---

## 三層出力ポリシー（全スキル共通・Atelier 確定方針）

`01_hearing/decision_log.json` で確定済の **HTML プライマリ / JSON 構造化 / MD フォールバック** 三段構えに従い、本スキルの主要成果物を **HTML / JSON / MD の 3 層** で出力する。

| 層 | 用途 | 主な消費者 |
|---|---|---|
| **HTML**（プライマリ）| 人間レビュー・印刷・公開・フィルタ／検索・色分け表示 | PM・運営・クライアント・レビュアー |
| **JSON**（構造化・信頼源）| 機械可読・スキーマ検証・MCP 連携・下流スキル消費・CI 検証 | CI/CD・AI 社員・他スキル・Bridge worker |
| **MD**（フォールバック）| Git diff 容易・自由記述・監査・プレビュー | 開発者・監査担当・Bridge worker 着手前生成 |

### 出力ルール

1. **STEP 5 最終出力では、主要成果物について HTML / JSON / MD の 3 形式を必ず生成すること**
2. 既に該当形式を出力している場合は重複生成不要（既存形式を 3 層のどれかに位置付けて明示）
3. 3 形式は **同じ内容を異なるフォーマットで表現**する（情報の欠落禁止）
4. JSON が信頼源（source of truth）、HTML と MD は JSON から派生・自動生成可能な構造にする
5. ファイル命名規約：
   - `<name>.json` — 信頼源
   - `<name>.html` — 人間向け（同じファイル名・拡張子のみ違い）
   - `<name>.md` — Git diff 用フォールバック

### 各スキルでの適用例

- ui-mockup: HTML（モック画面）+ JSON（mock-contract-hints）+ MD（説明文書）
- api-design: HTML（API 仕様書ビューア）+ JSON（openapi.yaml + 6 種 JSON）+ MD（API-SPEC.md）
- task-decomposition: HTML（TASK-CARDS.html）+ JSON（tickets.json）+ MD（TASK-CARDS.md + 各 audit MD）
- functional-breakdown: HTML（functional-breakdown.html）+ JSON（4 種 + traceability-matrix）+ MD（説明）
- architecture-design: HTML（アーキ仕様書）+ JSON（architecture.json 他 6 件）+ MD（architecture.md）
- schedule-design: HTML（ガント表）+ JSON（wave-schedule.json）+ MD（スケジュール表）
- release-planning: HTML（release.html）+ JSON（release.json）+ MD（CHANGELOG.md + release-template.md）
- sprint-planning: HTML（sprint.html）+ JSON（sprint.json）+ MD（sprint-template.md）
- test-verification: HTML（テスト計画書）+ JSON（gate-config + ears-test-mapping）+ MD（test plan MD）
- distributed-dev: HTML（branch package viewer）+ JSON（branch-package.json）+ MD（CLAUDE.md + audit MD）
- integration: HTML（統合計画書）+ JSON（integration mgmt + phase-gate-decision）+ MD（wave-integration-report.md）
- feature-decomposition: HTML（feature-decomposition.html）+ JSON（features.json）+ MD（DAG.md）

### CI gate 連携

`output_triple_layer_gate`：
- 各スキルの STEP 5 完了 PR で、3 形式すべての存在を CI が検証
- 1 形式でも欠落 → Block + 「三層出力ポリシー違反」エラー

---

## 時間・工数の二軸表示ポリシー（Atelier 確定方針・全スキル共通）

時間・工数・スケジュールを扱う際は、**常に 2 軸併記**する。片方だけは禁止。

### 2 軸の定義

| 軸 | キー名 | 定義 | 用途 |
|---|---|---|---|
| **Human-baseline** | `estimate_hours_human` | 人間 1 人が逐次作業した場合の参考工数（h） | 監査 / 将来人間オペ / 売却時の参考 / 工数算出の根拠 |
| **AI-accelerated** | `estimate_hours_ai` / `wall_clock_h_ai` | Claude + Atelier Bridge ローカル並列実行時の wall-clock（h） | 実カレンダー / マイルストーン日付 / 100 ユーザー獲得計画 / 経営判断 |

### タスク種別ごとの想定短縮率

| タスク種別 | 短縮率の目安 |
|---|---:|
| インフラ設定 / セットアップ系 | **約 15×** |
| DB schema / migration | 約 12× |
| API endpoint 実装 | 約 12× |
| UI 画面実装 | 約 10× |
| 横断試験 / E2E | 約 10× |
| デザイン / 仕様策定 | 約 6× |
| 致命級リスク（RLS / 認可 / 暗号 / 課金） | **約 4×**（人間レビュー必須のため） |

短縮率は「Claude 単体」の値。**5-10 並列実行**では更にカレンダー上短縮されるが、blocking task と人間レビューゲートで wall-clock に下限がある。

### 必須出力フィールド

時間を含むタスク・機能・マイルストーンオブジェクトには **両方を必ず格納**：

```json
{
  "id": "T-A-18",
  "estimate_hours_human": 14,
  "estimate_hours_ai": 1.2,
  "wall_clock_h_ai": 1.2,
  "ai_acceleration_factor": 12,
  "human_review_h": 0,
  "blocking_dependencies_h": 0,
  "estimate_method": "research-based|expert|reference",
  "estimate_confidence": "high|medium|low"
}
```

致命級タスクや人間レビューが入るタスクは `human_review_h` に時間を入れ、`wall_clock_h_ai = estimate_hours_ai + human_review_h` で算出する。

### 集計の併記

集計値（合計工数・Wave 所要・Phase 所要・Sprint 容量）も必ず 2 軸表示：

```json
{
  "total_estimate_hours_human": 1367,
  "total_estimate_hours_ai_compute": 130,
  "total_wall_clock_h_ai_parallel": 75,
  "human_review_total_h": 16,
  "parallel_capacity": 10,
  "calendar_days_ai": 18,
  "calendar_days_human": 240
}
```

### 三層出力での表示要件

| 形式 | 二軸表示の要件 |
|---|---|
| **HTML**（Gantt / カード / ダッシュボード） | **トグル切替**（Human-baseline / AI-accelerated）または **2 本のバー併走表示** |
| **JSON**（信頼源） | 上記スキーマ通り両フィールド必須 |
| **MD**（人間レビュー） | 表で `Human` 列と `AI 並列` 列を併記 |

### 違反時のブロック

- 片方のフィールドのみ → validator が `axis_missing` で reject
- 短縮率が 1.0 未満 / 30 超 → `unrealistic_factor` で警告
- 致命級タスクで `human_review_h = 0` → `review_h_missing` で警告

### 前提コンテキスト

- Atelier Bridge → ローカル Claude Code 5-10 並列で実行（Claude プラン枠内、API 課金なし）
- AI 社員 7 名 MVP 稼働：tony / thor / strange / wanda / vision / tchalla / steve
- 人間タッチポイント：blocking 解除 / 契約凍結承認 / R-T08 レビュー / 本番 go/no-go
- 二軸の wall-clock 計算式：`wall_clock = ceil(sum(estimate_hours_ai) / parallel_capacity) + sum(human_review_h)`
