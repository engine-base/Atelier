---
name: release-planning
description: リリースのチェックリスト・手順書・変更履歴（CHANGELOG）を生成するスキル。v3.1 採用: API-First 開発の **6 Phase 順序を固定** (Foundation → Data → API → UI 共通 → UI 並列 → 結合・E2E)。各 Phase の完了 = 次 Phase 解禁条件を機械判定可能な形でリリース計画に組み込む。Phase 3 (API Layer) 完了時に **API 契約凍結** を実施、Phase 5 (UI Parallel) で初めて画面が並列実装解禁、Phase 6 完了で本番リリース可能化。Vertical Slice モードでは従来の単一ロードマップ。「リリース計画を作りたい」「Phase 別のリリースゲートを設計したい」「CHANGELOG を作りたい」「API 凍結タイミングを決めたい」「並列実装解禁条件を決めたい」「本番リリースのチェックリストを作りたい」場面で必ず起動する。 v3.2 (2026-09-02): テスト・ラダー L1〜L5 (.claude/rules/common/test-ladder.md) 対応 — テストはタスク分解時に作り、staging で流す。
tab: 品質・運用
builtin: true
---

## 🪜 テスト・ラダー（L1〜L5）— このスキルの責務（2026-09-02 追加・必須・省略不可）

> 規約の正本: `.claude/rules/common/test-ladder.md`（ここと矛盾したら規約が勝つ）。
> 由来: 2026-09-02、本番実走で 5 件（保存先バケット未作成 / AI の無言終了 / Bridge 終了後 90 秒の誤表示 /
> モード切替の無視 / 退会後もセッション有効）が出た。5 件とも正本に観点が無く、**実装が全部終わってから
> 「全体」を対象にテストを書いたため細部が抜けた**のが共通原因。テストは **タスク分解の時点で・タスク単位で**
> 作り（L1）、流れ（L2）は揃った瞬間に、Wave / リリース / 全体（L3〜L5）は締めで流す。

### リリース = L4。チェックリストに固定する

- **リリース前チェックリスト（必須項目を追加）**:
  1. `python3 scripts/ci/qa-coverage.py` の出力を貼る（STATUS: 完了 でなければリリース不可。未判定 / FAIL の ID を名指し）
  2. 正本 full（画面別・ジャーニー・RLS・AI 実動・負荷）を **staging** で消化済み（`completion_gate.sh`）
  3. **本番はスモーク（prod-smoke.md）だけ**を流す。本番で通し・ジャーニー・破壊的テストはしない
  4. G-11: 本番の外部リソース（バケット・キュー・秘密・DNS）が **コードで**用意されていることを、デプロイ前に `prod-smoke` の実在行で確認
  5. 正本の改訂（行の増減・期待結果の変更）を CHANGELOG に「テスト仕様 +N / 改訂 M（理由）」として書く（鉄則3）
- ロールバック条件に「L4 スモークの FAIL」を明記する。


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

❌ 悪い仮説：「問題なくリリースできるはず」（根拠のない楽観）

✅ 良い仮説の構造：
- リリースに関わる技術的・組織的リスクを具体的に示す
- 各チェックの根拠と確認方法を明記する
- ロールバック条件と手順を具体的に示す

---

### 3. 質問設計の基準

質問1つに対して、必要に応じてサブ質問（a, b, c）を設ける。

---

### 4. ドメインスキャン（出力前に内部実行）

ユーザーの業界・プロジェクト種別を判定し、規制・コンプライアンス要件を確認する。
特に個人情報・決済・医療データを扱うシステムはリリース前の確認事項が増える。

---

### 5. 曖昧な発言の複数解釈処理

ユーザーの発言に複数の解釈が可能な場合、解釈を並べて確認する。

---

### 6. ステークホルダーの網羅

リリース担当者・承認者・監視担当者・サポート担当者の役割を明確にする。

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

# リリース計画スキル

リリース前確認（機能・品質・インフラ）、本番デプロイ手順、ロールバック手順、監視設定、CHANGELOGを含む包括的なリリース計画書を生成する。

**このスキルが解決する問題：**
- リリース当日に確認事項が漏れて障害が発生する
- ロールバック手順が事前に準備されておらず、障害対応が長引く
- 変更内容が記録されず、後から「何を変えたか」が追えない

---

## ⛔ 絶対ルール

**STEP 1の確認ブロックを出力したら、必ずそこで止まること。**

