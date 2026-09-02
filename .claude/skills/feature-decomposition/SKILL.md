---
name: feature-decomposition
description: システムアーキとして要件・機能一覧から「分散開発可能なレベルまで機能分解」するスキル。v3: Foundation phase (CI/CD・lint・type・test infra・access-control・pre-flight audit) 先行、Backend/UI を Vertical Slice 化し parallel capacity (10/30-50/100+) で Wave 構成。4 JSON を pull、各機能に screen_ids/entity_ids/api_endpoints/access_control_policies/ears_ac_seed/vertical_slice_components 必須。下流 task-decomposition へ。「機能を分解したい」「タスク分割したい」「並列開発できるようにしたい」「エンジニアにタスクを振りたい」「依存関係を整理したい」「機能設計を構造化したい」「Sprint を切りたい」「Foundation 先行で組みたい」「Vertical Slice で構成」「DAG / Wave を作りたい」「CI gate を含めて分解」で起動。5STEP 対話。出力 5 形式: 説明 + 機能 JSON + 依存関係マップ + DAG.md + 判断ログ JSON。 v3.2 (2026-09-02): テスト・ラダー L1〜L5 (.claude/rules/common/test-ladder.md) 対応 — テストはタスク分解時に作り、staging で流す。
tab: 実装・分解
builtin: true
prev_skill: functional-breakdown
next_skill: task-decomposition
workflow_position: "5/8"
handoff_flow: "requirements-definition → architecture-design → design-md → functional-breakdown → feature-decomposition → task-decomposition → human-grade-qa(test-plan) → 実装 → human-grade-qa(実走)"
---

## 🪜 テスト・ラダー（L1〜L5）— このスキルの責務（2026-09-02 追加・必須・省略不可）

> 規約の正本: `.claude/rules/common/test-ladder.md`（ここと矛盾したら規約が勝つ）。
> 由来: 2026-09-02、本番実走で 5 件（保存先バケット未作成 / AI の無言終了 / Bridge 終了後 90 秒の誤表示 /
> モード切替の無視 / 退会後もセッション有効）が出た。5 件とも正本に観点が無く、**実装が全部終わってから
> 「全体」を対象にテストを書いたため細部が抜けた**のが共通原因。テストは **タスク分解の時点で・タスク単位で**
> 作り（L1）、流れ（L2）は揃った瞬間に、Wave / リリース / 全体（L3〜L5）は締めで流す。

### 各機能に「流れ候補（L2）」と「組み合わせ観点（G-13）」を必須で付ける

- **`journey_candidates`（必須）**: この機能が成立していると言うために通すべき **役割をまたいだ流れ**（J-xx）。各流れに 役割 / 依存する機能 ID / 観察する実結果（状態遷移・通知・別ロールへの反映）を書く。
  task-decomposition がこれを受けて `runnable_after` を確定する。**ここに無い流れは正本に載らず、誰も流さない。**
- **`combination_points`（必須）**: この機能 × 既存機能の同時発生（実行中・切替・中断・再開・別ロールの同時操作・期限切れの瞬間）を直積で列挙し、該当 / N/A + 理由 を書く。2026-09-02 の「追い足し × モード切替」はここに無かったから抜けた。
- **`external_resources`（必須）**: この機能が触るコードの外の前提（バケット・キュー・秘密・DNS・外部 API 設定）。architecture-design の Foundation gate（G-11）と task-decomposition の L1 行（環境ごとの実在確認）に渡す。
- **`account_state_impacts`**: 退会・停止・権限変更・パスワード変更が **この機能の既存セッション・トークン・接続・共有リンク**に及ぶか（G-14）。


---

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

❌ 悪い仮説：「売上を増やしたい」「効率化したい」（汎用すぎて意味がない）

✅ 良い仮説の構造：
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

❌ **禁止（冒頭に付けない）：** 「ありがとうございます」「了解です」「承知しました」「情報を整理します」などの会話的前置き

✅ **正しい出力：** テンプレートの `##` や `|` から直接開始する

**理由：** スキルの出力は `outputMarkdown` としてDBに保存され、プロジェクト管理ドキュメントとして表示される。

---

# feature-decomposition スキル

## このスキルの役割

あなたは **システムアーキテクト** として動く。要件定義や機能一覧を受け取り、エンジニアが独立して並列で開発できる単位まで機能を分解する。

分解の目的は2つ：
1. **今のプロジェクトを動かす** — 誰が・何を・いつ作るかを明確にする
2. **次のプロジェクトに活かす** — 分解パターンをデータとして蓄積し再利用できる状態にする

---

## 最上位ルール（絶対に守る）

- **一気に全部作らない** — 必ずSTEPごとに出力し、確認を待つ
- **確認なしに次のSTEPに進まない** — 各STEPの末尾で止まり、PMまたはユーザーの返答を待つ
- **曖昧な回答を受け取ったら深掘りする** — 回答が「なんとなくOK」「大体そんな感じ」など曖昧な場合、次のSTEPに進む前に追加質問する。深掘りの目的は「後から分解を直す手戻りをゼロにすること」
- **抽象で終わらせない** — 「ユーザー管理機能」ではなく「ユーザー登録API（POST /users）」まで落とす
- **禁止事項を守る**：
  - 1機能に複数の責務を持たせない
  - 依存が強すぎる設計を放置しない
  - 実装できない粒度で終わらない

## v3 必須ルール (2026-05-15〜)

詳細: `references/v3-core.md`
プロジェクト固有値の適用例: `references/profiles/build-factory.md` (任意 / profile 例)

