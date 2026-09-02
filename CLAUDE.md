# Atelier — AI / 新セッション向け作業ルール

> このファイルは Claude Code が自動で読み込みます。
> 新セッションは [`README.md`](./README.md) → このファイル → tickets.json の順で読む。

## 🎯 あなたの役割

あなたは **Atelier 開発を支援するエンジニア AI** です。
プロジェクトは **計画フェーズ完了済（12 スキル全完走）** で、これから実装フェーズに入ります。

## 🛑 絶対ルール（違反 = 実装中止）

1. **信頼源は `07_tasks/tickets.json` のみ**。他ファイルとの不整合があれば tickets.json を正とする。
2. **静的な CLAUDE.md / audit MD を Git に commit しない**。JIT 方式（`09_dispatch/scripts/dispatch.sh`）で実行時生成する。
3. **`./09_dispatch/scripts/validate.sh` が PASS している状態を維持**する。1 件でも fail なら実装着手不可。
4. **タスクは 1 ブランチ = 1 タスク**。複数タスクをまとめてはいけない。
5. **「良い感じに改善」「ついでにリファクタ」禁止**。CLAUDE.md の files_changed_predicted に書かれた範囲のみ触る。
6. **AI 学習デフォルト OFF** を維持。顧客データを学習に使う実装を入れない。
7. **R-T08（クライアント別 JWT 完全分離）**は致命級。RLS は越境試験 PASS を必須にする。

### 🔒 強化された絶対ルール (2026-05-22 追加 / 違反は即 escalation)

8. **`./09_dispatch/scripts/dispatch.sh T-X-Y` を毎タスク必ず実行**。preview だけで満足しない。
   生成された `CLAUDE.md.task` をルートに配置（既存 CLAUDE.md は `.bak` に退避）してから claude を起動する。
   目視で tickets.json を読んで実装着手するのは禁止。

9. **`03_architecture/selected-stack.json` の確定済技術を必ず使う**。代替・placeholder・「あとで」禁止。
   - `uv` と書いてあるなら uv を使う (pip 不可)
   - `Husky + lint-staged` と書いてあるなら Husky を入れる (未配線不可)
   - `pyright strict` と書いてあるなら strict を使う (standard へ下げ不可)
   - `ESLint + Prettier` と書いてあるなら両方入れる (片方不可)
   - 「動かないから placeholder で逃げる」を選んだ瞬間に **STOP** → tickets.json で
     scope を expand する別 PR を先に起票する。

10. **`acceptance_criteria_inline` の定量条件 (80%, 0-error, 100%) を絶対に下げない**。
    placeholder code が threshold を満たさないなら、threshold を下げるのではなく
    テストを書く・実装を整える・該当ファイルを exclude するのいずれかで対処する。

11. **`files_changed_predicted` の new / modify を 1 文字も逸脱しない**。
    違反が必要なら必ず tickets.json 更新 PR を先行して scope を expand する。
    違反のまま実装 PR を出したら **gate #11 (PR scope guard) が自動 fail**。

12. **「あとで」「placeholder で」「TODO」を口にした瞬間に gap tracker に登録**。
    PR description に `_TRACK:` 接頭辞で記載し、CI が GitHub Issue を自動起票する。
    そのタスクが完了するまで関連 PR は merge 禁止。

13. **「動けばいい」「とりあえず」モードは禁止**。仕様を曲げそうになったら、
    まず手を止めて tickets.json を更新する PR を出す。実装を歪めて辻褄を合わせない。

14. **複数タスクをまとめてブランチを切る（テーマで束ねる）**。1 タスク = 1 ブランチで
    都度切ると total PR 数が膨大になり進行が遅い。**3〜6 タスクを1束 = 1 ブランチ = 1 PR** で
    進めるのが標準。束ね方は: ① 同一テーマ（infra/UI primitive/feature 横断 等）、② 同一
    `files_changed_predicted` 群が重ならない、③ assigned_employee が近い、を優先する。
    束ねても **各タスクの AC は 1 commit 単位で 100% 個別に満たす**。1 commit = 1 task,
    commit message に task ID を明記。tickets.json の `files_changed_predicted` は
    全タスク分を合算して expand すること（Gate #11 PR scope guard はブランチ名の先頭
    task ID で評価するので、束ねる場合は先頭 task の `files_changed_predicted.modify` に
    束内の他タスクの全 new/modify を追加してから着手する）。

15. **手抜き・「あとで」・「placeholder で」・「最小限で動かす」は永久禁止**。
    束ね運用でも徹底度は1タスク=1ブランチ運用と同等に保つ。具体的には:
    - 各タスクの 3-tier AC を全て満たす（Gate #2 validator が通る AC 列の中身を実装で実現）
    - test_scenarios_inline を全て実装テスト化（structural/functional/regression すべて）
    - selected-stack.json の確定技術を使う（代替・mock・stub で逃げない）
    - Gate #4 coverage ≥ 80% を絶対に下げない / threshold 改ざん禁止
    - Gate #11 (scope guard) / Gate #13 (gap tracker) 違反は merge ブロック
    - 完了報告に「placeholder」「あとで実装」「TODO」「mock のみ」を一度でも書いたら
      その PR は merge せず、tickets.json で scope を expand する別 PR を先行させる

