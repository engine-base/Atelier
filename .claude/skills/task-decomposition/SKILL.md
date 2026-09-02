---
name: task-decomposition
description: タスク分解スキル。機能分解・API 設計・モックを元に外部実装者が独立実装できる単位までタスク化。v3.1: 3-tier AC (structural/functional EARS/regression)、Foundation 先行、デフォルト API-First モード (全 Backend → 全 UI 並列実装)、Vertical Slice は小規模限定。「タスクに分けたい」「並列開発できる単位にしたい」「エンジニアに渡すカードを作りたい」「チケット化したい」「実装単位を明確にしたい」「受け入れ条件を 3-tier で決めたい」「開発作業を整理」「誰が何をやるか決めたい」「Foundation 先行 + API-First」「Backend を固めてから画面を並列実装」「Contract-First 分解」「CI gate を含めて分解」「EARS 形式 AC」「Foundation → Data → API → UI 共通 → UI 並列」で起動。5STEP 対話。出力 4 形式: タスクカード Markdown + tickets.json + DEPENDENCIES.md + 判断ログ JSON。 v3.2 (2026-09-02): テスト・ラダー L1〜L5 (.claude/rules/common/test-ladder.md) 対応 — テストはタスク分解時に作り、staging で流す。
tab: 実装・分解
builtin: true
prev_skill: feature-decomposition
next_skill: human-grade-qa (test-plan モード)
workflow_position: "6/8"
handoff_flow: "requirements-definition → architecture-design → design-md → ui-mockup → functional-breakdown → feature-decomposition → task-decomposition → human-grade-qa(test-plan) → 実装 → human-grade-qa(実走)"
---

## 🪜 テスト・ラダー（L1〜L5）— このスキルの責務（2026-09-02 追加・必須・省略不可）

> 規約の正本: `.claude/rules/common/test-ladder.md`（ここと矛盾したら規約が勝つ）。
> 由来: 2026-09-02、本番実走で 5 件（保存先バケット未作成 / AI の無言終了 / Bridge 終了後 90 秒の誤表示 /
> モード切替の無視 / 退会後もセッション有効）が出た。5 件とも正本に観点が無く、**実装が全部終わってから
> 「全体」を対象にテストを書いたため細部が抜けた**のが共通原因。テストは **タスク分解の時点で・タスク単位で**
> 作り（L1）、流れ（L2）は揃った瞬間に、Wave / リリース / 全体（L3〜L5）は締めで流す。

### このスキルがやること（タスクカードと **同時に** テストを書く）

1. **STEP 2 で 1 タスク作るごとに `qa_rows.l1` を書く。** 実装後ではない。後回しにした時点で違反。
   手順（タスクごと・省略禁止）:
   - 対象の列挙: `screen_ids` / `entity_ids` / `api_endpoints` / 触る外部リソース（バケット・キュー・秘密・外部 API 設定）
   - 基本の直積: 正常 × 異常（UI / API / データ / 復旧の 4 層）× 境界値 × 権限（ロール × 操作）× 状態（0 件 / 大量 / 重複 / 初回 / 2 回目）× 中断・再開
   - **G-11〜G-15 判定表**（該当 / N/A + 理由。空欄禁止）:
     G-11 外部リソースの実在（環境ごとに 1 行）/ G-12 切り替わりの瞬間（直後・鮮度窓の内側・期限直前）/
     G-13 機能の組み合わせ（このタスク × 実行中・切替・中断・再開・別ロールの操作）/
     G-14 口座状態の波及（退会・停止・権限変更・パスワード変更の後に既存セッション・トークン・接続・共有リンクが無効）/
     G-15 信号なし終了（完了信号が来ない・空・途中で切れる、を成功にしない）
   - 行を **正本に追記**する: 画面行は `<spec>/screens/<画面>.md`（11 列 `… | 備考 | タスク | 実行条件 |`、ID は既存最大 + 1 の 3 桁連番）、
     API/DB の技術行は同じ画面ファイルの技術行か `sweeps/`、AI は `ai-runtime-matrix.md`。`タスク` 列に自分の ID、`実行条件` は `L1`。
   - tickets.json の `qa_rows.l1` に **同じ行 ID** を書く（`qa-ladder.py validate` が両方向を検査。片方だけは fail）。
2. **L2（流れ）を確定する。** feature-decomposition が出した流れ候補（J-xx）ごとに `runnable_after`（揃うべきタスク ID 群）を決め、
   `journeys/plan.json`（`build_plan.py` の `R(..., runnable_after=[...])`）に行を足す。各タスクの `qa_rows.l2_flows` に「このタスクが揃える流れ」を書く。
3. **`status: "todo"` を全タスクに付ける**（jit-task-execution が merge PR で `done` にする。`qa-ladder.py` の解禁判定の正）。
4. 出力条件: `validate.sh`（内部で `qa-ladder.py validate`）PASS。`deliverable_layer` が ui / backend / integration のタスクで `qa_rows.l1` が 0 行なら **そのタスクは未完成**（gate が BLOCK する）。

### tickets.json スキーマ追加（v3.2）

```json
"status": "todo",
"qa_rows": {"l1": ["SA01-031", "SA01-032"], "l2_flows": ["J-10"]}
```

### 禁止

- 「テストは human-grade-qa が後でまとめて書く」— **禁止**。human-grade-qa の test-plan モードは L5（全体監査）と既存プロジェクトの初期化用。
- 行数の目標値を置くこと（件数は直積と G-11〜G-15 の判定から**導出**する）。
- `qa_rows` を空のまま出力すること。


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


## 🔒 恒久ガードレール G1：状態遷移 × 副作用マトリクス（必須・省略不可）

状態遷移を持つ機能（申込/休会/解約/再開/退会/プラン変更/オプション増減/付随サービスの増減など）の AC は
**リストではなくマトリクス**で書く。これを満たさない AC は不完全＝差し戻し対象。

- **行** = その機能の全アクション/遷移（cancel / pause / resume / revert / change / add / remove …）を **1つ残らず**。
- **列** = 各アクションが触れる全副作用サーフェス：
  `DB状態 / 外部課金(サブスク 作成・停止・再開・解約) / 関連サブスク(オプション・付随サービス) / アクセス可否(入室・機能解放・権限付与など) / UI表示 / 通知 / 返金有無`。
- **全セルを EARS で明示**。該当しないセルは「N/A＋理由」を書く（空欄禁止）。
- **対称性ルール（最重要）**：ある副作用（例「課金を止める／再開する」）を1つの遷移に書いたら、
  **同じリソースの全遷移について同じ副作用の有無を必ず解決**する。
  「cancel は課金停止を書いたが pause/resume の課金が未記載」は **即 FAIL**。
- 外部プロバイダ（決済/本人確認/施錠/メール配信など）への副作用は **「DBがこう変わる」ではなく「プロバイダ側がこうなる」** で書く
  （例：決済プロバイダのサブスクが paused / canceled / active へ変わる）。

> 由来（一般例）：定額/サブスク型サービスで『解約』だけ課金停止を AC に書き、『休会/再開』時の課金制御（停止/再開）が漏れて実装・QA を素通りした事故。
> ※この例は説明用。特定プロダクトに依存しない汎用ルールとして全プロジェクトに適用する。


## 全スキル共通：思考品質基準（必ず守ること）

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

悪い仮説：「売上を増やしたい」「効率化したい」（汎用すぎて意味がない）

良い仮説の構造：
- 現状の問題を業務フロー・技術・組織の観点で具体的に示す
- その問題が発生している原因を特定する
- 解決後にどう状態が変わるかを示す

例（ECサイト文脈）：
「現状のフォーム申し込みでは購入完了までのステップが多く、SIM契約と端末購入を同一フローで完結できないため、途中離脱による機会損失が発生している可能性がある」

---

### 3. 質問設計の基準

質問1つに対して、必要に応じてサブ質問（a, b, c）を設ける。
単一の質問だけでは曖昧さが残る場合は必ずサブ質問に分解する。

例：
① 達成したい状態は何ですか？
  - a. 数値目標があれば教えてください（例：月〇件の受注、工数〇時間削減）
  - b. 現在の方法と比べて「何が変わればOK」ですか？
  - c. 「成功した」と判断する基準は何ですか？

---

### 4. ドメインスキャン（出力前に内部実行）

ユーザーの業界・プロジェクト種別を判定し、以下の対応表から該当する規制・制度を確認する。
該当する規制がある場合、質問の中で必ずそのリスク・注意点に触れること。

