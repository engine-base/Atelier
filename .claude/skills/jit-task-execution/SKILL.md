---
name: jit-task-execution
description: |
  JIT (Just-In-Time) 方式のプロジェクト (tickets.json + dispatcher.sh + v3-gate.yml 10 gate を持つもの) で、
  1 タスク = 1 ブランチ = 1 PR を仕様徹底で実装する。
  ユーザーが「JIT で進める」「タスクを実装する」「T-F-XX を実装」「dispatcher で起動」「ticket を実装」
  「漏れなく実装」「仕様徹底で進める」「selected-stack 厳守」「per-task /goal を固定」
  「placeholder で逃げない」「動けばいいモード禁止」と言った時、明示されなくても必ず使う。
  tickets.json / dispatcher.sh / v3-gate.yml のいずれかが存在するプロジェクトでタスク実装に
  入った場面でも、明示されなくても必ず使う。
  selected-stack の確定済技術を曲げず、AC 定量条件 (80%/0-error/100%) を絶対に下げず、
  files_changed_predicted の new/modify を 1 文字も逸脱しない実装統制を提供する。
  さらに Rule 10 (動作実証ゲート) により「描画された/テストが緑」で完了にせず、
  実ブラウザで全操作要素を押し・API結線・仕様states対応・防御層・共通シェル影響・
  書込の再取得反映まで確認してから PR を出させる。
  v3.2 (2026-09-02): テスト・ラダー L1〜L5 (.claude/rules/common/test-ladder.md) 対応 — テストはタスク分解時に作り、staging で流す。
tab: 品質・運用
builtin: true
prev_skill: human-grade-qa (test-plan モード)
next_skill: human-grade-qa (full/diff モード)
workflow_position: "実装フェーズ (★)"
handoff_flow: "requirements-definition → architecture-design → design-md → ui-mockup → functional-breakdown → feature-decomposition → task-decomposition → human-grade-qa(test-plan) → jit-task-execution(実装) → human-grade-qa(実走)"
---

## 🪜 テスト・ラダー（L1〜L5）— このスキルの責務（2026-09-02 追加・必須・省略不可）

> 規約の正本: `.claude/rules/common/test-ladder.md`（ここと矛盾したら規約が勝つ）。
> 由来: 2026-09-02、本番実走で 5 件（保存先バケット未作成 / AI の無言終了 / Bridge 終了後 90 秒の誤表示 /
> モード切替の無視 / 退会後もセッション有効）が出た。5 件とも正本に観点が無く、**実装が全部終わってから
> 「全体」を対象にテストを書いたため細部が抜けた**のが共通原因。テストは **タスク分解の時点で・タスク単位で**
> 作り（L1）、流れ（L2）は揃った瞬間に、Wave / リリース / 全体（L3〜L5）は締めで流す。

### Rule 11: `qa-ladder.py gate` が PASS しない限り PR を出さない（★2026-09-02 事故由来）

**STEP 4.5（STEP 4 と STEP 5 の間・毎タスク必須）:**

```bash
python3 scripts/ci/qa-ladder.py runnable --task T-X-Y   # ① 今流すべき L1 行と、このタスクで揃う L2 流れ
# ② staging で ①を全部実走する（ブラウザ通し・API・DB 突合・AI 実動）。ローカルのスタブ環境は単体・契約テストまで
# ③ 結果を正本 (apps/web/.qa/test-specs) に書き戻す: PASS / 理由つき BLOCKED / FAIL→直して再走。証拠パスを備考に
python3 scripts/ci/qa-ladder.py gate --task T-X-Y       # ④ PASS でなければ PR 禁止
```