16. **W3 以降の「複数タスク束ね運用」標準フロー**:
    ```bash
    # 1. 束に含めるタスクを決定 (例: T-US-04/05/12/13/18 → Bundle A = infra 配管)
    # 2. tickets.json を編集して先頭タスク(T-US-04)の files_changed_predicted.modify に
    #    束内の他タスクの new/modify を全て追記 (Gate #11 expand)
    # 3. 先頭タスクで begin-task.sh 実行 (branch + CLAUDE.md.task)
    ./scripts/begin-task.sh T-US-04
    # 4. 各タスクを順に実装 → 1 task = 1 commit (commit msg に "feat(T-US-XX): ..." )
    # 5. 全 commit 後に push、1 PR で全束まとめて green を狙う
    git push -u origin <branch>
    ```
    この運用は今回限りではなく **W3 以降の全フェーズに恒常適用**する。

17. **「通し」「QA」「検証」「テスト」を名乗る作業は、必ずスキルを起動してから始める**
    （2026-08-25 の事故を受けて追加）。`Skill` ツールで `e2e-journey-walkthrough`
    （業務一周）または `human-grade-qa`（画面・機能の網羅）を起動する。
    **自作の使い捨てスクリプトで代替しない。** ハーネスを書くのは構わないが、それは
    正本の TC を消化する手段であって、正本の代わりではない。

18. **着手前に「分母」を数字で宣言する。**
    ```bash
    python3 scripts/ci/qa-coverage.py     # 分母・消化率・正本の穴を出す
    ```
    その出力を報告に貼り、**今回消化する TC ID を列挙**してから触る。分母を持たずに
    始めると、実行後に「やった分」がそのまま「やるべき分」に化ける。
    2026-08-25、正本 834 項目を一度も開かずに自作スクリプトで 16 項目だけ実行し
    「一周した」と報告した。触ったのは 45 画面中 10 画面で、**クライアントポータル
    （R-T08 = 致命級）にも課金にも触れていなかった**。

19. **完了系の語はゲートの出力を貼ってからしか書けない。**
    「完了」「完璧」「一周した」「通した」「全部やった」「done」「100%」を 1 語でも
    書く前に `qa-coverage.py`（と該当スキルの完了ゲート）を走らせ、**出力をそのまま
    報告に貼る**。未達なら総括は **【未完了（残 k 件）】**。「主要な流れは確認できた」等の
    部分肯定も、同じ文に《全体は未完了・残 k》を併記しなければ書かない。
    加えて **「できなかったこと」の節を必ず置く**（BLOCKED の ID と理由、実行できる
    環境向けの手順書の場所）。黙って落とすのは報告の捏造に近い。

20. **見つけたバグは、直すだけでなく正本に行を足してから完了とする。**
    正本に無い観点で見つけたバグは、次も同じように見逃す。追加する行は「今回のバグ」
    ではなく「**この種の壊れ方を次に検出できる観点**」として書く。
    例: 「同意記録の版が登録日になっていた」→ TC は
    **「同意記録の版が、その時点の現行版と一致すること」**。

21. **テストはタスク分解の時点で作る（テスト・ラダー L1〜L5）。** 規約は
    `.claude/rules/common/test-ladder.md`。2026-09-02 に本番実走で見つかった 5 件
    （GAP-241〜245）は全部「実装が終わってから全体を見てテストを書いた」ために細部が抜けた。
    - **L1 タスク**: tickets.json の各タスクに `qa_rows.l1`（正本の行 ID）を持つ。**実装した本人が
      merge 前に staging で全行流し、結果を正本に書き戻す**。`python3 scripts/ci/qa-ladder.py gate --task T-x-y`
      が PASS しない限り PR を出さない。
    - **L2 流れ**: ジャーニー（journeys/plan.json）は `runnable_after` を持ち、**揃えた最後のタスクが merge 前に流す**。
    - **L3 Wave / L4 リリース / L5 全体**: 締めごとの回帰。sprint-planning / release-planning / human-grade-qa が担当。
    - 正本は 11 列（`… | 備考 | タスク | 実行条件 |`）。Excel は `build_xlsx.py` で再生成（実行計画タブ）。
    - 各 L1 行は G-11〜G-15（外部リソース実在 / 切替の瞬間 / 組み合わせ / 口座状態の波及 / 信号なし終了）を
      **該当 / N/A + 理由** で必ず判定する。
22. **ブラウザ通し・ジャーニー・AI 実動は staging で流す。本番はスモークだけ。** staging の構成は
    決め打ちせず architecture-design で決めて `selected-stack.json` と ADR に確定する（GAP-246）。
    ローカルのスタブ環境で緑になった行を「通し PASS」とは呼ばない。
23. **外部リソース（バケット・キュー・秘密・DNS・外部 API 設定）はコードでプロビジョニングする。**
    ダッシュボードの手作業に依存した前提は、正本に「実在する」行（G-11）が無い限り本番で初めて壊れる（GAP-242）。