| ドメイン | 確認すべき法律・規制・制度 |
|---|---|
| EC・通販・ネットショップ | 特定商取引法（表記義務）、景品表示法、個人情報保護法 |
| SIM・通信・MVNO | 電気通信事業法、本人確認（eKYC）義務、特定商取引法 |
| 医療・ヘルスケア | 薬機法、医療法、個人情報保護法（要配慮個人情報） |
| 金融・保険・投資 | 金融商品取引法、保険業法、マネロン防止法（AML）、本人確認義務 |
| 不動産 | 宅建業法、借地借家法、重要事項説明義務 |
| 飲食・食品・EC | 食品衛生法、景品表示法、アレルギー表示義務 |
| 人材・採用・派遣 | 労働者派遣法、職業安定法、個人情報保護法 |
| 教育・子ども向け | 児童福祉法、個人情報保護法（18歳未満の特別保護） |
| SNS・UGC・プラットフォーム | プロバイダ責任制限法、著作権法、不正競争防止法 |
| 予約・マッチング | 特定商取引法、消費者契約法、個人情報保護法 |
| SaaS・BtoB | 下請法（SIer案件の場合）、NDA・秘密保持義務 |

---

### 5. 曖昧な発言の複数解釈処理

ユーザーの発言に複数の解釈が可能な場合、解釈を並べて確認する。
解釈を単一に絞り込まず、「どちらの意味ですか？」と確認する。

例：「個人情報を特定してほしくない」
→ 解釈A：顧客の個人情報をセキュリティ保護・外部漏洩防止したい
→ 解釈B：サイト上の会社名・運営者情報を表に出したくない（非公開にしたい）
→ 解釈C：特定商取引法上の表記義務との関係（法的に一部表示義務がある項目も存在する）

---

### 6. ステークホルダーの網羅

「誰が使うか」だけでなく以下を常に確認する：
- 誰が承認・決裁するか
- 誰が反対・抵抗する可能性があるか
- 誰がシステムを運用・保守するか
- エンドユーザーと発注者が異なる場合、それぞれのゴールは一致しているか

---

### 7. 質問保留・打ち合わせ優先ルール（全スキル共通）

クライアントから以下のような発言があった場合、即座に質問の送信を停止する：
- 「質問は打ち合わせで」「後で回答します」「今は答えられない」「一旦いただいている内容だけ」
- 「確認できたらまた連絡します」「今日はここまでにしましょう」「次回のMTGで」
- 「質問は後ほど」「今はここまで」「打ち合わせで決めましょう」

**この状況での正しい対応：**
1. 現時点で受け取っているすべての情報を整理・構造化して出力する（表・箇条書き）
2. 未確認事項は「打ち合わせで確認する事項リスト」として明示する（質問形式ではなく確認項目として列挙）
3. 次のSTEPへの準備完了を宣言し、クライアントの準備ができ次第進める姿勢を示す
4. 絶対に追加の質問を投げない

**クライアントの会話フロー指示は、スキルのSTEP進行指示より常に優先する。**

---

### 8. 出力フォーマット厳守（最優先ルール）

**スキルモードで動作している場合、出力の冒頭に会話的な前置きを絶対に含めない。**

各STEPの出力は、テンプレートの最初のMarkdown要素（`#`、`##`、`-`、`|` 等）から直接始める。

禁止（冒頭に付けない）：「ありがとうございます」「了解です」「承知しました」「情報を整理します」などの会話的前置き

正しい出力：テンプレートの `##` や `|` から直接開始する

**理由：** スキルの出力は `outputMarkdown` としてDBに保存され、プロジェクト管理ドキュメントとして表示される。

---

# task-decomposition スキル

## このスキルの役割

あなたは **開発リードエンジニア** として動く。機能分解で決まった機能一覧を、「実装者に渡せるタスクカード」まで落とす。

**並列開発文脈におけるこのスキルの位置付け：**
- 分解されたタスクは、外部の実装者 (もしくは並列セッション) が「全体像を知らなくても」進められる単位になる
- 実装者は機能単位のスライスだけを受け取るため、タスクは完全に自己完結していなければならない
- タスクの境界が曖昧だと、統合時に壊れる

**なぜタスク分解が必要か：**
- 機能分解はまだ「何を作るか」のレベル。タスク分解は「どう作るか・何の作業か」のレベル
- タスクが曖昧なまま実装が始まると、仕様の解釈違いで統合時に手戻りが起きる
- 誰が何をどのくらいで作るかが不明確なままスケジュールは引けない

**v3 で何が変わったか：**

v1/v2 では「test pass + lint pass = done」だったが、画面 / spec / contract drift・API 不在・access policy 漏れが検知されずに done 判定されていた。v3 では:

- **Done 定義を 3-tier に分割**: `structural` (mock/spec/contract/design system 一致) + `functional` (EARS で書く API/access policy spec) + `regression` (test/lint/type check/coverage) を **全部 pass で初めて done**
- **Foundation phase を必ず先行**: lint / 3-tier AC validator / 静的型 / coverage gate を先に完成させ、後続全タスクを CI gate で守る
- **Foundation → Backend → UI の順で deliverable を上げる**: 各タスクに `deliverable_layer` を必ず付与し、下層完了 → 上層着手の順序を強制
- **タスクオブジェクトに spec 紐付け必須**: `screen_ids` / `entity_ids` / `access_policies_required` / `audit_md_path` / `legacy_task_id` を全件埋める
- **audit MD は着手前に手動執筆**: auto-generated は禁止 (generic 文言の隠れ蓑になるため)

**v3.1 で何が変わったか (API-First デフォルト化)：**

v3 ではモード判定なしで「Vertical Slice (画面+API+test を 1 タスク) を default」としていたが、**並列 AI エージェント / 複数 UI クライアント / モック先行のプロジェクトでは Vertical Slice が並列実装時の API 契約衝突を引き起こす** ことが判明。v3.1 では:

- **API-First モードをデフォルト化**: 全 Backend (Data + API + Access Policy) を先に完成させてから、全 UI を並列実装。API 契約 (OpenAPI / TS 型自動生成) が確定してから UI が着手するため、並列度を真に最大化できる
- **モード選択を STEP 1 で明示判定**: プロジェクト特性 (並列 AI / 複数クライアント / モック先行 / 横断的関心事の多さ) でモードを自動推奨
- **Vertical Slice はオプションに格下げ**: 単一クライアント・モック未確定・小規模個人開発に限定
- **Phase 構造を再定義**: Foundation → Data → API → UI 共通基盤 → UI 並列実装 → 結合・E2E の 6 Phase
- **「画面 → 必要 API」逆引きマトリクス必須**: STEP 2 で全画面の必要 API を列挙し、API レイヤで漏れなく実装することを保証

---

## 分解モード選択（API-First vs Vertical Slice）

STEP 1 で必ずこの判定を行い、`decomposition_mode` フィールドに `api_first` または `vertical_slice` を記録する。

### API-First モード（デフォルト推奨）

**該当条件**（1 つでも該当すれば API-First を推奨）:
- ✅ 複数の UI クライアント（Web / モバイル / MCP / 別ポータル / Admin など 2 種類以上）が同じ API を消費する
- ✅ AI エージェント（並列セッション）が画面を並列実装する
- ✅ UI モックが先に完成している、または契約が明示的に定義されている
- ✅ 横断的関心事（RLS / 監査ログ / 認可 / バリデーション / エラーハンドリング）が多い
- ✅ 仕様変更時の影響範囲を最小化したい（契約安定優先）
- ✅ 売却やエンタープライズ提供を視野に入れたエンタープライズグレード SaaS

**Phase 構造（6 Phase）**:

```
Phase 1: Foundation (横断基盤)
  - CI/CD / lint / type check / coverage gate
  - LLMClient 抽象化 / 観測 / メール / 共通ライブラリ
  - デザインシステム統合

Phase 2: Data Layer (全データモデル)
  - 全 N エンティティの migration
  - 全 RLS / アクセスポリシー
  - シードデータ
  → 終了条件: 全 entity 完成 + 全 policy 完成

Phase 3: API Layer (全 API レイヤ)
  - 全 CRUD エンドポイント実装
  - ビジネスロジックサービス
  - 監査ログ・バリデーション・エラーハンドリング統一
  - OpenAPI 仕様完全生成 → TS 型自動生成
  - API 契約テスト網羅
  → 終了条件: 全 API endpoint 動作 + OpenAPI 完成 + TS 型生成済

Phase 4: UI Foundation (UI 共通基盤)
  - レイアウト / ナビゲーション / 共通コンポーネント
  - 認証フロー配管（フロント側）
  - 型安全な API クライアント
  - 共通 hooks / providers

Phase 5: UI Parallel (画面並列実装)  ← AI エージェントが並列爆速
  - 全 N 画面を AI 社員 / 並列セッションで実装
  - 各画面は確定した API + 型を消費するだけ
  - モック ↔ 実装 diff チェック自動
  - 並列度 = 並列セッション数の上限

Phase 6: Integration & Polish
  - E2E テスト網羅
  - 横断試験 (RLS 越境 / パフォーマンス / a11y)
  - デプロイ・監視
  - dead code cleanup
```