ユーザーが「STEP 2へ」と指示するまで、絶対に次のSTEPに進んではならない。

---

## API-First Phase 順序（v3.1 必須・デフォルト）

task-decomposition skill で `decomposition_mode: api_first` が選択された場合、リリース計画は以下の **6 Phase 順序で固定** する。各 Phase の完了条件と次 Phase 解禁条件を機械判定可能な形で組み込むこと。

```
Phase 1: Foundation
  完了条件: CI/CD 緑 / lint 緑 / 型 緑 / coverage gate 動作
  次解禁: Phase 2

Phase 2: Data Layer
  完了条件: 全 N エンティティ migration 適用 / 全 RLS ポリシー適用 /
            RLS 越境試験 PASS / シード投入成功
  次解禁: Phase 3

Phase 3: API Layer
  完了条件: 全 N endpoint 実装完了 / OpenAPI 仕様 100% 網羅 /
            contract test 全件 PASS / 監査ログ統合済 /
            画面 ↔ API カバレッジ 100% (screen-api-coverage.json)
  ★ API 契約凍結ポイント ★
  以後の API 変更は ADR + 影響解析 + 承認フロー必須
  次解禁: Phase 4

Phase 4: UI Foundation
  完了条件: レイアウト / ナビ / 共通 component / 型安全 API クライアント生成
  次解禁: Phase 5

Phase 5: UI Parallel
  完了条件: 全 N 画面が実装完了 / モック ↔ 実装 diff PASS /
            各画面が 3-tier AC PASS / 並列度上限を超えていない
  次解禁: Phase 6

Phase 6: Integration & Polish
  完了条件: E2E 全件 PASS / 横断試験 PASS (RLS 越境・性能・a11y) /
            cleanup 完了 / 本番デプロイ準備完了
  → 本番リリース可能化
```

**各 Phase 完了時のリリース計画書出力**:
- Phase 1-2 完了時: 内部マイルストーン（外部公開なし）
- Phase 3 完了時: **API 凍結マイルストーン**（OpenAPI 仕様公開可、SDK 配布準備可）
- Phase 4-5 完了時: ベータリリース候補（限定ユーザーに公開）
- Phase 6 完了時: **本番リリース**（全機能・全画面利用可能、SLA 適用開始）

**Vertical Slice モード時**: 上記 6 Phase ではなく、機能領域別の slice 完成を 1 マイルストーンとする従来型のリリース計画を生成。

---

## テンプレートファイル（assets/）
- `assets/release-template.md` — リリース計画書テンプレート（Markdown版）
- `assets/release.html` — リリース計画書HTMLドキュメント（印刷対応・チェックボックス付き）

STEP 3の最終出力では、Markdownドキュメントと HTMLドキュメント（release.html）の両方を生成すること。

---

## CHANGELOG形式（Keep a Changelog準拠）

```markdown
## [バージョン] - YYYY-MM-DD

### Added（新機能）
- [新たに追加した機能]

### Changed（変更）
- [既存機能の変更]

### Fixed（バグ修正）
- [修正したバグ]

### Deprecated（非推奨）
- [将来削除予定の機能]

### Removed（削除）
- [削除した機能]

### Security（セキュリティ）
- [セキュリティ関連の修正]
```

---

## STEP 1: リリース情報の確認

**このSTEPでやること：**
リリースに必要な基本情報を収集・確認する。

**確認項目：**
1. **バージョン番号** — セマンティックバージョニング（MAJOR.MINOR.PATCH）
2. **リリース日時** — 本番デプロイの予定日時とタイムゾーン
3. **リリース担当者** — デプロイ実施者・承認者・監視担当者
4. **変更内容** — このリリースに含まれる変更（機能追加・修正・削除）
5. **影響範囲** — どのシステム・サービスに影響するか
6. **メンテナンスウィンドウ** — サービス停止が必要か・停止時間はどの程度か
7. **ロールバック条件** — どの状態になったらロールバックを判断するか
8. **環境情報** — デプロイ先の環境（ステージング確認済みか）

**出力形式：**