- ④ が BLOCK なら **実装が終わっていない**。「テストは後で」「別 PR で」は Rule 6（gap tracker 登録）と同じ扱いで、その PR は merge 不可。
- 同じ PR で tickets.json の `status` を `done` にする（解禁判定の正）。
- PR description に必ず次のブロックを書く（CI と人が読む）:
  ```
  ## テスト・ラダー
  L1: SA01-031 PASS / SA01-032 PASS / SA01-033 BLOCKED(理由: …) — 証拠: apps/web/.qa/evidence/…
  L2: J-10 全行 PASS（揃った流れ）/ J-12 待ち（T-U-05 未 merge）
  gate: PASS
  ```
- **staging が未整備**（GAP-246 の状態）なら、流せなかった行を **BLOCKED（理由: staging 未整備）** として正本に残し、報告に「できなかったこと」として書く。ローカルで緑にして PASS と書くのは捏造。
- `dispatch.sh` が生成する `CLAUDE.md.task` の「5.5 テスト・ラダー」節が **（未定義）** なら、実装に入る前に task-decomposition へ戻して `qa_rows` を書く（Rule 4 と同じく仕様側を直す）。

### Rule 10 との関係

Rule 10（動作実証 8 点）は「作った機能が動く」の自己申告。Rule 11 は **正本の行が staging で PASS した記録**。両方要る。Rule 10 だけで PR を出した 2026-09-02 以前の運用に戻さない。



# JIT Task Execution

JIT (Just-In-Time) 設計プロジェクトで **1 タスク = 1 ブランチ = 1 PR** を仕様徹底で実装する
ためのスキル。実装者 (AI / 人間) が手抜きしても**構造的に漏れない**フローを提供する。

## このスキルが必要な理由

JIT 設計 (tickets.json 信頼源 + dispatcher.sh JIT 生成 + CI 10 gate) はそれ自体は完璧。
だが実装者が以下のような手抜きをすると簡単に漏れる:

- dispatcher を経由せず目視で tickets.json を読んで実装する
- selected-stack に書かれた技術を「動かないから placeholder で」と代替する
- AC の数字 (80%/0-error/100%) を「Phase 0 だから 0% でいい」と下げる
- files_changed_predicted の境界を「ついでに修正」と越える
- 「あとで」「TODO」を口にして gap を累積させる

このスキルは**毎タスク必ず JIT 標準フローを通す**ことで、上記の手抜きを構造的に防ぐ。

## 🛑 9 つの絶対ルール (1 つでも違反したら実装中止 + escalation)

> Rule 1-8 は仕様統制、**Rule 10 は「実装したものが実際に動くか」の統制**（事故由来・最重要）。
> 後半の「🛑 Rule 9: stub/境界throw/Phase-defer」は別建ての完了定義（重複ではない）。

### Rule 1: dispatcher 経由を強制
毎タスク `./09_dispatch/scripts/dispatch.sh T-X-Y` を実行する。preview だけで満足しない。
生成された `CLAUDE.md.task` をルートに配置 (既存 CLAUDE.md は `CLAUDE.md.bak` に退避)
してから実装着手。**目視で tickets.json を読んで実装するのは禁止**。

### Rule 2: per-task /goal 固定
dispatcher 出力 + tickets.json から per-task /goal テキストを生成し `/goal` で起動する。
これによりタスクの仕様 (editable / shared_read / forbidden / 3-tier AC) が
セッション中に常時 enforce される。テンプレートは `references/goal-template.md`。

### Rule 3: selected-stack の確定済技術を必ず使う
`03_architecture/selected-stack.json` (またはそれに相当する技術選定 JSON) に
書かれた選定を曲げない:
- `uv` と書いてあるなら uv (pip 不可)
- `Husky + lint-staged` と書いてあるなら Husky (未配線不可)
- `pyright strict` と書いてあるなら strict (standard へ下げ不可)
- `ESLint + Prettier` と書いてあるなら両方入れる (片方不可)

「動かないから placeholder で逃げる」を選んだ瞬間に **STOP** → tickets.json で
scope を expand する別 PR を先に起票する。