**Group 構成**:

| Group | 内容 | deliverable_layer | Phase |
|---|---|---|---|
| **F** Foundation | CI / lint / type check / framework setup / 観測 / メール / LLM 抽象化 | foundation | 1 |
| **D** Data | 全 entity migration + 全 RLS / access policy | foundation | 2 |
| **A** API | 全 endpoint + 全 service + OpenAPI + contract test | backend | 3 |
| **U-shared** UI 共通 | レイアウト / ナビ / 共通 component / API client / 型 | ui | 4 |
| **U-screen** UI 画面 | 各画面 1 タスク（並列実装可） | ui | 5 |
| **I** Integration | E2E / 横断試験 / 性能 / a11y / cleanup | polish | 6 |

**Wave 設計**:

```
Wave 0: Group F (Foundation) — 単独
Wave 1: Group D (全 entity Data Layer) — entity 数だけ並列
Wave 2: Group A (全 API) — endpoint 数だけ並列
Wave 3: Group U-shared (UI 共通基盤) — 並列
Wave 4: Group U-screen (全画面並列) — 画面数だけ並列 (最大並列度)
Wave 5: Group I (結合・E2E)
```

### Vertical Slice モード（限定オプション）

**該当条件**（API-First の条件を一つも満たさない場合のみ）:
- 単一クライアント（Web のみなど）
- モック未確定（モックを画面実装しながら確定していくスタイル）
- 個人開発・小規模で並列性が不要
- プロトタイプ・PoC で迅速に動くものが必要

**Group 構成**（v3 と同じ・後方互換）: A. Foundation / B. Backend Vertical Slice / C. UI Vertical Slice / D. Integration test / E. Polish

### モード判定フロー

```
STEP 1 で以下を確認:
1. UI クライアントは何種類か？ (1 種類 / 2 種類以上)
2. AI エージェント並列実装の予定があるか？ (yes / no)
3. UI モックは既に完成しているか？ (yes / partial / no)
4. RLS / 監査ログ / 認可など横断的関心事は多いか？ (yes / no)

判定:
- 上記のうち 1 つでも (2 種類以上 / yes / yes / yes) があれば → API-First
- すべて (1 種類 / no / no / no) なら → Vertical Slice
- 迷ったら API-First を推奨（後で Vertical Slice に切り替えるより手戻り小）
```

---

## v3 必須ルール

詳細: `references/v3-core.md`
プロジェクト固有値の適用例: `references/profiles/build-factory.md` (例として位置づけ。他プロジェクトは独自 profile を作成可能)

1. **3-tier AC** (structural / functional / regression) を全タスクで生成
2. **Foundation → Backend → UI** の deliverable 順序 (各タスクに `deliverable_layer` 付与)
3. **Vertical Slice** 構成 (1 機能 = 画面 + API + test + access policy を 1 タスクにまとめる)
4. **Wave 単位の並列実行** (project-defined parallel capacity 内に収める)
5. **file-level mutex** で conflict 事前防止
6. **pre-flight audit MD** で着手前確認
7. **CI gate auto-merge** (project-defined gate set、全 pass で初めて main にマージ)
8. **Phase gate 機械判定** (Foundation 完了 / Backend 完了 / UI 完了 / Polish 完了)

---

## 絶対ルール（破ってはいけない）

1. **1STEPずつしか進まない** — STEPを出力したら、その場で必ず止まる。PMからの返答を受け取るまで、絶対に次のSTEPに進まない
2. **最初のメッセージではSTEP 1だけを出力する** — どんなに情報が揃っていてもSTEP 1の出力で止まる。STEP 2以降は「STEP 2へ」という指示を受けてから初めて出力する
3. **曖昧なタスクを放置しない** — 「〇〇を実装する」は曖昧。「どの入力を受け取り・何を処理し・何を返すか」まで落とす
4. **テスト・エラー処理を別タスクとして扱う or vertical slice なら同タスクに統合** — 実装タスクのみで満足してはいけない。Vertical Slice で 1 タスクにまとめる場合は test/error path/access policy を AC に必ず含める
5. **仮説は明示する** — 不明な部分は `【仮説】` とラベルを付ける
6. **3-tier AC を省略しない** — 各タスクの `acceptance_criteria` は `structural / functional / regression` の 3 配列で必ず書く。空でも `[]` を明示 (null/欠落は validator が reject)
7. **Foundation Group を先に完成させる順序を守る** — Foundation 未完成のまま Backend / UI / Polish Group を出力してはならない (CI gate が未整備のままタスク着手 = v1 と同じ失敗)
8. **audit MD パスを必ず生成** — 各タスクに `audit_md_path` を割り当て、着手前に template から作成する旨を STEP 4 で明記する
9. **deliverable_layer を必ず付与** — `foundation | backend | ui | polish` のいずれか。Foundation tasks は他全 Group の prerequisite

## 最上位ルール

- **一気に全部作らない** — STEPごとに出力し、確認を待つ
- **確認なしに次のSTEPに進まない** — 各STEPの末尾で必ず止まる。止まることがこのスキルの最も重要な動作
- **「自動進行」は絶対にしない** — ユーザーから「STEP Nへ」という明示的な指示を受けるまで次のSTEPに進んではならない

---

## 深掘りの考え方

タスク分解で後から「これ決まってなかった」になるパターン：

| 穴の種類 | タスク分解での例 | v3 での防止策 |
|---|---|---|
| **粒度のミス** | 「ログイン機能を実装する」が1タスク → 実際には10タスク以上 | Vertical Slice (画面+API+test) を 1 タスクとしつつ 2〜8h で完了する粒度に |
| **境界の不明確さ** | フロントとバックの境界・モックと本物の境界が曖昧 | `files_changed` に new/modify/delete を明示、`screen_ids` / `entity_ids` で spec 紐付け |
| **受け入れ条件の欠如** | 「実装完了」の定義がない | 3-tier AC (structural/functional/regression) 全部 + EARS 5 形式で必ず書く |
| **エラー処理・テストの後回し** | 正常系だけ実装して「テストは後で」 | regression に test path + coverage 閾値を明記 |
| **依存順序の見落とし** | 依存するAPIが未完成なのに並行で進めようとする | `depends_on` 配列 + Foundation 必須先行 + `deliverable_layer` 順序 |
| **mock / spec との drift** | 画面実装が mock と違う見出し / KPI | Tier 1 structural AC + structural diff gate |
| **access policy 漏れ** | entity 増やしたが policy 書いてない | `access_policies_required` 明記 + Tier 2 functional AC + access policy coverage gate |
| **audit MD の generic 化** | 「shall implement T-XXX as specified」のような無意味な文 | 手動執筆強制 + generic phrase 検出 |

---

## 参照ファイル (references/)

詳細スキーマ・テンプレートは別ファイルに切り出し。STEP 進行中に該当ファイルを Read して内容を反映する：

- `references/v3-core.md` — v3 コア概念集 (汎用): 3-tier AC schema / Foundation→Backend→UI フロー / Vertical Slice / Wave 並列 / file mutex / pre-flight audit MD / CI gate auto-merge / Phase gate 機械判定 / v3 task object schema / Group コード (汎用最小セット A-E)
- `references/profiles/build-factory.md` — Build-Factory profile (例): script path / phase 名 / 並列数 / CI gate 8 件 / rule_id mapping / Group A-J 細分化 / 数値例

他プロジェクトに適用する場合は `references/profiles/<project>.md` を新規作成し、prompt 末尾で「`references/profiles/<project>.md` を適用してください」と指定する。

## テンプレートファイル（assets/）

- `assets/github-issues-template.sh` — GitHub CLI を使ったタスクカード一括作成 (`gh issue create`)
- `assets/notion-import-template.csv` — Notion データベース CSV インポート用テンプレ

STEP 5 の最終出力後、これらに流し込んでチケット管理ツールへ連携可能。

## STEP 構成

---

### STEP 1：タスク分解の方針確認

機能一覧 + API 設計 + (あれば) UI mock を受け取り、タスク分解の前提を整理する。

**出力する内容：**

