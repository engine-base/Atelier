---
name: test-verification
description: テスト戦略設計・品質検証スキル。テスト種類 (unit/integration/E2E/contract/access matrix)・カバレッジ・CI 連携・受入基準設計。v3: 3-tier AC を test に 1:1 マップ (structural → mock-impl-diff / functional → unit+contract+access / regression → CI gate)。EARS AC から test case 自動生成 (EVENT-DRIVEN/UNWANTED/STATE-DRIVEN)。N CI gate を Foundation→Backend→UI→Polish 段階。Schemathesis + Pact 採用。「テストを書きたい」「テスト戦略を決めたい」「品質基準を設けたい」「CI を整備したい」「リグレッションを防ぎたい」「3-tier AC を test に」「EARS AC から test 生成」「access-control を role × operation で」「N CI gate 段階構成」「mock-impl drift 防止」「contract test」「gate-config.yml」「ears-test-mapping.json」で起動。4STEP 対話。出力 4 形式: 計画書 + 設計 JSON + gate-config.yml + ears-test-mapping.json。 v3.2 (2026-09-02): テスト・ラダー L1〜L5 (.claude/rules/common/test-ladder.md) 対応 — テストはタスク分解時に作り、staging で流す。
tab: 品質・運用
builtin: true
---

## 🪜 テスト・ラダー（L1〜L5）— このスキルの責務（2026-09-02 追加・必須・省略不可）

> 規約の正本: `.claude/rules/common/test-ladder.md`（ここと矛盾したら規約が勝つ）。
> 由来: 2026-09-02、本番実走で 5 件（保存先バケット未作成 / AI の無言終了 / Bridge 終了後 90 秒の誤表示 /
> モード切替の無視 / 退会後もセッション有効）が出た。5 件とも正本に観点が無く、**実装が全部終わってから
> 「全体」を対象にテストを書いたため細部が抜けた**のが共通原因。テストは **タスク分解の時点で・タスク単位で**
> 作り（L1）、流れ（L2）は揃った瞬間に、Wave / リリース / 全体（L3〜L5）は締めで流す。

### 3-tier AC ↔ テスト・ラダー（L1〜L5）対応（v3.2 必須）

| 段 | 何を | どこで流す | いつ | ゲート |
|---|---|---|---|---|
| L1 タスク | tickets `qa_rows.l1`（正本の行）: 全要素・全分岐・全エラー・境界・権限・状態・中断再開 + G-11〜G-15 | **staging**（ブラウザ・API・DB 突合・AI 実動）。ローカルは単体・契約まで | 実装した本人が merge 前 | `qa-ladder.py gate --task` |
| L2 流れ | journeys（`runnable_after`） | staging | 揃えた最後のタスクが merge 前 | 同上 |
| L3 Wave | Wave 内の L1+L2 全部 + 前 Wave 回帰（diff） | staging | Wave 締め | `completion_gate.sh` |
| L4 リリース | 正本 full + 本番スモーク | staging + 本番（スモークのみ） | リリース前 | `qa-coverage.py` STATUS: 完了 |
| L5 全体 | full + 正本の鮮度監査 | staging | 年次 / 大改修 | 同上 |

- structural / functional / regression の 3-tier は **L1 の中の分類**であって、段の代わりにならない。3-tier が緑でも L1 の行が PASS していなければ未完了。
- **CI の Foundation gate に `qa-ladder.py validate` を足す**（正本 ↔ tickets の参照不整合で fail）。PR gate に `qa-ladder.py gate --task <branch の task>` を足す。
- E2E（Playwright 等）の設計は **staging を前提**にする。「ローカルのスタブで E2E 緑」は L1 の PASS に数えない。
- STEP 2 で「実装後に全体を見てテストを書く」計画を立てない。テストは task-decomposition が各タスクに **既に**付けている。このスキルは **その行をどの test レベル・どのツール・どの gate で機械化するか**を決める。


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

# テスト・品質検証設計スキル

実装が完了してもテストがなければ「動く」かどうかわからない。テストがあっても設計が悪ければ、本番で壊れる変更がすり抜ける。