### Rule 4: AC 定量条件を絶対に下げない
`acceptance_criteria_inline` の数字 (coverage 80%, 0-error, 100%) を**絶対に下げない**。
placeholder code が threshold を満たさないなら、threshold を下げるのではなく
以下のいずれかで対処する:
- テストを書く
- 実装を整える
- 該当ファイルを coverage の exclude に追加 (理由を明示)

### Rule 5: files_changed_predicted を 1 文字も逸脱しない
`files_changed_predicted.new` ∪ `files_changed_predicted.modify` に含まれない
ファイルを touch した瞬間に違反。違反が必要なら必ず tickets.json 更新 PR を先行する。

### Rule 6: 「あとで」「placeholder」「TODO」を gap tracker に登録
PR description に `_TRACK:` 接頭辞で記載し、GitHub Issue を起票する。
そのタスクが完了するまで関連 PR は merge 禁止。

### Rule 7: 「動けばいい」モード禁止
仕様を曲げそうになったら、まず手を止めて tickets.json を更新する PR を出す。
実装を歪めて辻褄を合わせない。

### Rule 8: CI 10 gate は実体実装で全 PASS
soft-pass (`::notice::pending T-F-XX`) で逃げない。各 gate が「実際に何かを検証する」
状態を維持する。依存タスク未完了で skip するなら、依存タスクが merge された時点で
即座に有効化する PR を起票する。

### Rule 10: 「描画した」で完了にしない — 動作実証ゲート (★事故由来・最重要)

> 由来: 全チケットに監査記録があり、ユニットテスト200本超が緑、CI 8ゲート全green、
> 12画面のビジュアルパス完了。にもかかわらず実機QAで **製品バグ30件**（ユーザーが確実に詰むもの7件・
> セキュリティ2件）が出た。原因は個人の注意不足ではなく **AC が「画面が描画される」で
> 合格を出せた**こと。ACを変えない限り必ず再発する。

UI/画面/機能タスクは、以下 **8 点すべて**を満たすまで PR を出してはいけない。
1 点でも書けない/確認していないものがあれば、その項目を未実装として残す（完了にしない）。

| # | ゲート | 具体的に何をするか |
|---|---|---|
| 1 | **描画** | モックの全要素が存在し、値が**プレースホルダで固定されていない**（`—`/空のまま実データでも変わらない列は未実装） |
| 2 | **到達** | ナビ/リンクから到達でき、**href が実在ルート**。ルート集合との機械照合テストを置く |
| 3 | **動作** | 実装した**全操作要素を実ブラウザで1回は自分で押す**。押した結果（遷移/DB変化/表示変化）を確認 |
| 4 | **結線** | `related_apis` の各エンドポイントが**UIのどの操作から呼ばれるか**を1行で書ける |
| 5 | **仕様** | 仕様の `states` / `transitions` を**実装に1対1で対応付けられる** |
| 6 | **防御** | 「起きてはいけない」事項を **何層で守っているか**列挙（1層のみなら理由を書く） |
| 7 | **共通** | 共通シェル（ヘッダ/ナビ/フッタ）を触ったら**それを含む全画面**で確認（1画面でOKにしない） |
| 8 | **反映** | 書き込みは**別GETで再取得**して画面とDBに反映されることを確認（作成レスポンスだけで合格にしない） |

**ユニットテストが緑でも上記3は代替できない**。jsdomは (a) ブラウザ標準のフォームバリデーション
(b) SVG/チャートライブラリのポインタイベント (c) mousemove由来のホバー・アクティブ状態
を再現しないため、**実機で死ぬ実装がユニットテストでは原理的に緑になる**。

類型と検出手段の全体像は [rules/common/lessons-learned.md](../../rules/common/lessons-learned.md) L-003
（検証ギャップ図鑑 G-01〜G-10）を参照。実装前に該当類型を確認する。

## 🚀 5 STEP 標準フロー