```
## 入力情報の確認

### 受け取った成果物
| 種別 | パス | 件数 |
|---|---|---|
| 機能一覧 (features.json) | <functional-breakdown path> | N |
| 画面定義 (screens.json) | <functional-breakdown path> | N |
| Entity 定義 (entities.json) | <functional-breakdown path> | N |
| API 設計 (OpenAPI/IDL) | <api-design path> | N endpoint |
| UI mock | <mocks path> | N 件 |
| 既存実装 | <impl repo path> | N module |

### タスク分解の対象範囲
- フロントエンド（画面実装）：あり / なし
- バックエンド（API ロジック）：あり / なし
- DB（schema・migration・access policy）：あり / なし
- インフラ（lint / CI / validator）：あり / なし
- テスト（unit / 統合 / e2e）：あり / なし
- Cleanup（dead code / rename）：あり / なし

## タスク分解方針 (v3.1)

### 0. 分解モード判定（必ず最初に行う）

| 確認項目 | 回答 |
|---|---|
| UI クライアント種類数 | 1 種類 / 2 種類以上 |
| AI エージェント並列実装の予定 | yes / no |
| UI モック完成状況 | 完成 / 一部 / 未着手 |
| 横断的関心事の多さ | 多い / 少ない |

**判定結果（自動推奨）**:
- 1 つでも 「2 種類以上 / yes / 完成 / 多い」 → **`decomposition_mode: api_first`**（デフォルト）
- すべて 「1 種類 / no / 未着手 / 少ない」 → **`decomposition_mode: vertical_slice`**

### 1 タスクの粒度基準
- 1 並列セッション (= 1 人のエンジニア相当) が 【仮説：2〜8 時間】 で完了できるサイズ
- **API-First モード**: 1 タスク = 1 layer の責務（migration / endpoint / component など）。並列度が高く設計しやすい
- **Vertical Slice モード**: 1 タスク = 1 機能 (画面+API+test+access policy)
- 独立してレビュー・テストできる単位

### Done 定義 (3-tier AC 全 pass)
- **Tier 1 structural**: mock / spec / contract / design system と impl の一致 (UI / API task のみ)
- **Tier 2 functional**: EARS で書く API/access policy spec が backend で動く
- **Tier 3 regression**: test runner + lint + type check + coverage 閾値 pass

### Phase 順序（API-First デフォルト）

全タスクに `deliverable_layer: foundation | backend | ui | polish` を付与し、Phase 順に Wave 化:

```
Phase 1 (Foundation) → Phase 2 (Data) → Phase 3 (API) → Phase 4 (UI 共通) → Phase 5 (UI 並列) → Phase 6 (結合)
```

- **Foundation phase (Phase 1)** を必ず最初に完成
  - CI/CD / lint / type check / coverage gate / framework setup
  - access control framework / audit infrastructure
- **Data Layer phase (Phase 2)** で全 entity の migration + RLS を完成
- **API Layer phase (Phase 3)** で全 endpoint + OpenAPI 完成 → TS 型自動生成まで
- **UI Foundation (Phase 4)** で UI 共通基盤
- **UI Parallel (Phase 5)** で画面並列実装（並列度最大）
- **Integration (Phase 6)** で結合・E2E・性能

### 外部実装者 / 並列セッションへの渡し方針
- 各タスクは spec_links / screen_ids / entity_ids 込みで自己完結
- 全体リポジトリは見せず、機能単位のスライスで渡す
- モック/スタブの境界を明確にする
- `audit_md_path` を着手前に template から生成する旨を明記

### 提案する Group 構成

**API-First モード（推奨デフォルト）**:

| Group | 内容 | deliverable_layer | Phase | 概算件数 |
|---|---|---|---:|---:|
| **F** Foundation | CI / lint / type check / framework setup / 観測 / メール / LLM 抽象化 | foundation | 1 | N |
| **D** Data | 全 entity migration + 全 RLS / access policy | foundation | 2 | N |
| **A** API | 全 endpoint + 全 service + OpenAPI + contract test | backend | 3 | N |
| **U-shared** UI 共通 | レイアウト / ナビ / 共通 component / API client / 型 | ui | 4 | N |
| **U-screen** UI 画面 | 各画面 1 タスク（並列実装可） | ui | 5 | N |
| **I** Integration | E2E / 横断試験 / 性能 / a11y / cleanup | polish | 6 | N |

**Vertical Slice モード（限定）**:

| Group | 内容 | deliverable_layer | 概算件数 |
|---|---|---|---:|
| A. Foundation | lint / AC validator / type check / coverage gate / framework setup | foundation | N |
| B. Backend | data + service + API + contract test (Vertical Slice 込み) | backend | N |
| C. UI | component + state + UI test | ui | N |
| D. Integration test | cross-slice E2E + access policy matrix | backend | N |
| E. Polish | perf / security / docs / drift fix / cleanup / rename | polish | N |

(プロジェクト profile で細分化する場合は profile を参照。例: `references/profiles/build-factory.md` は細分化済み)

## 確認事項
（不明・曖昧な部分の質問）
```

**深掘りチェック（STEP 1で必ず確認すること）：**

| チェック項目 | 確認ポイント |
|---|---|
| **分解モード判定（最重要）** | api_first / vertical_slice のどちらか。プロジェクト特性から自動推奨し、ユーザー承認を取る |
| Foundation 先行を採用するか | Foundation Group を必ず最初に完成させる方針で OK か (推奨: yes) |
| 3-tier AC を採用するか | structural / functional / regression を必須にするか (推奨: yes) |
| `deliverable_layer` を全タスクに付与するか | foundation/backend/ui/polish を必須にするか (推奨: yes) |
| 既存実装の扱い | REUSE / REFACTOR / ARCHIVE / FIX のうちどれを許可するか |
| audit MD の運用 | 着手前 template 生成 + 手動執筆を必須にするか (推奨: yes) |
| CI gate 構成 | project-defined N gate のうち削減するものはあるか |
| Group 構成 | API-First → F/D/A/U-shared/U-screen/I / Vertical Slice → A-E。プロジェクトで増減や profile 適用検討 |
| 並列度 | 並列セッション数の上限 (project-defined parallel capacity) |
| プロジェクト profile 適用有無 | `references/profiles/<project>.md` を適用するか (なければ完全汎用で進む) |
| **画面 ↔ API 逆引きマトリクス** | API-First モード時、全画面が必要とする API を逆引きでリスト化（STEP 2 で必須出力） |

**STEP 1を出力したら必ずここで止まる。STEP 2には進まない：**

```
---
STEP 1 確認
タスク分解の方針を確認してください。
- **分解モードは api_first / vertical_slice どちらにしますか？**（プロジェクト特性から自動推奨済）
- Foundation 先行 / 3-tier AC / deliverable_layer は採用で OK ですか？
- Group 構成（API-First: F/D/A/U-shared/U-screen/I, Vertical Slice: A-E）に追加・削除はありますか？
- CI gate の構成 (project-defined gate set) を変更しますか？
- プロジェクト profile (references/profiles/<project>.md) を適用しますか？
- 問題なければ「STEP 2へ」とお知らせください

※ 回答をいただいてから次のSTEPに進みます
---
```

---

### STEP 2：タスク分解（最重要）

確認後、各 Group を実装作業単位に分解する。**Foundation Group から順に** 出力する。

**タスク設計の原則：**
- 各タスクは 2〜8 時間で完了する粒度
- Vertical Slice (画面 + API + test + access policy) を default とする
- ただし infra/lint/validator/DB schema は独立タスク
- 並列実行可能なタスクを意識して設計する (依存最小化)
- 各タスクは `references/v3-core.md` の v3 task object schema 全フィールドを埋める
- `deliverable_layer` を必ず付与し、Foundation tasks は他全 Group の prerequisite として `depends_on` で参照させる

**Web リサーチ (STEP 2 で実施):**
工数見積もりの精度向上のために調査:
- 採用技術スタックの実装工数ベンチマーク (例: 「<framework> 認証実装 工数」)
- 類似プロジェクトの分解例

調査結果はデータ蓄積 JSON の `research` フィールドに保存。

**各タスクの分解フォーマット (Group ごと):**