このスキルは「何をどのレベルでテストするか」を設計する。コードを書く前に設計できれば理想的だが、実装後でも遅くない。

**このスキルの位置づけ：**
- 並列実装された各ブランチの品質を統一基準で検証する
- 統合の前に「マージしてよい品質かどうか」を判断する基準を作る
- Done Criteria を test で自動化することで「完成しました」の言葉を不要にする

---

## ⛔ 絶対ルール

**STEP 1の確認ブロックを出力したら、必ずそこで止まること。**

ユーザーが「STEP 2へ」と指示するまで、絶対に次のSTEPに進んではならない。

---

## 最上位ルール

止まることがこのスキルの最も重要な動作である。確認ブロックを出力したら即停止。「STEP 2へ」の返答を待つ。

## v3 必須ルール (2026-05-15〜)

詳細: `references/v3-core.md`
プロジェクト固有値の適用例: `references/profiles/build-factory.md`

> **注意**: 以下の v3 ルールは「プロジェクト依存値」を含む。固定の数値・script path は規定しない。固有値は profile 経由で注入する (profile は **例** であり必須ではない)。

1. **上流出力を必ず pull** — task-decomposition の tickets.json (3-tier AC) と api-design の ears-ac-seed.json (EARS AC) を STEP 1 で path 確認
2. **3-tier AC を test レベルに 1:1 マッピング** — structural → mock/spec drift lint / functional → unit + contract + access-control / regression → CI gate 自動化
3. **EARS AC から test case 自動生成** — EVENT-DRIVEN → 正常系 / UNWANTED → 異常系 / STATE-DRIVEN → parametrize。`<ears_test_generator>` script 経由
4. **Access control matrix test (role × operation)** — 必須網羅。role 数・operation 数・期待値 (OK/NG) は project-defined。`<access_control_verifier>` で CI 検証
5. **N CI gate を Foundation → Backend → UI → Polish の段階で構成** — gate 数 N は project-defined (e.g., 5-10)。各段階の代表 gate:
   - Foundation gate: lint / format / AC validator / type check
   - Backend gate: access-control coverage / API contract test / coverage threshold (project-defined, e.g., 70-90%)
   - UI gate: tsc / mock-impl drift / visual regression
   - Polish gate: audit MD existence / perf / security scan
6. **auto-merge** — 全 gate pass で auto-merge、連続 N 失敗で human エスカ
7. **Contract test 必須** — Schemathesis (OpenAPI → fuzz) + Pact (frontend ↔ backend consumer/provider)。openapi.yaml を api-design から pull

---

## テンプレートファイル（assets/）
- `assets/jest-config-template.ts` — jest.config.tsテンプレート（カバレッジ閾値・パスエイリアス設定済み）
- `assets/ci-template.yml` — CI テンプレート（Lint・型チェック・テスト・ビルドの基本ジョブ構成）

STEP 3（カバレッジ基準・CI設計）の最終出力時は、jest-config-template.tsのcoverageThresholdsとci-template.ymlをプロジェクトに合わせて調整した形で出力すること。

---

## STEP 1: テスト対象とリスク評価 (v3: 3-tier AC マッピング + 上流出力 pull)

**このSTEPでやること：**
何をテストするか・何をテストしないかを決める。全部テストするのは現実的ではないので、リスクと価値のバランスで優先順位をつける。

**v3 必須**: 上流出力の path を確認し、3-tier AC を test レベルに 1:1 マッピング:

```
## 入力情報の確認 (v3)

### 上流出力
- task-decomposition 出力: docs/task-decomposition/<date>_v<N>/
  - tickets.json: N 件 (3-tier AC 込み)
- api-design 出力: docs/api-design/<date>_v<N>/
  - openapi.yaml (Schemathesis input)
  - ears-ac-seed.json (EARS AC ドラフト)
  - lint-mapping.json (mock ↔ API 対応の lint 検証対象)
- functional-breakdown 出力: docs/functional-breakdown/<date>_v<N>/
  - entities.json (access control policy)
  - roles.json (project-defined roles, e.g., 3-10 roles)
- architecture-design 出力: docs/architecture/<date>_v<N>/
  - foundation_gates.json (CI gate 定義 / N gates project-defined)

### 3-tier AC ↔ test レベル マッピング (v3 必須)
| 3-tier AC | test レベル | tool | gate 段階 |
|---|---|---|---|
| structural (mock/spec 一致) | mock-impl drift lint | <mock_impl_diff> | UI gate |
| functional.api (EARS) | unit + contract | pytest/vitest + Schemathesis | Backend gate |
| functional.access_control (role × operation matrix) | access-control test | <access_control_verifier> | Backend gate |
| functional.acceptance | E2E | Playwright/Cypress | UI gate |
| regression.coverage | coverage check | coverage tool (project-defined threshold) | Backend gate |
| regression.lint | mock-lint + AC validator | <lint_runner> + <ac_validator> | Foundation gate |
| regression.type | type check | pyright/tsc/mypy | Foundation gate |
| regression.audit | audit MD existence | <audit_md_check> | Polish gate |
```

**確認すること（曖昧なら【仮説】を立てて質問）：**

1. **実装内容** — どの機能・APIを対象とするか？複数ある場合はリスト
2. **技術スタック** — テストフレームワークは決まっているか？(Jest / Vitest / pytest など)
3. **既存のテスト状況** — テストは既にあるか？あるならどのレベルまでカバーされているか？
4. **リスクの高い箇所** — 「ここが壊れると一番困る」機能はどこか？(認証・決済・データ処理など)
5. **テストに使える時間・リソース** — 全部丁寧にやる余裕があるか、最小限でよいか？
6. **CIの有無** — CI 環境はあるか？ (GitHub Actions / GitLab CI / CircleCI など)
7. **v3: tickets.json の 3-tier AC schema 適合** — 全 task が structural / functional / regression に分かれているか
8. **v3: ears-ac-seed.json の EARS 形式** — EVENT-DRIVEN + UNWANTED 1 件以上を全 endpoint で確認
9. **v3: N CI gate 採用方針** — gate 数 / 各段階の構成 (Foundation/Backend/UI/Polish) / 一部 skip 判断 (例: 序盤で access-control gate をまだ ON にしない等)
10. **v3: contract test (Schemathesis + Pact) 採用方針** — frontend/backend の契約検証を CI に含めるか
11. **v3: access control role × operation matrix** — role 数・operation 数・期待値 (OK/NG) の確定 (project-defined; profile 参照可)

**出力形式：**

```
## テスト対象・リスク評価

### テスト対象機能
[機能名と概要のリスト]

### リスク評価
| 機能 | リスク | 理由 | テスト優先度 |
|-----|-------|------|------------|
| 認証 | 高 | セキュリティ直結 | 最優先 |
| 一覧取得 | 中 | データ整合性 | 優先 |
| UI表示 | 低 | 視覚的確認で十分 | 後回し |

### テストしないもの（理由とともに）
- [機能名]：理由（例：手動確認で十分 / スコープ外 / 変更頻度が高い）

### テストフレームワーク確認
- 既定 or 【仮説】：
- 既存テスト：（あり / なし / 部分的）
```

---

📦 **STEP 1 確認**

テスト対象・リスク評価を確認してください。

- リスク評価の優先度は実際の感覚と合っていますか？
- テストしないものの判断は適切ですか？
- 問題なければ「STEP 2へ」とお知らせください

**※ STEP 2には進まない。ユーザーの確認を待つ。**

---

## STEP 2: テスト種類と粒度の設計 (v3: EARS 自動生成 + access-control matrix)

**このSTEPでやること：**
unit / integration / E2E / contract / access-control のどのレベルでテストするかを機能ごとに決める。

**v3 必須**:
- **EARS AC → test case 自動生成** (`<ears_test_generator>` script)
  - EVENT-DRIVEN → `test_<endpoint>_<event>()` (正常系)
  - UNWANTED → `test_<endpoint>_<condition>_rejected()` (異常系)
  - STATE-DRIVEN → `parametrize("state", [...])` で分岐