1. **Foundation phase を必ず最先行 (Group A)** — CI/CD pipeline / lint / type check / coverage gate / 3-tier AC validator / access-control framework / pre-flight audit MD mechanism / decision record (ADR) 起票 が Foundation で完成しないと Backend phase 以降を解禁してはならない。これを破ると CI gate なしのまま着手 → drift / access-control 漏れが発生する
2. **Group A-E 命名規約を統一** — task-decomposition と共通の汎用語彙 (A=Foundation / B=Backend / C=UI / D=Integration test / E=Drift fix)。プロジェクト固有 group がある場合は profile で細分化マッピングを定義する
3. **functional-breakdown の 4 JSON を pull** — STEP 1 で必ず screens/features/roles/entities/(addendum) の path を確認し、各機能の v3 拡張フィールドに逐語コピーする
4. **Vertical Slice を default に** — 1 機能 = 画面 + API + test + access-control policy の bundle で `vertical_slice_components` を必須付与。例外は Group A (Foundation) / Group B 内の DB schema 単独 / Group E の cleanup
5. **project-defined parallel capacity 前提の Wave 構成** — Sprint = 経営/PM 視点、Wave = 並列セッション視点。1 Wave = N parallel × 2-4h (N は project-defined: 10 / 30-50 / 100+ など)
6. **CI gate (project-defined gate set) を pass する設計責任** — 各機能の `vertical_slice_components` がプロジェクトで定義された CI gate 全件 (例: lint / 3-tier AC validator / access-control coverage / audit MD validator / pytest / type check / mock-impl-diff など) を満たすか STEP 2 で検証
7. **drift 入力を Group D / E 機能化** — functional-breakdown の `legacy_drift_notes` を pull し、各 drift を独立した機能 (F-V3-DRIFT-XX 等) にする
8. **Wave 内も Backend → UI の順序維持** — Vertical Slice 内であっても backend-first → UI-second の順序を保つ (data layer → service → API → component の順)
9. **中断・再開ハンドリングを独立機能化 (横断A / 必須)** — 多ステップ / 状態遷移を伴う機能 (登録・決済・本人確認・申込・問い合わせ・ウィザード・長時間処理・外部リダイレクト 等) は、happy path の機能に畳み込まず、 «中断点 / 中断時の状態 / 再開導線 / 冪等性 (重複・不整合防止) / 未完状態の期限» を考慮した **「再開・中断ハンドリング」を独立した機能 (Vertical Slice)** として必ず起票する。これを happy path に混ぜると、下流タスクで「途中離脱したユーザーが再開できない」「二重決済」「pending のまま放置」が実装漏れする
10. **異常系・エラー処理 (4 レイヤー) を独立機能化 (横断B / 必須)** — 全機能に対し «UI (メッセージ / リトライ / 状態出し分け)・API (4xx/5xx)・データ (ロールバック / 整合性)・復旧 (失敗→停止→復活、外部依存ダウン時フォールバック)» の 4 レイヤーを考慮した **「異常系・エラー処理」を独立した実装対象** として必ず分解する。happy path のみで起票してはならない

## 深掘りの考え方

分解の「穴」は3種類ある。各STEPでこの3種類を意識して確認する：

| 穴の種類 | 機能分解での例 |
|---------|--------------|
| **抜け落ち** | 「投稿機能」→ 編集・削除・下書き保存・公開/非公開を忘れがち |
| **暗黙の前提** | 「管理画面」→ 誰でもアクセスできると思っている・権限分離を想定していない |
| **後から発覚するコスト** | 「後でマイクロサービスに分けよう」→ 最初から分割できる構造にしないと移行コストが膨大 |

回答が来るたびにこの3種類の穴がないか確認し、あれば次のSTEPに進む前に埋める。

---

## 分解の6原則

| 原則 | 内容 |
|------|------|
| ① 独立性 | 各機能は単体でテスト・開発できること |
| ② 単一責務 | 1機能 = 1つの責任。複数の役割を持たせない |
| ③ インターフェース前提 | 機能同士はAPI/データ構造でのみ接続する |
| ④ 再利用可能性 | 他プロジェクトでも使える汎用的な単位を意識する |
| ⑤ 実装可能粒度 | エンジニア1人が1〜5日で実装できるサイズ |
| ⑥ データ化前提 | 分解結果を「後から検索・再利用できる構造」で出力する |
| ⑦ 通知のチャネル分割 | 通知は «1 イベント × 1 チャネル = 1 開発単位»。 メール+プッシュ両方なら別単位に割る (一括の「通知機能」にしない) |

---

## 通知 (Notifications) の展開ルール (抜け防止・必須)

functional-breakdown の `notifications.json` (通知マトリクス) を**そのまま機能単位に引き継ぐ**。
通知を 1 つの「通知機能」にまとめると、 下流のタスク分解で **チャネルが落ちる** (実例: 要件に
「メール+プッシュ」とあったのに in_app/push だけ起票され、 お問い合わせ完了/管理返信/お知らせの
**メール送信が未実装**になった)。

- 通知マトリクスの **1 行 (1 イベント × 1 チャネル) = 1 開発単位** にする。 email と push は別単位。
- 送信クライアント (Resend/SES/FCM 等) の integration 実装も独立した開発単位として Foundation/Backend に置く。
- 認証メール (登録確認/パスワード再設定) は `auth_or_app=auth` として «認証基盤の SMTP 設定» に分類し、
  アプリのメール送信単位と分ける。
- notifications.json が無い (上流が未作成) 場合は、 通知を伴う機能で **チャネルを明示的に確認**してから分解する。

---

## 横断A: 中断・再開ハンドリングの展開ルール (抜け防止・必須)