### STEP 0: 事前検証 (毎回)
```bash
./09_dispatch/scripts/validate.sh
```
「✓ PASS」を確認。1 件でも fail なら tickets.json 修正 PR を先行。

### STEP 1: タスク選択
依存解除済 + 未着手 + 自分の `assigned_employee` を選ぶ。

### STEP 2: JIT preview で 8 セクション精読
```bash
./09_dispatch/scripts/dispatch.sh --preview T-X-Y | less
```
8 セクション (YES/NO / 上流参照 / 仕様 / **ファイル境界** / **3-tier AC** / テスト / 手順 / 失敗時)
を全て頭に入れる。

### STEP 3: JIT generate + ブランチ作成 + /goal 固定
```bash
./09_dispatch/scripts/dispatch.sh T-X-Y
git checkout -b feat/t-x-y-<slug>
[ -f CLAUDE.md ] && mv CLAUDE.md CLAUDE.md.bak
cp /tmp/atelier-dispatch-.../CLAUDE.md ./CLAUDE.md.task
```
**per-task /goal を生成して /goal で起動**:
```bash
python3 ~/.claude/skills/jit-task-execution/scripts/generate_goal.py T-X-Y
# → 出力を /goal にコピペ
```

### STEP 4: 実装 + 3-tier AC ローカル検証
実装中の毎判断で 6 種 chant-check を自己実行 (詳細 `references/chant-checks.md`):
1. ファイル境界 — `git status` の変更が editable に含まれるか
2. selected-stack — 採用技術が確定済と一致するか
3. AC threshold — 数字を下げる変更をしようとしていないか
4. placeholder 逃避 — `echo placeholder` / `NotImplementedError` / `TODO`
5. CI soft-pass — `::notice::pending` / `|| true`
6. 仕様独自解釈 — strict→standard 等の妥協

**PR を出す直前に Rule 10 の動作実証ゲート 8 点を自己申告する**（PR description に記載）:
```
## 動作実証（Rule 10）
1 描画: モック全要素あり・プレースホルダ固定なし → OK（確認方法: ...）
2 到達: href ⇔ 実在ルート照合テスト追加 → OK
3 動作: 押した操作要素 = [保存/編集/取消/...]・結果 = [...] → OK（実ブラウザ）
4 結線: related_apis [POST /api/x → 「保存」ボタン, GET /api/y → 初期表示] → OK
5 仕様: states [初期→編集中→保存済] ⇔ 実装 [...] → OK
6 防御: 「Xしてはいけない」= UI + API + DB CHECK の3層 → OK
7 共通: 共通シェル未変更（または変更したので全N画面で確認） → OK
8 反映: 保存後に別GETで再取得し画面とDBに反映を確認 → OK
```
書けない項目があるなら、その機能は**未実装として残し完了にしない**。

### STEP 5: push + PR auto-create
```bash
git push -u origin feat/t-x-y-<slug>
```
CI 10 gate 全 PASS で auto-merge。fail なら retry × 3 (backoff 10s/30s/60s)。
3 連続 fail で S-E01 GitHub Issue 自動起票。

完了後:
```bash
git checkout main && git pull --rebase origin main
rm CLAUDE.md.task && [ -f CLAUDE.md.bak ] && mv CLAUDE.md.bak CLAUDE.md
```

## 🚨 escalation 判定

以下に該当したら **S-E01 escalation** (人間 review 必須):
- CI gate 10 のいずれかが retry × 3 しても PASS しない
- 致命級タスク (R-T08 RLS / API 契約凍結 / 本番 go/no-go) は経営者承認待ち
- selected-stack / AC の数字を変更する必要があると判断した
- Rule 1-8 を違反しないと進められない状況

GitHub Issue を `escalation,blocking,human-required` ラベルで自動起票。

## 📦 出力形式

このスキル起動時に以下を生成:

1. **per-task /goal テキスト** (CLAUDE.md.task から `generate_goal.py` で抽出)
2. **完了チェックリスト** (3-tier AC + 6 種 chant-check)
3. **escalation 判定** (該当する場合)
4. **次タスク候補** (依存解除されたもの)

## 📚 詳細リファレンス

- `references/goal-template.md` — per-task /goal の詳細テンプレート + 自動生成ロジック
- `references/chant-checks.md` — 6 種 chant-check の検出方法とアクション
- `references/ci-10-gate.md` — CI 10 gate の各 AC と実体実装ガイド
- `references/escalation.md` — S-E01 escalation の運用フロー
- `scripts/generate_goal.py` — tickets.json から /goal テキスト生成

## 🛠 既存スキルとの関係

| スキル | 役割 | 本スキルとの関係 |
|---|---|---|
| distributed-dev | tickets.json + CLAUDE.md 生成 | 本スキルが**消費** |
| task-decomposition | タスクカード生成 | 本スキルが**実装** |
| architecture-design | selected-stack 確定 | 本スキルが**遵守** |
| functional-breakdown | screen/entity/api mapping | 本スキルが**参照** |

本スキルは**実装フェーズの実行統制**を担う。上流 4 スキルの出力を一切曲げずに
「コードに落とす」役割。

## ハンドオフ (標準フロー連携)

このスキルは以下の標準ワークフロー内に位置する。完了時に「次は **human-grade-qa (full/diff モード)** へ進みますか?」とユーザーに確認する。

```
[1] requirements-definition (要件定義)
  ↓
[2] architecture-design (アーキ設計)
  ↓
[3] design-md (デザインシステム / DESIGN.md)
  ↓
[3.5] ui-mockup (画面HTMLモックアップ / mock-contract-hints.json)
  ↓
[4] functional-breakdown (機能・画面・エンティティ徹底分解)
  ↓
[5] feature-decomposition (Phase × Wave 機能分解)
  ↓
[6] task-decomposition (タスクカード化)
  ↓
[7] human-grade-qa【test-plan モード / 実装前】★ 画面別+フロー+RLS の3軸でテスト仕様書を完璧に作る
  ↓
[★ ここ] jit-task-execution (実装期間 / 1タスク=1ブランチ=1PR)
  ↓
[8] human-grade-qa【full / diff / feature / regression モード / 実装後】★ 実機で潰す
  ↓
完了
```

### このスキルの位置
- **前段スキル**: `human-grade-qa (test-plan モード)` (実装前テスト仕様書)
- **次段スキル**: `human-grade-qa (full/diff モード)` (実機で潰す)
- **フロー位置**: 実装フェーズ (★ / フロー外)

### 完了時のハンドオフ宣言

1タスク (= 1PR merge) 完了時、以下を提示する:

```
✅ jit-task-execution タスク <T-XX> 完了

📌 次に進めるべきスキル: `human-grade-qa (full/diff モード)`

→ PR 単位で diff モード推奨。リリース前は full モード。
   別タスクに継続する場合: 次の T-XX を指定して再起動。
```

全タスク完了 (= Phase 完了) 時、human-grade-qa の full モードへ自動誘導する。


## 🛑 Rule 9: stub / 境界throw / Phase-defer を「完了」にしない（汎用・再発防止）

「部品はできた」は「機能が動く」ではない。以下を **done にしない**:
- `stub`/`echo`/プレースホルダ応答のまま
- 「後の Phase で配線する」と先送り
- アダプタ境界が `not configured` で **throw するだけ**（実経路に未接続）

**critical path（ユーザー価値が通る経路）に未配線が残るなら STOP** → 結線タスク(wiring ticket)を起票してから着手/完了する。境界実装が仕様上妥当でも、それを実経路へ結線する追跡タスクが**存在しない限り完了にしない**。

自己チェック(各タスク完了時):
- このタスクの成果物は **誰かから register/呼出され、実行ループに繋がっている**か？
- 残した stub/境界は **置換/結線する別チケットが起票済み**か？