```
## Group X: [Group 名] (deliverable_layer: foundation|backend|ui|polish)

### T-<group_code>-NN: [タスク名]
- category: backend | frontend | db | test | infra | cleanup
- label: NEW | REFACTOR | REUSE | ARCHIVE | FIX
- deliverable_layer: foundation | backend | ui | polish
- phase / wave / estimate_hours / estimate_sessions

**タスクの目的：** (このタスクが何を完成させるか・1 文で)

**実装内容：**
- 具体的な実装項目を箇条書き

**screen_ids / entity_ids / feature_id：**
- screens: [S-XXX]
- entities: [E-XXX <Name>]
- feature: F-XXX

**files_changed：**
- <backend impl path> (new|modify|delete)
- <frontend impl path> (new|modify|delete)
- <test path> (new)

**依存タスク (depends_on):** T-<group_code>-MM が完了していること (Foundation tasks 含む)

**受け入れ条件 (3-tier AC):**

Tier 1 — structural (UI / API task のみ; 他は `[]`)
- [ ] STATE-DRIVEN: While [page] is rendered, the system shall display ... (matching mock / spec)
- [ ] STATE-DRIVEN: ... KPI labels matching spec
- [ ] (API task) UBIQUITOUS: The system shall expose the endpoint as defined in <OpenAPI spec path>

Tier 2 — functional (EARS 5 形式)
- [ ] EVENT-DRIVEN: When [API endpoint] is called by [role], the system shall return [status+payload]
- [ ] UNWANTED: If [unauthorized condition], the system shall return [4xx]
- [ ] (access policy) UBIQUITOUS: The system shall enforce row-level access control via [policy_name] on [table]

Tier 3 — regression (project-defined gate set 逐語)
- [ ] <test_runner> backend test PASS (>= N test cases)
- [ ] <type_checker> 0 errors on touched files
- [ ] coverage >= <threshold>% on touched files
- [ ] <lint_runner> N/N OK
- [ ] <ac_validator> PASS for this task
- [ ] <audit_md_validator> PASS for audit_md_path
- [ ] <access_control_verifier> PASS for entities
- [ ] <mock_impl_diff> PASS for screen_ids (if structural nonempty)

**access_policies_required：**
- [table]:[policy_name] (例: accounts:account_owner_select)

**spec_links：**
- <ADR path>
- <mock / spec path>

**audit_md_path：** <audit_dir>/T-<group_code>-NN.md
(着手前に template から生成、3-tier AC を逐語埋め込み)
```

**STEP 2 の見落としチェック（必ず確認すること）：**

| チェック項目 | 見落とし例 | v3 での検知 |
|---|---|---|
| 正常系だけでなくエラーケースのタスクはあるか | 401/403/429/500 の処理 | Tier 2 UNWANTED で必須 |
| ローディング/空状態の UI タスクはあるか | データ取得中・0 件の表示 | mock に書いてあれば Tier 1 structural |
| 共通コンポーネントが重複していないか | 同じ Button/Input を独立に作る | files_changed に共通 path で衝突検知 |
| レスポンシブ対応のタスクはあるか | PC だけ実装してモバイル忘れ | mock がモバイル含むなら Tier 1 で検知 |
| 認証・権限チェックのタスクはあるか | API endpoint に auth middleware | Tier 2 UNWANTED (access policy) + access control coverage gate |
| テストタスクはあるか | 「実装と一緒にやる」で後回し | Vertical Slice なら同タスク内に test path + coverage AC |
| audit MD タスクはあるか | 「実装したら後で書く」で消失 | 各タスクに audit_md_path 必須 |
| Foundation gate のための infra タスクはあるか | lint script 書いてない | Foundation Group 必須先行 |
| `deliverable_layer` 付与漏れ | 順序が壊れる | 全タスクに必ず付与 |

**STEP 2を出力したら必ずここで止まる。STEP 3には進まない：**

```
---
STEP 2 確認
タスク分解を確認してください。
- Group ごとの粒度・内容に過不足はありますか？
- 3-tier AC の各項目に不明確な部分はありますか？
- depends_on / access_policies_required / deliverable_layer の漏れはありますか？
- 問題なければ「STEP 3へ」とお知らせください

※ 回答をいただいてから次のSTEPに進みます
---
```

---

### STEP 3：依存 DAG / Wave 設計 (並列実行プラン)

確認後、タスク間の依存と Wave 構成を整理する。Foundation phase (Foundation Group) を **必ず最先行 Wave 0** に固定。

**出力する内容：**

```
## 依存 DAG

### 簡略ツリー
[Wave 0: Foundation phase]
  T-FOUNDATION-01 (lint / AC validator) ─┐
  T-FOUNDATION-02 (type check / coverage) ┤
  T-FOUNDATION-03 (access control framework) ┼─→ [Wave 1 解禁]
  T-FOUNDATION-04 (audit infrastructure) ┘

[Wave 1+: Backend phase per slice]
  Group B-1 (N task) ──┐
  Group D-1 (N) ───────┼─→ [Wave N 解禁]
  ...                  ┘

[Wave N: UI phase per slice]
  Group C-1 (N) ──┐
  Group C-2 (N) ──┼─→ [Wave M]
  ...

[Wave M: Polish phase]
  Group E (N) ─── final

### ブロッキングタスク（これが終わらないと他が動けない）
| タスクID | タスク名 | ブロックする範囲 |
|---|---|---|
| T-FOUNDATION-01 | lint / AC validator 整備 | 全 Backend / UI Group |
| T-FOUNDATION-02 | type check / coverage gate | 全 PR |

### Wave 設計 (project-defined parallel capacity 前提)
| Wave | 内容 | 含む Group | task 数 | 所要時間 |
|---|---|---|---:|---|
| 0 | Foundation phase | A | N | 2-4h |
| 1 | Backend phase (slice 1) | B / D | N | 4h |
| 2 | UI phase (slice 1) + Backend (slice 2) | C / B | N | 4h |
| 3 | Backend (slice N) | B / D | N | 4h |
| 4 | UI (slice N) | C | N | 4h |
| 5 | Polish phase | E | N | 3-4h |
| 6 | Final validation | (全 gate 確認) | - | 2h |

### 失敗時の retry プロトコル
1. CI が PR コメントに失敗内容貼る
2. orchestrator が同じ task の retry session を起動
3. N 回連続失敗 (project-defined、典型 3 回) → human エスカレーション

### CI gate (各 PR で必須)
references/v3-core.md の汎用 gate カテゴリ、または project profile の gate set を全 PR に適用。
全 PASS → auto-merge / 1 つでも fail → bot がコメント + retry。
```

**深掘りチェック（STEP 3で必ず確認すること）：**

| チェック項目 | 確認ポイント |
|---|---|
| Foundation phase が Wave 0 単独か | Foundation 完了前に Backend / UI を着手していないか |
| 依存が循環していないか | DAG として閉路を持たない |
| ブロッキングタスクにリスク集中していないか | 依存が多いタスクが遅れると全体停止。バッファ or 優先度上げ |
| 並列度の上限を超えていないか | 各 Wave のタスク数 ≤ project-defined parallel capacity |
| 同じ DB table を同時に触る並列タスクは無いか | migration 番号 / DB Group は順序保証 |
| audit MD タスクが各タスクに紐付いているか | 全 task に audit_md_path |
| `deliverable_layer` の順序が守られているか | foundation → backend → ui → polish の順序で Wave に並ぶ |
| file-level mutex で conflict 事前防止できているか | 同 file を 2 タスクが同時に触らない |

**STEP 3を出力したら必ずここで止まる。STEP 4には進まない：**

```
---
STEP 3 確認
依存 DAG と Wave 構成を確認してください。
- Foundation phase 単独で Wave 0 を埋める方針で OK ですか？
- Wave 1+ のタスク配分・並列度に違和感はありますか？
- ブロッキングタスクへのリスク対策は十分ですか？
- file-level mutex 設計は十分ですか？
- 問題なければ「STEP 4へ」とお知らせください

※ 回答をいただいてから次のSTEPに進みます
---
```

---

### STEP 4：タスクカード化（外部実装者 / 並列セッションへの渡し単位）

確認後、各タスクを「全体像なしに進められる完全自己完結カード」に仕上げる。**v3 task object schema 全フィールド** + **audit MD template** を生成。

**出力する内容（1 タスクあたり）：**