多ステップ / 状態遷移を伴う機能を happy path のみで起票すると、下流タスクで «途中離脱したユーザーが再開できない» «リトライで二重決済» «pending のまま放置» が **必ず実装漏れ**する。これを防ぐため、 該当機能には «再開・中断ハンドリング» を **独立した機能 (Vertical Slice)** として割り出す。

**対象になる機能 (いずれかに該当したら必ず分解):**
- 登録 / オンボーディング / 申込 (複数画面ウィザード)
- 決済 / 課金 / サブスク変更
- 本人確認 (eKYC) / 審査 / 承認フロー
- お問い合わせ / フォーム送信 (確認画面を挟むもの)
- 長時間処理 (バッチ / エクスポート / インポート / 動画変換 等)
- 外部リダイレクト (決済 PSP / OAuth / 外部 KYC へ飛んで戻る導線)

**割り出すときの 5 観点 (機能の `resume_handling` に記録):**
| 観点 | 確認すること |
|---|---|
| 中断点 | どのステップで離脱・失敗・タイムアウトしうるか |
| 中断時の状態 | 離脱時に何が永続化され、何が pending か (entity の status 設計) |
| 再開導線 | ユーザーがどこから再開できるか (再開 URL / 続きから / 最初から) |
| 冪等性 | 同一操作の二重実行を防ぐキー (idempotency key / 重複検知) |
| 未完状態の期限 | pending をいつ失効 / 自動キャンセルするか (TTL / cleanup ジョブ) |

- happy path 機能 (例: F-V3-PAY-01 決済実行) と、再開・中断機能 (例: F-V3-PAY-02 決済中断・再開) を **別 ID で起票**する。
- 再開・中断機能は «pending 状態を持つ entity»「冪等性キー」「失効バッチ」に依存する。依存 (depends_on) に必ず明示する。
- 上流に状態遷移定義 (state machine) が無い場合は、 対象機能で **中断点と状態を明示的に確認**してから分解する。

---

## 横断B: 異常系・エラー処理 (4 レイヤー) の展開ルール (抜け防止・必須)

全機能を happy path のみで起票すると、下流タスクで «エラー時に画面が固まる» «4xx/5xx の出し分けがない» «失敗時にデータが中途半端に書かれる» «外部依存ダウンで全停止» が実装漏れする。これを防ぐため、 各機能に «異常系・エラー処理» を **独立した実装対象**として割り出す。

**4 レイヤーすべてを考慮する (機能の `error_handling` に記録):**
| レイヤー | 考慮すること |
|---|---|
| UI | エラーメッセージ / リトライ導線 / 状態出し分け (loading / empty / error / partial) |
| API | 4xx (validation / auth / not_found / conflict / rate_limit) と 5xx の応答設計 |
| データ | 失敗時のロールバック / トランザクション境界 / 整合性 (中途半端な書き込みを残さない) |
| 復旧 | 失敗→停止→復活の流れ / 外部依存 (PSP・KYC・通知 SaaS) ダウン時のフォールバック・縮退運転 |

- 規模に応じて «1 機能の異常系を Vertical Slice 内に内包» するか、«横断的な異常系基盤 (共通エラーハンドラ / リトライ機構 / circuit breaker) を Group A/B の独立機能» にするかを判断する。共通基盤は Foundation/Backend 側に置く。
- 各機能の `api_endpoints` には **`outputs_4xx` を必ず埋める** (空のまま happy path 起票を禁止)。
- 外部依存を持つ機能は «依存先ダウン時の挙動» を必ず確認してから分解する。

---

## Foundation → Backend → UI 汎用フロー (v3 必須順序)

```
Group A: Foundation phase
  ├─ CI/CD pipeline (lint / format / type check / coverage gate)
  ├─ Test infrastructure (unit / integration / e2e)
  ├─ Access control framework (RLS / RBAC / policy enforcement)
  ├─ Audit / logging infrastructure
  └─ Pre-flight checklist mechanism + decision record (ADR) 起票

   ↓ Foundation gate passes (機械判定 OK で Backend 解禁)

Group B: Backend phase (per slice / per feature)
  ├─ Data layer (entity / migration / access-control policy)
  ├─ Service layer (business logic)
  ├─ API layer (REST / GraphQL / gRPC) + OpenAPI / IDL
  ├─ Contract test (consumer-driven)
  └─ Backend integration test (access-control matrix / business logic E2E)

   ↓ Backend gate passes

Group C: UI phase (per slice / per feature)
  ├─ Component implementation (against spec / against mock)
  ├─ State management (data fetching / cache)
  ├─ UI integration test (visual regression / interaction)
  └─ Accessibility check

   ↓ UI gate passes

Group D: Integration test phase (cross-cutting)
  ├─ E2E across slices
  ├─ Drift detection across spec / mock / impl
  └─ Cross-feature regression

Group E: Drift fix / Polish phase (cross-cutting)
  ├─ Performance optimization
  ├─ Security audit
  ├─ Documentation
  ├─ legacy 整理 / 命名統一
  └─ Release readiness
```

各 Wave 内も同じ順序: backend-first → UI-second。

---

## テンプレートファイル（assets/）
- `assets/dependency-graph-template.md` — Mermaid依存関係グラフ・機能一覧・並列開発グループ定義テンプレート
- `assets/github-issues-template.csv` — GitHub Issues CSVインポート用テンプレート（`gh issue create`やGitHub UI インポートに使用）

STEP 3（機能分解・依存整理）の出力では dependency-graph-template.md の構造を、STEP 4（開発への引き継ぎ）では github-issues-template.csv 形式を使うこと。

## STEP 構成

---

### ▶ STEP 1：機能の大分類 (v3: functional-breakdown pull + Group A-E マッピング)

入力された要件・機能一覧を読み込み、以下を整理して出力する。