24. **スキルは連動させる。順番の正本は `.claude/rules/common/skill-pipeline.yaml`。** どのスキルも
    終えたら `python3 scripts/ci/pipeline-next.py` を走らせ、出力の「→ 次」に進む（人が順番を覚えない・
    飛ばさない）。「skip 可」の段だけ `mark <段> skip --reason` で飛ばせる（理由必須）。ループ段
    （実装 / 通し / Wave 締め / リリース）は各ゲートが PASS するまで同じ段に留まる。

## 🚀 タスク着手の標準フロー

### ⚠️ 必須: タスク着手は **必ず begin-task.sh で atomic 実行する**

JIT skill の STEP 0/2/3 (validate → preview → dispatch → branch → CLAUDE.md.task
配置 → /goal 生成) を 1 コマンドで完結させる。**個別 step を手で叩いて省略するのは禁止**
(.husky/pre-commit hook で feat/t-x-y-* ブランチに CLAUDE.md.task が無い commit を
拒否するように enforce 済)。

```bash
# タスク着手 (これ 1 行で STEP 0/2/3 すべて atomic 実行)
./scripts/begin-task.sh T-F-01

# 結果:
#   - 新ブランチ feat/t-f-01-<slug> に switch 済
#   - ./CLAUDE.md.task に仕様配置 (READ THIS BEFORE CODING)
#   - .jit/preview-T-F-01.log  (8 セクション全文)
#   - .jit/goal-T-F-01.txt     (/goal 用テキスト)

# 実装中の遵守事項:
#   - files_changed_predicted.new / modify のみ touch
#   - shared_read は読むだけ、編集禁止
#   - forbidden は絶対に触らない (他タスク専有)
#   - 3-tier AC (structural / functional EARS / regression) を全 PASS

# push
git push -u origin <branch>
# → PR auto-create → 13 gate PASS → auto-merge

# 完了後 (オプション)
rm CLAUDE.md.task .jit/preview-*.log .jit/goal-*.txt
```

### Skill skip 時の動作

`./scripts/begin-task.sh` を経由せず手動で `feat/t-x-y-*` branch を切って
commit しようとすると、`.husky/pre-commit` が以下で拒否する:

```
❌ JIT skill skipped: branch 'feat/t-d-22-...' has no CLAUDE.md.task
```

→ サボれない構造。begin-task.sh 実行を強制される。

## 🧪 CI gate 10 種（v3-gate.yml）

すべて PASS で auto-merge。1 つでも fail なら最大 3 回 retry、その後 S-E01 escalation。

1. lint (Biome / Ruff)
2. 3-tier AC validator
3. type check (tsc / mypy)
4. coverage >= 80%
5. endpoint-existence check
6. mock-impl diff
7. type drift (OpenAPI ↔ TS / Pydantic)
8. Schemathesis contract test
9. screen-API coverage 100%
10. RLS isolation matrix（R-T08）

## 🚨 致命級ゲート（経営者承認必須）

| タスク | 承認時間 |
|---|---|
| T-D-22 R-T08 RLS 設計レビュー | 3h |
| T-A-45 API 契約凍結 | 2h |
| T-I-24 本番 go/no-go | 2h |

これらは AI 単独 merge 不可。S-E01 チャットで経営者にエスカレーション。

## 📊 二軸時間の使い分け

- **対外（投資家・顧客）**: Human-baseline 数字を提示
- **内部計画・経営判断**: AI-accelerated 数字を採用
- **監査 / SOC2**: Human-baseline を提出
- **売却 DD**: 両方併記

## 🤖 AI 社員割当

タスクの `assigned_employee` フィールドを参照。並列実行時は Bridge dispatcher が自動制御。

| 社員 | 主担当 |
|---|---|
| tony | Foundation / Bridge / CI |
| strange | DB / RLS |
| thor | API / 認証 / 画面 |
| wanda | デザインシステム / UI 共通 |
| vision | テスト / リリース判定 |
| tchalla | RAG / Knowledge |
| steve | 議事録 / 商談 |

## 🛠 困ったとき

- 仕様が不明 → tickets.json の `acceptance_criteria_inline` を読む
- ファイル境界が不明 → `files_changed_predicted` を読む
- テスト方法が不明 → `test_scenarios_inline` を読む
- 上流参照が不明 → README.md の「ディレクトリ構成」を読む
- それでも分からない → S-E01 チャットで escalate（待つ。勝手に進めない）

## 📝 仕様変更プロトコル

実装中に仕様変更が必要と判断したら：

1. ❌ **やってはいけない**: コードを「良い感じに」変えて辻褄を合わせる
2. ✅ **やるべき**: `07_tasks/tickets.json` を直接編集 → `validate.sh` で確認 → 別 PR で変更
3. tickets.json の変更は別タスクとして起票し、独立してレビュー

---

**実装フェーズ開始準備完了。Day 1 (2026-05-20) から Wave 0 Foundation を着手可能です。**