```
---
## タスクカード：T-<group_code>-NN

### メタ情報
- id: T-<group_code>-NN
- title: <タスク名>
- category: backend | frontend | db | test | infra | cleanup
- label: NEW | REFACTOR | REUSE | ARCHIVE | FIX
- feature_id: F-XXX
- screen_ids: [S-XXX]
- entity_ids: [E-XXX <Name>]
- legacy_task_id: T-XXX-NN | null
- phase: <phase_name (project-defined)>
- wave: N
- group: A | B | ... 
- deliverable_layer: foundation | backend | ui | polish
- estimate_hours: N
- estimate_sessions: ceil(estimate_hours / 4)
- depends_on: [T-<group_code>-MM]
- spec_links: [...]
- audit_md_path: <audit_dir>/T-<group_code>-NN.md

### 背景・目的
（全体設計のどこに位置するか・全体リポを見なくても理解できる説明）

### 実装仕様

**入力 (受け取るもの):**
- API リクエスト型 / Props / parameters (型・バリデーション・必須/任意を明記)

**処理内容:**
- 何をするか・3〜5 ステップで

**出力 (返すもの・変化するもの):**
- レスポンス型 / 画面の変化 / DB の変化 / access policy 適用後の結果

### files_changed
- <backend impl path> (new)
- <frontend impl path> (new)
- <migration path> (new)
- <test path> (new)

### インターフェース（モック / 依存 API）
```typescript
// このタスク単独で動作確認するためのモック
const mockGetUser = async (id: string): Promise<User> => ({...});
```

### エラーケース
| ケース | 入力 | 期待動作 | 検出 AC |
|---|---|---|---|
| 認証なし | Authorization なし | 401 | Tier 2 UNWANTED |
| 不正な入力 | <field> 不正 | 400 + validation msg | Tier 2 UNWANTED |
| access policy 越境 | 他 account の id | 403 | Tier 2 UNWANTED + access control coverage gate |

### 🔒 AC 生成ガードレール：「描画」で合格を出せる AC を作るな（★事故由来・必須）

> 由来: ScoliVio で全チケットに監査記録あり・ユニットテスト200本超が緑・CI全green・
> ビジュアルパス完了の状態で、実機QAにより**製品バグ30件**（ユーザーが確実に詰むもの7件・
> セキュリティ2件）が出た。原因は **AC が「画面が描画される」「モック構造に一致する」で
> 合格を出せた**こと。tickets.json の AC を変えない限り同じ漏れは必ず再発する。

UI/画面タスクの AC を書くときは、以下を**必ず**含める（含まれない AC は不完全＝差し戻し）:

| # | 必須観点 | 悪い AC（描画止まり） | 良い AC（動作を検証できる） |
|---|---|---|---|
| 1 | 操作の結果 | 「保存ボタンが表示される」 | 「保存したとき、DBに反映され**別GETで再取得した一覧に現れる**」 |
| 2 | 到達性 | 「ナビに項目がある」 | 「ナビ項目の href が**実在ルート**で、押すと200で表示される」 |
| 3 | API結線 | 「一覧APIが200」 | 「related_apis の各エンドポイントが**UIのどの操作から呼ばれるか**特定できる」 |
| 4 | 値の実在 | 「信頼度列が表示される」 | 「信頼度列に**実データの値**が入る（`—`固定でない）」 |
| 5 | メッセージ到達 | 「エラー時に表示」 | 「未入力で送信すると**その文言が実際に出る**（ネイティブ検証に奪われない）」 |
| 6 | 防御の層数 | 「不正値は保存できない」 | 「不正値は **UI/API/DB の3層**で拒否される」 |
| 7 | 共通要素 | 「タブレットで崩れない」 | 「共通ヘッダを含む**全画面**で `scrollWidth - clientWidth <= 1`」 |
| 8 | 仕様states対応 | （記載なし） | 「仕様の states / transitions が**実装のどこに対応するか**を示せる」 |

**「ユニットテストが緑」は上記の代替にならない**: テストランナー（jsdom等）は
(a) ブラウザ標準のフォームバリデーション (b) UI/チャートライブラリのポインタイベント
(c) mousemove由来のホバー・アクティブ状態 (d) 実レイアウト幅 (e) 実DB制約 を再現しないため、
**実機で死ぬ実装がユニットテストでは原理的に緑になる**。だから Tier 3 に AC-R9（動作実証）を置く。

さらに **`files_changed_predicted` に共通シェル（ヘッダ/ナビ/レイアウト）が含まれるタスクは、
AC に「そのシェルを含む全画面での確認」を明記**する（1画面での確認で合格にしない）。

類型と検出手段: [rules/common/lessons-learned.md](../../.claude/rules/common/lessons-learned.md) L-003 G-01〜G-10

### 受け入れ条件 (3-tier AC)

**Tier 1 — structural** (UI / API task のみ; backend-only / infra は `[]`)
- [ ] AC-S1: STATE-DRIVEN ...
- [ ] AC-S2: ...

**Tier 2 — functional** (EARS 5 形式)
- [ ] AC-F1: EVENT-DRIVEN ...
- [ ] AC-F2: UNWANTED ...
- [ ] AC-F3: UBIQUITOUS ... (access policy)

**Tier 3 — regression** (project-defined gate set 逐語)
- [ ] AC-R1: <test_runner> backend test >= N tests PASS
- [ ] AC-R2: <type_checker> 0 errors
- [ ] AC-R3: coverage >= <threshold>%
- [ ] AC-R4: <lint_runner> N/N OK
- [ ] AC-R5: <ac_validator> PASS
- [ ] AC-R6: <audit_md_validator> PASS for audit_md_path
- [ ] AC-R7: <access_control_verifier> PASS for entity_ids
- [ ] AC-R8: <mock_impl_diff> PASS (if Tier 1 nonempty)
- [ ] **AC-R9: 動作実証（UI/画面タスクは必須）** — 実ブラウザで当該画面の全操作要素を実際に押し、
      押した結果（遷移 / DB反映 / 表示変化）を確認。書き込みは**別GETで再取得**して反映を確認。
      ナビ/リンクの href が**実在ルート**であることを機械照合。
      ※ ユニットテストが緑でも AC-R9 は代替できない（後述の理由）

### access_policies_required
- table:policy_name (例: accounts:account_owner_select)

### audit MD template (着手前に生成)

`<audit_dir>/T-<group_code>-NN.md`:

```markdown
# T-<group_code>-NN audit

## Tier 1: Structural
- [ ] AC-S1: <EARS text> → impl line: <file>:<lines>

## Tier 2: Functional (AC verbatim)
- [ ] AC-F1: <EARS text> → impl line: <file>:<lines>

## Tier 3: Regression
- [ ] test runner: N/N PASS
- [ ] coverage: NN% (>= threshold)
- [ ] type checker: 0 errors
- [ ] lint: K/K OK
- [ ] **AC-R9 動作実証（UI/画面タスク）**: 押した操作要素=[...] / 結果=[...] / 確認方法=[実ブラウザ・別GET・DB照会]
- [ ] (その他 gate)

## Decision: DONE | BLOCKED | GAP
```

### 渡すファイル・ブランチ
- branch: <vcs prefix>/T-<group_code>-NN
- starter files: <既存ファイルから差分の起点となるパス>

### Risk flags (該当する場合)
- ブロッキング: 依存タスク N 件 / 遅延すると Wave M 全停止
- 粒度大: estimate_hours > 8 / 分割検討
- スキル不足: 技術 X が未経験 / 並行で調査タスク必要
---
```

**深掘りチェック（STEP 4で必ず確認すること）：**

| チェック項目 | 確認ポイント |
|---|---|
| 全体図を見なくても「このタスクだけ」で着手できるか | 「隣の機能を見れば分かる」は不可 |
| モック/依存 API が具体的な型で定義されているか | `any` や「適当に返す」は不可 |
| 3-tier AC 全項目が EARS 5 形式で書かれているか | 自然文 (例: 「正しく動くこと」) は不可 |
| files_changed に new/modify/delete サフィックスがあるか | 新規 vs 改修の区別が無いと統合時に衝突 |
| audit MD template が 3-tier 全項目で生成されているか | 着手前生成が抜けると後で generic 化する |
| access_policies_required が entity_ids と整合しているか | entity あるのに policy なし = Tier 2 fail |
| `deliverable_layer` が depends_on と整合しているか | UI tasks が Foundation tasks に依存しているか |
| 秘匿情報 (本番 DB password 等) を含んでいないか | 外部に渡すカードに本番情報混入の最終確認 |

**STEP 4を出力したら必ずここで止まる。STEP 5（最終出力）には進まない：**

```
---
STEP 4 確認
タスクカードを確認してください。
- 「全体像なしに進められるか」観点で不明確なカードはありますか？
- 3-tier AC の各項目に追加・変更はありますか？
- audit MD template の項目に過不足はありますか？
- 問題なければ「STEP 5へ」とお知らせください（最終出力を生成します）

※ 回答をいただいてから最終出力を生成します
---
```

---

### STEP 5：最終出力（4 形式同時出力）

「STEP 5へ」の指示を受けたら、以下の 4 形式を一度に出力する。

---

#### 【出力①】タスクカード一覧（PM・実装者向け・Markdown）

```
# [プロジェクト名] v3 タスク分解結果
作成日：YYYY-MM-DD

## サマリー
- 対象機能数：N 件
- 総タスク数：N 件 (Group A:N / B:N / ...)
- カテゴリ別: frontend N / backend N / db N / test N / infra N / cleanup N
- ラベル別: NEW N / REFACTOR N / REUSE N / ARCHIVE N / FIX N
- deliverable_layer 別: foundation N / backend N / ui N / polish N
- 推定総工数：N 時間 (並列セッション換算: N)
- Wave 数：N
- Phase 別: <project-defined phase 名> ごとの件数

## Group 別タスク一覧
### Group A: Foundation
| タスクID | タイトル | category | label | deliverable_layer | est_hr | wave | depends_on |
|---|---|---|---|---|---:|---:|---|

### Group B: ...
（同様）
...

## タスクカード詳細
（STEP 4 の全タスクカード）
```