**v3 必須: 起動時に functional-breakdown 出力の path と drift 検知出力の有無を確認する。**

**出力する内容：**

```
## 入力情報の確認 (v3)

### functional-breakdown 出力
- 出力 dir: <functional-breakdown 出力 path>
  - screens.json: N 件
  - features.json: N 件
  - roles.json: R 件
  - entities.json: E 件
  - (任意) addendum.json: 0 or N 件
- drift 検知出力 (legacy_drift_notes): N 件 → Group D/E 機能候補

### プロジェクト前提
- Phase 目標: <project-defined: 例 dogfood / public release / cleanup>
- 並列セッション上限: N (project-defined parallel capacity / 例: 10 / 30-50 / 100+)
- 想定総工数 / 納期: N 日

## 機能の大分類 + Group A-E マッピング

| Group | カテゴリ | 含まれる機能群 | 必須先行? | Sprint / Wave / Phase | 機能数 |
|---|---|---|:---:|---|---:|
| **A** | Foundation | CI/CD pipeline / lint / type check / coverage gate / 3-tier AC validator / access-control framework / audit infra / pre-flight mechanism / ADR | ✅ 最先行 | S0 / W0 / Foundation | N |
| **B** | Backend | data layer (entity / migration / access-control policy) / service / API / contract test / backend integration test | | S1 / W1 / Backend | N |
| **C** | UI | component / state management / UI integration test / accessibility | | S1-2 / W2-3 / UI | N |
| **D** | Integration test | E2E across slices / drift detection / cross-feature regression | | S2 / W3 / Integration | N |
| **E** | Drift fix / Polish | drift 修正 / refactor / performance / security audit / docs / cleanup / 命名 migration | | S3 / W4-N / Polish | N |

## 機能数の概算
- 総機能数: 〇件
- Group 別: A:N / B:N / C:N / D:N / E:N
- Sprint 別 / Phase 別: project-defined naming で集計

## 確認事項
- Group A (Foundation) を最先行させて OK か (推奨: yes)
- Group A-E のうち本プロジェクトで不要な Group はあるか / 追加 Group はあるか (profile で細分化が必要か)
- drift 検知出力を Group D / E に取り込みで OK か
- 並列度 (project-defined parallel capacity) の値で合っているか
```

**STEP 1 の深掘りチェック：**
- 認証・権限管理が要件に明示されていなくても必要ではないか
- 管理者向け機能（一覧・CSV出力・設定変更）が抜けていないか
- 通知・メール送信が必要な操作はないか
- 削除・キャンセル・取り消しの処理が必要な機能はないか
- **v3: Group A の中身 (CI/CD pipeline / lint / 3-tier AC validator / type/coverage gate / access-control framework / pre-flight audit / ADR) が漏れていないか**
- **v3: functional-breakdown の features.json と Group マッピングが 1:1 か (機能消失していないか)**

**出力後は必ず止まる：**

```
---
📋 **STEP 1 確認**

大分類 + Group A-E マッピングを確認してください。
- Group 構成 (A-E) に追加・削除はありますか？(プロジェクト固有 group があれば profile に細分化を定義)
- functional-breakdown 出力との対応に漏れはありますか？
- drift 検知出力の Group D / E 取り込みで OK ですか？
- 問題なければ「STEP 2へ」とお知らせください

※ 確認後にSTEP 2（機能分解）に進みます
---
```

---

### ▶ STEP 2：機能分解（最重要）

確認後、各カテゴリの機能を「実装できる単位」に分解する。

**Webリサーチ（STEP 2で実施）：**
機能分解・優先順位の意思決定に役立つ情報を調査する：
- 同業界・同カテゴリのプロダクトが最初にリリースした機能セット（MVP事例）
- 類似サービスのユーザーレビュー・不満点（「[サービス名] レビュー 機能不足」など）
- 技術的な実装依存関係の業界標準パターン

調査結果はデータ蓄積JSONの `research` フィールドに保存。

**各機能の記述フォーマット (v3):**