- **Access control test は role × operation matrix で網羅必須**
  - role 数: project-defined (e.g., 3-10 roles)
  - operation 数: project-defined (e.g., 5-8 operations: SELECT own / SELECT others / INSERT / UPDATE own / UPDATE others / DELETE own / DELETE others 等)
  - entity 1 件あたりの test case 数 = role 数 × operation 数
  - `<access_control_verifier>` で網羅検証
- **Contract test**: Schemathesis (OpenAPI → fuzz) + Pact (frontend ↔ backend consumer/provider)

**Webリサーチ（STEP 2で実施）：**
採用テストフレームワークのベストプラクティスを調査する：
- 使用フレームワーク（Jest/Vitest/pytest等）の最新の推奨設定・プラグイン
- 同業界・同技術スタックでのテストカバレッジ基準事例
- E2Eテストツール（Playwright/Cypress）の選定比較（E2Eが必要な場合）

調査結果はデータ蓄積JSONの `research` フィールドに保存。

**テストピラミッドの考え方：**
- **ユニットテスト**（多く・速く・安い）: 関数・メソッド単位の動作検証
- **統合テスト**（中程度）: APIエンドポイント・DB操作の組み合わせ検証
- **E2Eテスト**（少なく・遅く・高い）: ユーザーの実際の操作フロー検証

受託開発の現実解：E2Eは最小限にして、APIレベルの統合テストをメインにする。

**出力形式 (v3)：**

```
## テスト設計 (v3)

### テストレベル配分
| 機能 | unit | contract | access-control | E2E | EARS 自動生成 | 理由 |
|-----|------|----------|----------------|-----|--------------|------|

### EARS 自動生成 test (v3)
- 入力: docs/api-design/<date>_v3/ears-ac-seed.json
- 出力: <test_dir>/generated/
- script: <ears_test_generator>
- 命名規則:
  - EVENT-DRIVEN → test_<endpoint>_<event>()
  - UNWANTED → test_<endpoint>_<condition>_rejected()
  - STATE-DRIVEN → parametrize 経由

### Access control test (v3 / role × operation matrix)
※ role / operation / 期待値は project-defined。下表は構造例 (実値は profile 参照)。

| role        | op_1 (SELECT own) | op_2 (SELECT others) | op_3 (INSERT) | op_4 (UPDATE own) | ... |
|-------------|-------------------|----------------------|---------------|-------------------|-----|
| <role_a>    | OK                | OK                   | OK            | OK                | ... |
| <role_b>    | OK                | OK                   | OK            | OK                | ... |
| <role_c>    | OK                | NG                   | OK            | OK                | ... |
| <role_d>    | OK (assigned)     | NG                   | NG            | NG                | ... |

- entity 1 件あたり = (role 数) × (operation 数) test case
- 検証: <access_control_verifier>
- Backend gate で CI 自動検証

### Contract test (v3)
- Schemathesis: OpenAPI → fuzz (property-based test)
- Pact: frontend (consumer) ↔ backend (provider) 契約検証
- 入力: docs/api-design/<date>_v3/openapi.yaml

### E2Eテスト設計（最小限 / Playwright or Cypress）
- クリティカルなユーザーフローのみ

### モック戦略
- DBはモックするか・しないか（理由）
- 外部APIはスタブするか（理由）
```

---

📦 **STEP 2 確認**

テスト設計を確認してください。

- テストレベルの配分は現実的ですか？
- モック戦略は実際のプロジェクトに合っていますか？
- 問題なければ「STEP 3へ」とお知らせください

**※ STEP 3には進まない。ユーザーの確認を待つ。**

---

## STEP 3: カバレッジ基準・CI設計・受け入れ基準 (v3: N CI gate auto-merge / 段階構成)

**このSTEPでやること：**
テストが「通った」とはどういう状態かを定義する。**v3: N CI gate (project-defined, e.g., 5-10) を Foundation → Backend → UI → Polish の段階で構成し、auto-merge を必須化**。

**カバレッジ基準の現実解：**
- ビジネスロジック・認証・データ操作: 80%以上
- ユーティリティ・型変換: 60%以上
- **v3 統一基準: 全体 coverage ≥ project-defined threshold (e.g., 70-90%)** — Backend gate で検証