---

#### 【出力②】tickets.json (3-tier AC schema)

`<task-decomposition output dir>/tickets.json` として保存可能な JSON:

```json
{
  "version": "v3.1",
  "project": "プロジェクト名",
  "created_at": "YYYY-MM-DD",
  "decomposition_mode": "api_first | vertical_slice",
  "api_design_ref": {
    "openapi_path": "<openapi.yaml path, api_first mode only>",
    "screen_api_coverage_path": "<screen-api-coverage.json path, api_first mode only>",
    "contract_frozen_at": "<ISO8601 timestamp, api_first mode only>"
  },
  "summary": {
    "total_tasks": 0,
    "by_group": {"F": 0, "D": 0, "A": 0, "U-shared": 0, "U-screen": 0, "I": 0},
    "by_category": {"frontend": 0, "backend": 0, "db": 0, "test": 0, "infra": 0, "cleanup": 0},
    "by_label": {"NEW": 0, "REFACTOR": 0, "REUSE": 0, "ARCHIVE": 0, "FIX": 0},
    "by_deliverable_layer": {"foundation": 0, "backend": 0, "ui": 0, "polish": 0},
    "by_phase": {"1_foundation": 0, "2_data": 0, "3_api": 0, "4_ui_foundation": 0, "5_ui_parallel": 0, "6_integration": 0},
    "by_screen_coverage": {"covered_screens": 0, "total_screens": 0, "uncovered_screens": []},
    "total_estimate_hours": 0,
    "total_estimate_sessions": 0
  },
  "tasks": [
    {
      "id": "T-FOUNDATION-01",
      "title": "...",
      "category": "infra",
      "label": "NEW",
      "feature_id": null,
      "screen_ids": [],
      "entity_ids": [],
      "legacy_task_id": null,
      "phase": "<phase_name>",
      "wave": 0,
      "group": "A",
      "deliverable_layer": "foundation",
      "estimate_hours": 4,
      "estimate_sessions": 1,
      "depends_on": [],
      "files_changed": ["..."],
      "acceptance_criteria": {
        "structural": [],
        "functional": ["EVENT-DRIVEN: ..."],
        "regression": ["The system shall pass <test_runner> ...", "The system shall pass <type_checker> ...", "..."]
      },
      "access_policies_required": [],
      "spec_links": ["<ADR path>"],
      "audit_md_path": "<audit_dir>/T-FOUNDATION-01.md"
    }
  ]
}
```

---

#### 【出力③】DEPENDENCIES.md (DAG / Wave / CI gate)

```markdown
# v3 Dependencies / Wave Plan

## 物量
| 指標 | 値 |
|---|---|
| 総 task 数 | N |
| 総工数 | N 時間 |
| 並列セッション換算 | N |

## Wave 構成
| Wave | 内容 | Group | deliverable_layer | 並列度 | 所要 |
|---|---|---|---|---:|---|
| 0 | Foundation | A | foundation | N | 2-4h |
| 1 | Backend (slice 1) | B / D | backend | N | 4h |
| ... | ... | ... | ... | ... | ... |

## 依存 DAG (簡略)
[Wave 0: Foundation]
  T-FOUNDATION-01 ─┐
  ...             ─┼─→ [Wave 1 解禁]

## CI gate (project-defined gate set)
references/v3-core.md または project profile の gate set を merge gate に。

## 失敗 retry プロトコル
（N 回連続失敗 → human エスカレーション）
```

---

#### 【出力④】データ蓄積JSON（判断ログ・MCP連携向け）

```json
{
  "meta": {
    "project": "プロジェクト名",
    "created_at": "YYYY-MM-DD",
    "skill_version": "v3-2026-05-16-generalized",
    "total_tasks": 0
  },
  "context": {
    "project_type": "...",
    "team_type": "並列セッション N 並列 (project-defined parallel capacity)",
    "decomposition_granularity": "2-8h / vertical slice",
    "done_definition": "3-tier AC (structural + functional + regression) all pass + N CI gates",
    "deliverable_layer_order": "foundation → backend → ui → polish"
  },
  "decision_log": [
    {
      "decision": "Foundation 先行を採用",
      "reason": "v1 で CI gate 未整備のまま着手して画面 drift 多数発生",
      "alternatives": ["全 Vertical Slice 同時", "Layer 別分離"],
      "tradeoffs": "Wave 0 で 2-4h ブロックが発生するが、その後の漏れゼロ保証で trade off 妥当"
    }
  ],
  "task_patterns": [
    {
      "pattern_name": "Foundation Group A 先行 + Vertical Slice 並列",
      "applicable_to": "spec 厳格 / 並列セッション N 並列 / CI gate 自動化済 のプロジェクト",
      "description": "Foundation phase で全 PR を守る gate を整備してから Backend/UI phase で 1 機能 = 1 タスク並列着手"
    }
  ],
  "risk_flags": [
    {
      "task_id": "T-FOUNDATION-01",
      "risk_type": "ブロッキング",
      "description": "Foundation Group の遅延が全 Wave に伝播",
      "mitigation": "Foundation タスクは最優先 / 並列度上限 + 2 名アサイン"
    }
  ],
  "research": {
    "sources": [{"url": "...", "title": "...", "accessed_at": "YYYY-MM-DD"}],
    "findings": ["..."],
    "research_date": "YYYY-MM-DD"
  }
}
```

---

## このスキルの典型的な使い方

```
PM: 「機能分解 + API 設計が終わった。タスクに落としたい」
 → STEP 1 を出力（止まる）

PM: 「Foundation 先行 / Vertical Slice / 3-tier AC で OK。Group A-E を採用」
 → STEP 2 を出力（Group A から順に / 止まる）

PM: 「Group C のテストをもう少し細かく」
 → 調整して再出力（止まる）

PM: 「STEP 3へ」
 → 依存 DAG + Wave 構成を出力（止まる）

PM: 「STEP 4へ」
 → タスクカード + audit MD template を出力（止まる）

PM: 「STEP 5へ」
 → 4 形式の最終出力 (タスクカード一覧 + tickets.json + DEPENDENCIES.md + 判断ログ)
```

**並列開発文脈での注意点：**

外部実装者 / 並列セッションにタスクを渡す場合、STEP 4 のタスクカードが「唯一の仕様書」になる。「全体を見れば分かる」という設計は禁止。全情報をカードに書くこと。

特に以下を漏らさない:
- 3-tier AC を EARS 5 形式で全 Tier 記述
- audit_md_path を着手前 template 生成
- depends_on を Foundation Group 経由で正しく繋ぐ
- access_policies_required を entity_ids と 1:1 対応
- `deliverable_layer` を必ず付与し、Foundation tasks を prerequisite として参照

---

## 構造化JSON出力仕様（最終ステップのみ）