```
### [機能ID = F-V3-<GROUP>-<NN>] [機能名]

#### メタ
- **group**: A | B | C | D | E (or project-defined sub-group)
- **phase / sprint / wave**: <project-defined naming> (e.g., Foundation / Backend / UI / Integration / Polish)
- **カテゴリ**: auth / payment / crud / notification / search / admin / infra / cleanup
- **役割**: この機能が担う唯一の責任（1文で）

#### 入出力 / 処理
- **入力**: 受け取るデータ・パラメータ
- **出力**: 返すデータ・副作用（DBへの書き込み・メール送信など）
- **処理内容**: 何をするか（3〜5ステップで）

#### 依存 / 工数
- **依存関係 (depends_on)**: この機能が動くために必要な他機能のID (Group A の機能を必ず含む例: F-V3-INFRA-XX)。中断・再開を伴う機能は «pending 状態を持つ entity / 冪等性キー / 失効バッチ»、異常系を伴う機能は «共通エラー応答基盤» への依存を必ず明示する
- **独立性**: high（単独で動く）/ medium（1〜2依存）/ low（多数依存）
- **難易度**: easy（0.5日以下）/ medium（1〜3日）/ hard（3日以上）
- **estimated_days**: 0.5 / 1 / 2 / 3 (1 day = 6-8h)
- **想定リスク**: 実装・統合で起きうる問題

#### v3 必須: functional-breakdown 出力から pull
- **screen_ids**: [S-XXX, ...]
- **entity_ids**: [E-XXX <Name>, ...]
- **api_endpoints**: [{method, path, auth, inputs, outputs_2xx, outputs_4xx}]
- **access_control_policies**: [<table>:<policy_name>, ...] (RLS / RBAC / policy enforcement)
- **ears_ac_seed**: [EVENT-DRIVEN ... / UNWANTED ... / UBIQUITOUS ... 形式の AC ドラフト]

#### v3 必須: Vertical Slice 定義 (Backend → UI 順序維持)
- **vertical_slice_components**:
  - entities: [...] (Backend: data layer 先)
  - api_endpoints: [...] (Backend: service / API 層)
  - access_control_policies: [...] (Backend: policy)
  - tests: [...] (backend tests + UI tests)
  - middleware: [...] (auth / rate_limit など)
  - screens: [...] (UI: 最後)

#### v3: 横断A 中断・再開 (多ステップ / 状態遷移機能は必須)
- **resume_handling**: null (単一ステップで中断概念なし) | {
  - interruption_points: [中断・失敗・タイムアウトしうる点],
  - pending_state: [離脱時に残る pending entity / status],
  - resume_path: 再開導線 (再開 URL / 続きから / 最初から),
  - idempotency_key: 二重実行防止キー,
  - pending_ttl: 未完状態の失効・自動キャンセル条件
  }
- **resume_feature_ref**: null | F-V3-XXX (再開・中断を別機能として割り出した場合、その独立機能 ID)

#### v3: 横断B 異常系・エラー (4 レイヤー / 全機能必須)
- **error_handling**:
  - ui: [メッセージ / リトライ / 状態出し分け (loading/empty/error/partial)],
  - api: [4xx 一覧 (validation/auth/not_found/conflict/rate_limit) / 5xx],
  - data: [ロールバック / トランザクション境界 / 整合性担保],
  - recovery: [失敗→停止→復活 / 外部依存ダウン時フォールバック・縮退]

#### v3: drift 入力 (該当する場合)
- **drift_origin**: null | {source_screen_id, diff_severity, recommendation}

#### CI gate 適合チェック (この機能が下流 task で何 gate を pass する責任を持つか)
- gate `mock-lint`: ✅ / ⚪
- gate `access-control-coverage`: ✅ (access_control_policies が空でない) / ⚪
- gate `test-coverage`: ✅ (tests が空でない) / ⚪
- gate `mock-impl-diff`: ✅ (screen_ids あり) / ⚪
(具体的な gate set はプロジェクトで定義 / profile に列挙)
```

**STEP 2 の見落としチェック（分解中に自動確認）：**

| チェック | 見落とし例 |
|---------|-----------|
| 作成があれば更新・削除は？ | 投稿作成 → 投稿編集・削除を忘れがち |
| 一覧があれば検索・ページネーションは？ | 一覧表示 → 大量データ時の処理を忘れがち |
| 送信があれば受信・確認・再送は？ | メール送信 → 失敗時の再送・ログを忘れがち |
| 承認フローがあれば差し戻し・取り消しは？ | 承認 → 否認・保留・取り消しを忘れがち |
| 決済があれば返金・失敗ハンドリングは？ | 購入 → キャンセル・返金フローを忘れがち |
| 外部API連携はレートリミット・エラー処理は？ | API呼び出し → タイムアウト・エラー処理を忘れがち |
| **v3 横断A: 多ステップ機能に中断・再開を別機能で起票したか？** | 登録・決済・eKYC を happy path だけで起票 → 途中離脱が再開不能・二重決済・pending 放置 |
| **v3 横断B: 全機能に異常系・エラー (UI/API/データ/復旧) を割り出したか？** | happy path のみ → エラーで画面が固まる・outputs_4xx 空・ロールバック未定・依存ダウンで全停止 |
| **v3: Backend → UI の順序が Vertical Slice 内で保たれているか？** | UI 先行で API 未定 / data layer 未定だと並列開発が崩壊 |

**出力後は必ず止まる：**

```
---
📋 **STEP 2 確認**

機能分解を確認してください。
- 機能の追加・削除・粒度の調整はありますか？
- 独立性・難易度の評価に違和感はありますか？
- Vertical Slice の Backend → UI 順序が保たれていますか？
- **横断A: 多ステップ / 状態遷移機能の「中断・再開ハンドリング」が独立分解されていますか？**
- **横断B: 全機能に「異常系・エラー処理 (UI/API/データ/復旧)」が独立した実装対象として割り出されていますか？**
- 問題なければ「STEP 3へ」とお知らせください
---
```

---

### ▶ STEP 3：依存 DAG + Wave 構成 (v3: project-defined parallel capacity / Foundation 先行固定)

確認後、機能間の依存関係を整理し、疎結合な設計になっているか検証する。**v3 必須: Foundation phase (Group A) を Wave 0 で固定**。

**出力する内容：**