```
## リリース情報確認

### 基本情報
- バージョン: v〇.〇.〇
- リリース日時: YYYY-MM-DD HH:MM（JST）
- リリース担当: 〇〇（デプロイ）/ 〇〇（承認）/ 〇〇（監視）

### 変更内容サマリー
**Added（新機能）:** 〇件
**Changed（変更）:** 〇件
**Fixed（バグ修正）:** 〇件
**Security（セキュリティ）:** 〇件

### 影響範囲
（影響するシステム・API・データベース・外部サービス）

### メンテナンスウィンドウ
- サービス停止: 必要 / 不要
- 停止時間（見込み）: 〇分

### ロールバック条件（ドラフト）
（どの状態になったらロールバックを判断するか）

### 不明点・確認が必要な事項
（未確認の情報）
```

---

📦 **STEP 1 確認**

リリース情報を確認してください。

- 変更内容に漏れはありませんか？
- 影響範囲の認識に相違はありませんか？
- 問題なければ「STEP 2へ」とお知らせください

**※ STEP 2には進まない。ユーザーの確認を待つ。**

---

## STEP 2: チェックリスト・手順書の作成

**このSTEPでやること：**
リリース前チェックリスト・本番デプロイ手順・ロールバック手順・監視設定を作成する。

**チェックリストカテゴリ：**

### 機能確認
- ステージング環境での動作確認
- 受け入れ基準（AC）の全項目確認
- 新旧機能の互換性確認
- データマイグレーション（ある場合）の確認

### 品質確認
- 全テスト（単体・統合・E2E）のパス確認
- パフォーマンステスト（必要な場合）
- セキュリティスキャン
- アクセシビリティ確認（必要な場合）

### インフラ確認
- 環境変数・シークレットの設定確認
- データベースバックアップの実施
- CDN・キャッシュのパージ計画
- ヘルスチェックエンドポイントの確認

**出力形式：**

```
## リリースチェックリスト・手順書

### ✅ リリース前チェックリスト（本番デプロイ前に全項目を確認）

**機能確認**
- [ ] ステージング環境での動作確認完了
- [ ] 全ACの確認完了
...

**品質確認**
- [ ] 全テストスイートのパス確認
- [ ] セキュリティスキャン完了
...

**インフラ確認**
- [ ] データベースバックアップ実施（バックアップID: ）
- [ ] 環境変数の設定確認
...

### 🚀 本番デプロイ手順

1. [手順1: コマンド or 操作の説明]
2. [手順2]
...

### ⏪ ロールバック手順

**ロールバック判断基準:**
（どの状態になったらロールバックするか）

**ロールバック手順:**
1. [手順1]
2. [手順2]
...

### 📊 リリース後監視設定

- 監視期間: リリース後〇時間
- 確認指標: エラーレート・レスポンスタイム・CPU/メモリ使用率
- アラート閾値: [設定値]
- エスカレーション先: [担当者・連絡先]
```

---

📦 **STEP 2 確認**

チェックリストと手順書を確認してください。

- チェック項目に漏れはありませんか？
- ロールバック手順は実際に実行可能な内容ですか？
- 問題なければ「STEP 3へ」とお知らせください（最終出力を生成します）

**※ STEP 3には進まない。ユーザーの確認を待つ。**

---

## STEP 3: 最終出力（Markdown + HTML + CHANGELOG）

`assets/release-template.md` と `assets/release.html` の構造に沿って、確定したリリース計画書を2形式で出力する。

### 出力①: リリース計画書（Markdown）
release-template.md の `{{変数名}}` を全て実際の値で置き換えて出力する。

### 出力②: リリース計画書（HTML）
release.html の `{{変数名}}` を全て実際の値で置き換えて出力する。チェックボックスは印刷後に手動でチェックできる形式にする。

### 出力③: CHANGELOG（Markdown）
Keep a Changelog形式でCHANGELOGを生成する。既存のCHANGELOG.mdがある場合は、先頭に追記する形式で出力する。

---

## 📦 構造化JSON出力仕様（最終ステップのみ）

```devos-json
{
  "version": "1.0.0",
  "release_date": "YYYY-MM-DD",
  "release_type": "major",
  "phases": [
    {"name": "コードフリーズ", "start": "YYYY-MM-DD", "end": "YYYY-MM-DD", "status": "pending", "tasks": ["タスク1"]}
  ],
  "checklist": [
    {
      "category": "リリース前確認",
      "items": [{"item": "全テストパス", "status": "pending", "owner": "QA"}]
    }
  ],
  "rollback_plan": "ロールバック手順",
  "changelog": ["## v1.0.0\n- 初回リリース"],
  "risks": [
    {"risk": "リスク内容", "mitigation": "対策", "go_nogo_criteria": "Go/No-Go判断基準"}
  ]
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