**出力形式 (v3)：**

```
## カバレッジ基準・受け入れ基準 (v3)

### N CI gate (v3 必須 / Foundation → Backend → UI → Polish 段階構成)
※ N と各 gate の具体名/script path は project-defined。下表は段階構成の例。

| 段階 | Gate 名 | tool | 失敗条件 |
|---|---|---|---|
| Foundation | lint / format | <lint_runner> | lint rule violation |
| Foundation | AC validator | <ac_validator> | 3-tier AC schema 違反 or EARS 形式違反 |
| Foundation | type check | pyright / tsc / mypy | type error |
| Backend | access-control coverage | <access_control_verifier> | role × operation matrix 未網羅 |
| Backend | API contract | Schemathesis (+ Pact verify) | contract violation |
| Backend | coverage threshold | coverage tool | カバレッジ < project-defined threshold or test failure |
| UI | tsc strict | tsc --noEmit | type error |
| UI | mock-impl drift | <mock_impl_diff> | mock の項目が backend response に存在しない |
| UI | visual regression (任意) | Playwright/Chromatic | snapshot diff |
| Polish | audit MD existence | <audit_md_check> | 該当 task の audit MD が存在しない |
| Polish | perf budget (任意) | Lighthouse / k6 | budget violation |
| Polish | security scan (任意) | npm audit / pip-audit / Snyk | high/critical vuln |

### 段階間の block 関係 (v3)
- Foundation gate 不合格 → Backend / UI / Polish 全 skip
- Backend gate 不合格 → UI / Polish 全 skip
- UI gate 不合格 → Polish 全 skip
- 全段階 pass → auto-merge

### auto-merge (v3 必須)
- needs: [全 gate] 全 pass
- 動作: `gh pr merge --auto --squash`
- 連続 N 失敗 (project-defined, e.g., 3) で human エスカ (Slack / メール)
- 例外: 一部 gate を初期段階で OFF にする場合は foundation_gates.json の override で明示

### カバレッジ基準
| 対象 | 最低カバレッジ | 重点テスト対象 |
|-----|-------------|------------|
| ビジネスロジック / 認証 / データ操作 | 80% | access-control / 認証 / 決済 |
| ユーティリティ / 型変換 | 60% | - |
| v3 統一: 全体 | project-defined (e.g., 70-90%) | Backend gate |

### マージ可能の判断基準 (v3 / Done → auto-merge)
- [ ] N CI gate 全て green
- [ ] EARS AC → test case 自動生成済 (ears-test-mapping.json で対応取れている)
- [ ] Access control role × operation matrix 網羅 (<access_control_verifier> pass)
- [ ] Schemathesis contract test pass (任意)
- [ ] Pact contract verify pass (任意)
- [ ] 連続 N 失敗していない (もしくは human escalate 完了)

### リグレッション防止 (v3)
- 全 EARS AC が ears-test-mapping.json に登録 → 仕様変更時に test の追従漏れを CI で検出
- mock-impl drift lint (UI gate) で mock ↔ 実装 drift を毎 PR 検出
- 並列開発期間中の drift fix 専用 group を継続稼働
```

---

📦 **STEP 3 確認**

受け入れ基準を確認してください。

- カバレッジ基準は現実的ですか（高すぎず低すぎず）？
- 「マージ可能」の判断基準に漏れはありますか？
- 問題なければ「STEP 4へ」とお知らせください

**※ STEP 4には進まない。ユーザーの確認を待つ。**

---

## STEP 4: 最終出力 (v3: 4 形式同時出力)

### 出力① テスト計画書 (Markdown)

```markdown
# テスト計画書

## 対象機能とリスク評価
## 3-tier AC ↔ test レベル マッピング (v3)
## テスト設計 (unit / contract / access-control / E2E)
## EARS AC 自動生成方針 (v3)
## Access control role × operation matrix (v3)
## N CI gate 段階構成 (Foundation/Backend/UI/Polish, v3)
## カバレッジ基準
## マージ可能判断基準 (auto-merge)
```

### 出力② テスト設計 JSON