```
## 依存 DAG (v3)

### 依存ツリー (Phase 軸)
[Wave 0: Foundation phase / Group A]
  F-V3-INFRA-01 (ADR 起票) ─┐
  F-V3-INFRA-02 (lint) ─┤
  F-V3-INFRA-03 (AC validator) ┼─→ [Wave 1 解禁]
  F-V3-INFRA-04 (type/coverage gate) ──┘

[Wave 1: Backend phase / Group B]
  F-V3-DB-XX (data layer) ──┐
  F-V3-API-XX (service / API) ──┼─→ [Wave 2 解禁]
  F-V3-FIX-XX (gap 修正 backend) ─┘

[Wave 2: UI phase / Group C]
  F-V3-SCR-XX (Vertical Slice UI) ──┐
  F-V3-COMP-XX (component) ──┘

[Wave 3: Integration test phase / Group D]
  F-V3-DRIFT-XX (drift detection)
  F-V3-E2E-XX (cross-feature regression)

[Wave 4-N: Polish phase / Group E]
  F-V3-RF-XX (refactor)
  F-V3-CLEAN-XX (cleanup / rename)

### Wave 構成 (project-defined parallel capacity 前提)
| Wave | Phase (project-defined naming) | Group | 機能数 | 並列度 | 所要 (h) |
|---|---|---|---:|---:|---|
| 0 | Foundation | A | N | N (= A 件数) | 2-4 |
| 1 | Backend | B | N | <= cap | 4 |
| 2 | UI | C | N | <= cap | 4 |
| 3 | Integration test | D | N | <= cap | 2-3 |
| 4 | Polish (1st pass) | E | N | <= cap | 3-4 |
| ... | ... | ... | ... | ... | ... |

### Sprint ↔ Wave ↔ Phase 対応 (project-defined naming)
| Sprint | Phase | Wave | 内容 |
|---|---|---|---|
| 0 | Foundation | 0 | Foundation (Group A) |
| 1 | Backend / UI 必須 | 1-2 | dogfood 必須 (Group B / C) |
| 2 | Integration | 3 | E2E + drift detection (Group D) |
| 3 | Polish | 4-N | Refactor / Cleanup / Rename (Group E) |

### 依存が強い箇所（要注意 / ブロッキング機能）
| 機能 | 依存先 | 問題 | 推奨対策 |
|-----|--------|------|---------|
| F-V3-INFRA-02 (lint) | (なし) | Foundation 完成必須 / Wave 1+ 全機能の merge gate | 最優先 + 2 名アサイン |
| F-V3-AUTH-01 (login) | F-V3-INFRA-01 ADR | ADR 起票遅延で着手不可 | ADR 起票を Wave 0 で完了 |

### 疎結合化の提案
（依存を減らすための設計変更案）

### Risk flags + retry プロトコル
- 各機能が CI gate 落ちた場合: 同じ機能の retry session を別ブランチで起動
- 3 回連続失敗 → human エスカレーション (PM 確認)
```

**STEP 3 の深掘りチェック（依存関係で必ず確認すること）：**

| チェック項目 | 見落とし例 |
|------------|-----------|
| 循環依存はないか | A→B→C→A のような循環は開発を止める |
| 依存を後から変えるコストを評価したか | 「とりあえず共有DBを使う」→ 後で分離が困難になる |
| 機能間の通信はAPI/インターフェース経由か | 「直接DBを参照」する設計は密結合になり並列開発が崩壊する |
| 「依存している数が多い機能」を先に開発する順序になっているか | 基盤になる認証・共通APIが後回しになっていないか |
| 将来の拡張を想定した分割になっているか | 「今は1機能だが将来分割する可能性がある」部分を把握しているか |
| **Wave 内も Backend → UI の順序が保たれているか** | UI が API 未定で着手 → 後から API 変更で UI 再実装 |

**出力後は必ず止まる：**

```
---
📋 **STEP 3 確認**

依存関係と開発フェーズを確認してください。
- 依存関係の整理に誤りはありますか？
- 開発フェーズの順序に違和感はありますか？
- 問題なければ「STEP 4へ」とお知らせください
---
```

---

### ▶ STEP 4：開発単位化 + インターフェース + CI gate 連携 (v3)

確認後、各機能を「1 並列セッション = 1 PR で完結する開発単位」に整理し、接続部分のインターフェース + CI gate 適合を定義する。

**出力する内容：**

```
## 開発機能一覧 (Vertical Slice / 1 機能 = 1 PR)

| 機能ID | 機能名 | group | 担当想定 | 工数 | 依存 | vertical_slice 完備? |
|---|---|---|---|---:|---|:---:|
| F-V3-AUTH-01 | login | B | 1 並列 session | 1 day | F-V3-INFRA-01,03 | ✅ (entities+API+test+access-control+screens) |
| F-V3-DRIFT-01 | S-006 root rewrite | D | 1 並列 session | 0.5 day | F-V3-INFRA-02 | ✅ |

## インターフェース定義（主要 API / functional-breakdown api_endpoints からコピー）

### API: POST /api/auth/login
- **method/path**: POST /api/auth/login
- **auth**: public
- **リクエスト**: { email: string, password: string, mfa_code?: string }
- **レスポンス 2xx**: { access_token: string, refresh_token: string, user_id: uuid }
- **レスポンス 4xx**: [{ 401: "invalid_credentials" }, { 429: "rate_limited" }]
- **rate_limit**: 5/min/ip
- **提供する機能**: F-V3-AUTH-01
- **使用する entity**: E-001 User / E-038 AuthSession
- **access-control policy**: auth_sessions:user_own_select

## CI gate 適合確認 (各機能 × project-defined gate set)

| 機能 | mock-lint | AC validator | audit MD | access-control coverage | test coverage | type check (BE) | type check (FE) | mock-impl-diff |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| F-V3-AUTH-01 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| F-V3-INFRA-02 | ✅ | ✅ | ✅ | ⚪ | ✅ | ⚪ | ⚪ | ⚪ |
| F-V3-DB-01 (entity) | ✅ | ✅ | ✅ | ✅ | ✅ | ⚪ | ⚪ | ⚪ |

(⚪ = 該当しない / structural AC 空 or entity なし)
(具体的な gate 列はプロジェクト固有 — profile に列挙)
```

**v3 必須チェック**: test-coverage gate と type-check gate は **全機能で✅** が前提。⚪ は許可しない (= テストなし / 型なしの実装は merge 不可)。

**STEP 4 の深掘りチェック（チケット化・インターフェースで必ず確認すること）：**

