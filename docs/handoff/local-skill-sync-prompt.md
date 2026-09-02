# ローカルセッション用プロンプト — スキル一式の取り込み（2026-09-02）

> ローカル（Mac）で Claude Code を開き、以下をそのまま貼る。
> 目的: リポジトリで更新した 11 スキル + 共通規約 + パイプライン定義を **ローカルのスキル置き場（同期元）に反映**し、
> リポジトリに無い `spec-sync-orchestrator` にも同じ更新（パッチ）を当てる。新規作成ではなく **更新**。

---

```
Atelier リポジトリ（~/Atelier）で 2026-09-02 に「テスト・ラダー（L1〜L5）」と「スキルのパイプライン連動」を入れました。
これをローカルのスキル置き場に取り込んでください。新しく作るのではなく、既存スキルの更新です。

## 0. 前提
- まず `cd ~/Atelier && git fetch origin && git pull origin main` で最新の main を取る（main に取り込み済みでなければ
  `git push origin origin/claude/check-remote-main-status-y9exq0:main && git pull origin main` を先に実行）。
- 規約の正本: `.claude/rules/common/test-ladder.md`、順番の正本: `.claude/rules/common/skill-pipeline.yaml`、
  機械ゲート: `scripts/ci/qa-ladder.py` / `scripts/ci/pipeline-next.py`。先に 3 つとも読むこと。

## 1. ローカルのスキル置き場を特定する
- `~/.claude/skills/` と、cc-config の同期元（`~/cc-config/skills/` か、`~/.claude/skills/synced/…` の元になっているフォルダ）を
  `ls` で確認し、**同期元（編集して残る場所）** を報告してから進める。分からなければ止めて聞く。

## 2. 11 スキルを「更新」する（上書きではなく差分を当てる）
対象: task-decomposition / jit-task-execution / test-verification / acceptance-criteria / architecture-design /
distributed-dev / feature-decomposition / sprint-planning / release-planning / human-grade-qa / e2e-journey-walkthrough
- リポジトリの `~/Atelier/.claude/skills/<name>/` が更新版。各 SKILL.md には
  「## 🪜 テスト・ラダー（L1〜L5）— このスキルの責務」節と「### パイプライン連動（自動で次へ）」節が入っている。
- ローカルの同じスキルに対して、**frontmatter の description 末尾に v3.2 の 1 行を足し、frontmatter 直後にこの 2 節を挿入**する
  （ローカル側に独自の改変がある場合は消さず、リポジトリ版と diff を取って両方残す）。
- human-grade-qa は `scripts/build_xlsx.py`（11 列 + 実行計画タブ）と `scripts/qa_ladder.py`（新規）も反映する。
- 反映後、各 SKILL.md で `grep -c "テスト・ラダー（L1〜L5）— このスキルの責務"` が 1、`grep -c "パイプライン連動（自動で次へ"` が 1 になることを確認し、
  frontmatter が YAML として壊れていないこと（`description:` がブロック `|` のものは `|` 行の後ろに文字を足さない）を確認する。

## 3. spec-sync-orchestrator（リポジトリに本体が無い・ローカルにある）
- `~/Atelier/.claude/skills/spec-sync-orchestrator/LADDER-PIPELINE-PATCH.md` を開き、書いてあるとおりに
  ローカルの spec-sync-orchestrator/SKILL.md へ節を挿入し、description に v3.2 を足し、assets/spec-dependencies.yaml に
  `qa_ladder_bidirectional` / `staging_defined` の 2 参照を追記する。
- 反映後、ローカルの SKILL.md を `~/Atelier/.claude/skills/spec-sync-orchestrator/SKILL.md` にコピーして
  リポジトリにも本体を置く（次からリポジトリだけで完結させるため）。

## 4. 共通規約とパイプライン定義を共有場所にも置く
- `~/Atelier/.claude/rules/common/test-ladder.md` と `skill-pipeline.yaml` を、ローカルの共通 rules 置き場
  （`~/.claude/rules/common/` 等、lessons-learned.md がある場所）にもコピーする。lessons-learned.md の L-003 に
  G-11〜G-15（test-ladder.md §4 の表）を追記する。

## 5. 動作確認（貼って報告する）
cd ~/Atelier
bash 09_dispatch/scripts/validate.sh | tail -3          # qa-ladder validate が PASS
python3 scripts/ci/qa-ladder.py levels                  # 段別集計
python3 scripts/ci/pipeline-next.py                     # 次に起動するスキルが出る
python3 .claude/skills/human-grade-qa/scripts/build_xlsx.py apps/web/.qa/test-specs apps/web/.qa   # 実行計画タブ

## 6. 報告の形
- 反映したスキル名の一覧（11 + spec-sync-orchestrator）と、それぞれ「挿入した節 / 変えた description」
- ローカル側に独自改変があって統合したもの
- できなかったこと（理由つき）
- 最後に `git -C ~/Atelier status` と、ローカルのスキル置き場の変更一覧

禁止: スキルを新規作成すること、リポジトリ版で丸ごと上書きしてローカルの改変を消すこと、
確認コマンドを走らせずに「反映した」と書くこと。
```