```devos-json
{
  "tasks": [
    {
      "id": "T-<group_code>-NN",
      "title": "タスクタイトル",
      "description": "詳細説明",
      "status": "todo",
      "priority": "high|medium|low",
      "category": "backend|frontend|db|test|infra|cleanup",
      "label": "NEW|REFACTOR|REUSE|ARCHIVE|FIX",
      "deliverable_layer": "foundation|backend|ui|polish",
      "estimate_hours": 4,
      "estimate_sessions": 1,
      "assignee": "",
      "dependencies": ["T-<group_code>-MM"],
      "tags": ["frontend", "v3"],
      "phase": "<phase_name (project-defined)>",
      "group": "A|B|...",
      "wave": 0,
      "acceptance_criteria": {
        "structural": [],
        "functional": [],
        "regression": []
      },
      "access_policies_required": [],
      "audit_md_path": "<audit_dir>/T-<group_code>-NN.md"
    }
  ],
  "total_hours": 0,
  "phases": ["<project-defined phase 名一覧>"],
  "groups": ["A", "B", "C", "D", "E"]
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

---

## JIT (Just-In-Time) パッケージ生成ポリシー（Atelier 確定方針・該当スキル必須）

実装パッケージ（CLAUDE.md / audit MD / test scenarios）は **静的に N ファイル生成しない**。すべて **tickets.json を単一信頼源**として、Bridge dispatcher が実行時に on-the-fly で生成する。

### 禁止事項（重要）

- ❌ N タスクに対して **N 個の静的 CLAUDE.md を Git に commit** すること
- ❌ N タスクに対して **N 個の静的 audit MD を Git に commit** すること
- ❌ 「sample N 件で代替」「on-demand 生成」を**口実にしてサボる**こと（過去の事故）
- ❌ tickets.json の必須フィールドを `null` / 空のまま残すこと

### 必須事項

#### 1. tickets.json に全情報をインライン化

各タスクに以下フィールドを **全件必須**：

```json
{
  "id": "T-A-18",
  "estimate_hours_human": 14,
  "estimate_hours_ai": 1.17,
  "wall_clock_h_ai": 1.17,
  "ai_acceleration_factor": 12,
  "human_review_h": 0,

  "files_changed_predicted": {
    "new": ["..."],
    "modify": ["..."],
    "shared_read": ["..."],
    "forbidden": ["..."]
  },

  "acceptance_criteria_inline": {
    "tier_1_structural": ["STATE-DRIVEN: ..."],
    "tier_2_functional": [
      {"type": "UBIQUITOUS", "text": "..."},
      {"type": "EVENT-DRIVEN", "text": "..."},
      {"type": "UNWANTED", "text": "...", "critical": true}
    ],
    "tier_3_regression": ["coverage >= 80%", "..."]
  },

  "test_scenarios_inline": [
    {"name": "...", "steps": ["..."], "expected": "..."}
  ],

  "screen_ids": [...], "entity_ids": [...], "feature_ids": [...],
  "ac_path": "...", "audit_md_path": "..."
}
```

#### 2. 必要なファイル（プロジェクトに 5 個だけ）

- `07_tasks/tickets.json`（信頼源・強化版）
- `09_dispatch/CLAUDE.md.template`（差し込みテンプレ 1 個）
- `09_dispatch/scripts/dispatch.sh <TASK_ID>`（JIT 生成 + Claude Code 起動）
- `09_dispatch/scripts/validate.sh`（完全性検証）
- ルート `README.md` + `CLAUDE.md`（新セッション pick up 用）

#### 3. validate.sh での機械検知（CI gate 連動）

```bash
./scripts/validate.sh
# 失敗条件（1 件でもあれば exit 1）:
#   - tasks[].files_changed_predicted が無い/空
#   - tasks[].acceptance_criteria_inline.tier_1/2/3 が無い/空
#   - tier_2 に UNWANTED 句が無い（access policy 保証）
#   - test_scenarios_inline が無い/空
#   - 二軸時間フィールド (_human / _ai / wall_clock / factor) のいずれか欠落
#   - depends_on が DAG として閉じていない（循環）
#   - blocking task で human_review_h = 0
```

CI gate に組み込み、PR で必ず実行。

#### 4. dispatch.sh の動作（参考実装）

```bash
./scripts/dispatch.sh T-A-18
# 1. tickets.json から T-A-18 を抽出
# 2. CLAUDE.md.template に差し込み
# 3. /tmp/atelier-dispatch-T-A-18/CLAUDE.md を生成
# 4. Claude Code を起動（cd して開始）
# 5. 完了後、tmp dir はクリーンアップ
```

#### 5. プレビューモード（人間が中身を確認したいとき）

```bash
./scripts/dispatch.sh --preview T-A-18
# → 標準出力に生成 CLAUDE.md を吐くだけ。実行はしない。
```

### 各スキルでの責務

| スキル | 責務 |
|---|---|
| **task-decomposition** | tickets.json に `files_changed_predicted` / `acceptance_criteria_inline` / `test_scenarios_inline` を **全 task 必須記入**。空欄禁止 |
| **distributed-dev** | CLAUDE.md.template + dispatch.sh + validate.sh の **3 ファイルだけ**生成。静的 N×CLAUDE.md は禁止 |
| **test-verification** | テスト scenarios は **tickets.json#test_scenarios_inline に追記**。別ファイル群を作らない |
| **integration** | 横断テストも tickets.json から JIT で実行 |
| **sprint-planning** | 既存通り（変更不要） |
| **release-planning** | 既存通り（変更不要） |
| **schedule-design** | 既存通り（変更不要） |

### Validation 失敗時の挙動

- validate.sh exit 1 → CI gate FAIL → PR block
- 復旧手順：tickets.json に欠落フィールドを補完 → 再 push

### JIT の利点（採用根拠）

1. **drift 不可**（信頼源単一）
2. **メンテ容易**（仕様変更で 1 ファイル更新）
3. **生成ファイル数 5**（過去案 380+ から大幅削減）
4. **validation 機械化**（サボれない）
5. **新セッション pick up が容易**（README.md → dispatch.sh だけ覚える）

### 過去の失敗例（再発防止）

- 2026-05-20 のセッションで、distributed-dev が「sample 8 件 + on-demand script」と誇張して 182 件をサボった事例あり。
- 同日 task-decomposition が `files_changed_predicted` を 0/190 のまま放置した事例あり。
- これらは validate.sh で機械検知 + 本ポリシーで禁止された。

## ハンドオフ (標準フロー連携)

**順番の正本は `.claude/rules/common/skill-pipeline.yaml`**（`python3 scripts/ci/pipeline-next.py` が次を出す）。要約:

```
S00 hearing (skip 可) → S01 requirements-definition → S02 proposal/estimate (受託のみ)
 → S03 architecture-design (staging 定義まで) → S04 design-md → S05 ui-mockup
 → S06 functional-breakdown → S07 api-design → [S07b spec-sync-orchestrator: 仕様が変わるたび]
 → S08 feature-decomposition (流れ候補 J-xx) → S09 task-decomposition (★ここで L1/L2 のテストを書く)
 → S10 acceptance-criteria (tickets に 3-tier AC が揃っていれば skip) → S11 test-verification (gate 配線)
 → S12 distributed-dev (JIT なら dispatch.sh) → S13 sprint-planning (Wave の qa_scope)
 → ↻ S14 jit-task-execution (1 タスク = 1 PR。STEP 4.5 で L1 + 解禁 L2 を staging で消化・gate PASS)
 → ↻ S15 e2e-journey-walkthrough (揃った流れ = L2) → ↻ S16 human-grade-qa diff (Wave 締め = L3)
 → ↻ S17 release-planning (L4: staging full + 本番スモーク) → S18 human-grade-qa full (L5: 年次)
```

旧図（「実装前に human-grade-qa test-plan でまとめて仕様書を作る」）は **廃止**。テストは S09 で各タスクに付く。

### このスキルの位置
- **前段スキル**: `feature-decomposition`
- **次段スキル**: `human-grade-qa (test-plan モード)`
- **フロー位置**: 6/8

### 完了時のハンドオフ宣言

STEP 5 (最終出力) 完了時、以下を必ず提示する:

```
✅ task-decomposition 完了

📌 次に進めるべきスキル: `human-grade-qa (test-plan モード)`

→ 「次に進む」「human-grade-qa へ」「STEP 1 から」等のキーワードで起動可能。
   別の作業を挟む場合は明示的に指示してください。
```

ユーザーが「次へ」と返答したら、自動で次段スキルを起動する。


---

## 🔌 結線タスクと「stub は完了でない」Done 定義（汎用・再発防止）

> 追加理由: コンポーネント単体の test/lint/type pass を「完了」とすると、**それらを結線して価値が通る経路**（実行ループ・接続→可用性・通し配線）が未実装のまま「全タスク完了」に見える。stub/echo/「Phase-Nで配線」/アダプタ境界throw が done をすり抜ける構造的穴を塞ぐ。

### Done 定義の拡張（全プロジェクト共通）
- コンポーネント単体 pass **に加えて**、**ユーザー価値が通る end-to-end 経路が実際に結線され動く**ことを、最低1つの**結線タスク**で保証する。
- **禁止**: `stub`/`echo`/`"後のPhaseで配線"`/`アダプタ境界が "not configured" でthrowするだけ` を **done にしない**。
- 境界実装(adapter boundary)が妥当な場合でも、**それを実経路へ結線する追跡タスク(wiring ticket)を同時に必ず起票**する。追跡タスクが無い境界止まりは**そのタスク自体が未完**。

### 結線タスクの型（`deliverable_layer: integration` / 汎用）
- 実行/イベントループ（要求→処理器選択→実行→結果→継続）
- ハンドラ/プラグインの**registry登録 + 呼び出し配線**
- 外部接続(認証済) → **利用可能操作の一覧化・選択・実行**への写像
- 画面 ↔ API ↔ データ層の**通し配線**（モックfetch置換）
- 既存 **stub の実装置換**（"Phase-N stub" を残さない）

### STEP 2 見落としチェックに追加
| チェック | 見落とし例 |
|---|---|
| 結線タスクの欠落 | handler/部品を定義したが **register/呼出が無い** |
| 実行ループ未接続 | 会話/ジョブ/イベントの実行ループに dispatcher 等が**繋がっていない** |
| 接続→可用性の写像欠落 | 「接続したが、その操作を選んで使わせる」導線が無い |
| stub 残置 | 既存 stub/echo を**置換するタスクが無い** |

### JIT 連携
tickets.json の各タスクは `deliverable_layer` を持つ。**integration 層のタスクがゼロの機能**は「部品はあるが動かない」状態を疑い、結線タスクを起票する。