```json
{
  "version": "v3",
  "project_id": "",
  "test_strategy": {
    "framework": "<framework_set>",
    "coverage_thresholds": {
      "business_logic": 80,
      "utilities": 60,
      "overall": "<project-defined, e.g., 70-90>"
    },
    "ci_gates": {
      "foundation": ["lint", "format", "ac-validator", "type-check"],
      "backend": ["access-control-coverage", "contract-test", "coverage-threshold"],
      "ui": ["tsc-strict", "mock-impl-diff"],
      "polish": ["audit-md-existence"]
    },
    "merge_criteria": ["all gates green", "ears-test-mapping consistent", "access-control matrix complete"]
  },
  "test_cases": [],
  "next_skill": "distributed-dev"
}
```

### 出力③ gate-config.yml (v3 新規 / CI runner 設定)

> 下記は段階構成の例。gate 数 / script path / runner 詳細は project-defined。

```yaml
name: N CI Gate (Foundation -> Backend -> UI -> Polish)
on: [pull_request]

jobs:
  # ----- Foundation gate -----
  foundation-lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash <lint_runner>

  foundation-ac-validator:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python3 <ac_validator>

  foundation-type-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pyright   # or tsc / mypy

  # ----- Backend gate (depends on Foundation) -----
  backend-access-control-coverage:
    needs: [foundation-lint, foundation-ac-validator, foundation-type-check]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python3 <access_control_verifier>

  backend-contract-test:
    needs: [foundation-lint, foundation-ac-validator, foundation-type-check]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: schemathesis run docs/api-design/openapi.yaml --base-url http://localhost:8000

  backend-coverage:
    needs: [foundation-lint, foundation-ac-validator, foundation-type-check]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pytest --cov --cov-fail-under=<project-defined-threshold>

  # ----- UI gate (depends on Backend) -----
  ui-tsc:
    needs: [backend-access-control-coverage, backend-contract-test, backend-coverage]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: tsc --noEmit

  ui-mock-impl-diff:
    needs: [backend-access-control-coverage, backend-contract-test, backend-coverage]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: python3 <mock_impl_diff>

  # ----- Polish gate (depends on UI) -----
  polish-audit-md:
    needs: [ui-tsc, ui-mock-impl-diff]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash <audit_md_check>

  # ----- auto-merge -----
  auto-merge:
    needs: [polish-audit-md]
    runs-on: ubuntu-latest
    steps:
      - name: Auto-merge PR
        run: gh pr merge --auto --squash
```

### 出力④ ears-test-mapping.json (v3 新規)

```json
{
  "version": "v3",
  "skill": "test-verification",
  "mappings": [
    {
      "ears_ac_id": "F-001-AC-01",
      "ears_form": "EVENT-DRIVEN",
      "ears_text": "When POST /api/auth/login is called with valid email+password, the system shall return 200 with { access_token, refresh_token, user_id }.",
      "test_id": "TC-001",
      "test_file": "<test_dir>/generated/test_auth_login.py",
      "test_function": "test_auth_login_valid_credentials",
      "test_level": "unit+contract",
      "gate": "backend-coverage"
    },
    {
      "ears_ac_id": "F-001-AC-02",
      "ears_form": "UNWANTED",
      "ears_text": "If credentials are invalid, the system shall return 401 with generic message (no user enumeration).",
      "test_id": "TC-002",
      "test_file": "<test_dir>/generated/test_auth_login.py",
      "test_function": "test_auth_login_invalid_credentials_rejected",
      "test_level": "unit+contract",
      "gate": "backend-coverage"
    }
  ]
}
```

---

## 📦 構造化JSON出力仕様（最終ステップのみ）

```devos-json
{
  "strategy": {"approach": "TDD + E2E", "coverage_target": 80, "tools": ["Jest", "Playwright"]},
  "test_cases": [
    {
      "id": "TC-001",
      "title": "テストケース名",
      "category": "unit",
      "priority": "high",
      "status": "pending",
      "steps": ["ステップ1", "ステップ2"],
      "expected_result": "期待される結果"
    }
  ],
  "ci_config": "CI設定の概要",
  "coverage_report": {"unit": 0, "integration": 0, "e2e": 0}
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