| チェック項目 | 確認ポイント |
|------------|------------|
| 1チケット = 1〜5日か | 「5日以上かかる」チケットは分割が必要。「半日以下」は統合を検討 |
| インターフェースは「実装前に両者が合意できる粒度」か | リクエスト/レスポンスのフィールド名・型が曖昧なまま進まない |
| エラーケースのインターフェースも定義されているか | 「エラー時はどんなデータが返ってくるか」を決めないとフロントが実装できない |
| 並列開発できるチケットが明示されているか | 「これとこれは同時に作れる」を明確にしないと開発が直列になる |
| 認証・権限チェックはどのレイヤーで行うか | フロント/API/DBのどこで権限を確認するかを決めておかないと実装が散らばる |

**出力後は必ず止まる：**

```
---
📋 **STEP 4 確認**

開発チケットとインターフェースを確認してください。
- チケットの粒度・工数感に違和感はありますか？
- インターフェース定義の追加・修正はありますか？
- 問題なければ「STEP 5へ」とお知らせください（最終出力を生成します）
---
```

---

### ▶ STEP 5：最終出力（5 形式同時出力 / v3 拡張: DAG.md 追加）

「STEP 5へ」の指示を受けたら、以下の **5 形式** を一度に出力する。
※ v3 で従来の 4 形式に加え **DAG.md** が追加された。

---

#### 【出力①】クライアント・PM向け説明

```
# [プロジェクト名] 機能分解結果

## 分解の方針
（なぜこの分解にしたか・並列開発をどう実現するか）

## 機能構造の概要
（カテゴリ別の機能一覧と関係性を平易な文章で）

## 開発フェーズと順序
（Foundation → Backend → UI → Integration → Polish の各フェーズの内容と理由）

## 並列開発できる組み合わせ
（同時に進められる機能のセット）
```

---

#### 【出力②】開発用機能一覧JSON（開発チーム向け）

```json
[
  {
    "id": "F001",
    "name": "機能名",
    "category": "auth/data/ui/payment/notification/admin/etc",
    "role": "この機能が担う唯一の責任",
    "input": ["入力項目（型）"],
    "output": ["出力・副作用"],
    "logic": "処理内容の要約",
    "dependencies": ["F002", "F003"],
    "independence": "high/medium/low",
    "difficulty": "easy/medium/hard",
    "estimated_days": 2,
    "risk": "想定リスク"
  }
]
```

---

#### 【出力③】依存関係マップ（最終版）

```
## 依存ツリー（最終版）
（STEP 3の整理を反映した最終形）

## 並列開発可能グループ (v3: Group A-E 命名統一)
Group A (Wave 0): F-V3-INFRA-01, ..., F-V3-INFRA-NN (互いに独立 / Foundation)
Group B (Wave 1): F-V3-DB-XX, F-V3-API-XX, ... (Wave 0 完了後 / Backend)
Group C (Wave 2): F-V3-SCR-XX, ... (Wave 1 完了後 / UI)
Group D (Wave 3): F-V3-DRIFT-XX, F-V3-E2E-XX (Integration test)
Group E (Wave 4-N): F-V3-RF-XX, F-V3-CLEAN-XX (Polish / Drift fix)

## 推奨開発順序
Wave 0 (Foundation) → Wave 1 (Backend) → Wave 2 (UI) → Wave 3 (Integration) → Wave 4-N (Polish)
```

---

#### 【出力④】DAG.md (v3 新規 / Wave 構成詳細)

```markdown
# DAG / Wave Plan — <project>

## 物量
| 指標 | 値 |
|---|---|
| 総機能数 | N |
| Sprint 数 | N |
| Wave 数 | N |
| 並列度上限 | <project-defined parallel capacity> |
| 推定総工数 | N 日 |

## Sprint ↔ Wave ↔ Phase 対応
(STEP 3 の表を最終確定版として出力)

## 依存 DAG (ASCII)
(STEP 3 の DAG を最終確定版として出力)

## Wave 別並列実行プラン
### Wave 0 (Foundation phase / Group A / N 機能 / 2-4h)
- F-V3-INFRA-01, ..., F-V3-INFRA-NN

### Wave 1 (Backend phase / Group B / N 機能 / 4h)
- F-V3-DB-01, ..., F-V3-DB-NN
- F-V3-API-01, ...
- F-V3-FIX-01, ...

### Wave 2 (UI phase / Group C / N 機能 / 4h)
- F-V3-SCR-01, ...

...

## Risk flags (Bottleneck 候補)
| 機能 | risk | 影響範囲 | mitigation |
|---|---|---|---|
| F-V3-INFRA-03 (lint) | ブロッキング | Wave 1+ 全機能の merge gate | Foundation で最優先完成 / 2 人アサイン |

## CI gate (project-defined gate set)
references/v3-core.md の "CI gate 連携" 参照。
全 PR で全 gate を merge gate に。プロジェクト固有 gate 集合は profile を参照。

## 失敗 retry プロトコル
1. CI が PR コメントに失敗内容貼る
2. orchestrator が同じ機能の retry session を別ブランチで起動
3. 3 回連続失敗 → human エスカレーション
```

---

#### 【出力⑤】データ蓄積用JSON（判断ログ・MCP連携向け）

将来のプロジェクト再利用・分解パターン分析・MCP連携での検索最適化を前提とした構造。

```json
{
  "meta": {
    "project": "プロジェクト名",
    "created_at": "YYYY-MM-DD",
    "skill_version": "v3",
    "total_features": 12,
    "parallel_groups": 3
  },
  "context": {
    "project_type": "Webアプリ/モバイル/SaaS/社内ツール/API",
    "scale": "小規模(<10機能)/中規模(10-30機能)/大規模(30機能以上)",
    "priority": "speed/quality/cost"
  },
  "decision_log": [
    {
      "decision": "どんな分解判断をしたか",
      "reason": "なぜその判断をしたか",
      "alternatives": ["他の分解案A", "案B"],
      "tradeoffs": "採用案のトレードオフ"
    }
  ],
  "decomposition_patterns": [
    {
      "pattern_name": "パターン名（例：認証基盤分離）",
      "applicable_to": "どんなプロジェクトに使えるか",
      "description": "パターンの説明と効果"
    }
  ],
  "research": {
    "sources": [{"url": "", "title": "", "accessed_at": "YYYY-MM-DD"}],
    "findings": ["調査結果の要点1", "調査結果の要点2"],
    "research_date": "YYYY-MM-DD"
  }
}
```

---

## このスキルの典型的な使い方

```
PM: 「要件定義ができた。機能分解してエンジニアにタスクを振りたい」
 → STEP 1 を出力（止まる）

PM: 「この分類でOK、STEP 2へ」
 → STEP 2 を出力（止まる）

... 繰り返し ...

PM: 「STEP 5へ」
 → 5 形式の最終ドキュメントを出力
```

---

## 📦 構造化JSON出力仕様（最終ステップのみ）

```devos-json
{
  "features": [
    {
      "id": "F-001",
      "title": "機能タイトル",
      "description": "機能説明",
      "priority": "must",
      "user_story": "〇〇として、〜したい",
      "use_cases": ["ユースケース1"],
      "dependencies": [],
      "estimated_complexity": "M",
      "phase": "Foundation | Backend | UI | Integration | Polish (project-defined naming)",
      "resume_handling": null,
      "resume_feature_ref": null,
      "error_handling": {
        "ui": ["メッセージ / リトライ / 状態出し分け"],
        "api": ["4xx 一覧 / 5xx"],
        "data": ["ロールバック / 整合性"],
        "recovery": ["失敗→停止→復活 / フォールバック"]
      }
    }
  ],
  "dependency_graph": [
    {"from": "F-001", "to": "F-002", "type": "requires"}
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

## ハンドオフ (標準フロー連携)

このスキルは以下の標準ワークフロー内に位置する。完了時に「次は **task-decomposition** へ進みますか?」とユーザーに確認する。

```
[1] requirements-definition (要件定義)
  ↓
[2] architecture-design (アーキ設計)
  ↓
[3] design-md (デザインシステム / DESIGN.md)
  ↓
[4] functional-breakdown (機能・画面・エンティティ徹底分解)
  ↓
[5] feature-decomposition (Phase × Wave 機能分解)
  ↓
[6] task-decomposition (タスクカード化)
  ↓
[7] human-grade-qa【test-plan モード / 実装前】★ 画面別+フロー+RLS の3軸でテスト仕様書を完璧に作る
  ↓
[★] 実装期間 (テスト仕様書を満たすように作る = TDD 風)
  ↓
[8] human-grade-qa【full / diff / feature / regression モード / 実装後】★ 実機で潰す
  ↓
完了
```

### このスキルの位置
- **前段スキル**: `functional-breakdown`
- **次段スキル**: `task-decomposition`
- **フロー位置**: 5/8

### 完了時のハンドオフ宣言

STEP 5 (最終出力) 完了時、以下を必ず提示する:

```
✅ feature-decomposition 完了

📌 次に進めるべきスキル: `task-decomposition`

→ 「次に進む」「task-decomposition へ」「STEP 1 から」等のキーワードで起動可能。
   別の作業を挟む場合は明示的に指示してください。
```

ユーザーが「次へ」と返答したら、自動で次段スキルを起動する。


---

## 🔌 結線(Integration/Wiring)を必ず独立機能として分解する（汎用・再発防止）

> 追加理由: 「データ層/API/UI のコンポーネント機能」だけを並べると、それらを**実際に協調させてユーザー価値が通る経路**（実行ループ・接続→利用可能機能への写像・画面↔API↔データの通し・認証→利用解禁 等）が分解から漏れ、結果 stub/未配線のまま「完了」に見える事故が起きる。これは特定プロダクトに限らない構造的な穴。

### 原則（全プロジェクト共通）
1. **コンポーネント機能 ≠ 動く機能。** 部品を作る機能とは別に、それらを end-to-end 価値経路へ**結線する機能(integration/wiring/runtime orchestration)を必ず独立して起票**する。
2. **すべてのコンポーネント機能は、少なくとも1つの結線機能から参照される**こと。どこからも結線されない部品＝**「孤立コンポーネント」**＝分解不合格。
3. 結線機能の汎用例（プロダクト非依存）:
   - 実行/イベントループ（要求→処理器選択→実行→結果→継続）
   - ハンドラ/プラグインの**レジストリ登録**と呼び出し配線
   - 外部接続（認証済み）→**利用可能な操作の一覧化・選択・実行**への写像
   - 画面 → API → データ層の**通し配線**（モックfetchでなく実経路）
   - 認証/プロビジョニング完了 → **以後の機能解禁**
4. **stub / echo / 「後のPhaseで配線」/ アダプタ境界がthrowするだけ** で価値経路が途切れる箇所は、その**結線自体を独立機能として明示**する（隠さない）。

### Group マッピングへの反映
- Group D(Integration) は「結合**テスト**」だけでなく**ランタイム結線機能**を含む。コンポーネント(B/C)を出したら、対応する**結線機能(D)が存在するか**を STEP 1/STEP 3 で必ず確認する。

### 自己点検（STEP 2/3 で必ず）
- [ ] 各コンポーネント機能に「これを価値経路へ結線する機能」があるか（無ければ孤立）
- [ ] 「実行ループ/registry登録/接続→可用性写像/通し配線/認証→解禁」が機能として挙がっているか
- [ ] stub・境界throw・Phase-defer で経路が途切れる箇所を、結線機能として可視化したか
