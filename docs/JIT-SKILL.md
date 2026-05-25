# JIT Task Execution Skill (Atelier self-contained 版)

> このファイルは `~/.claude/skills/jit-task-execution/SKILL.md` の self-contained コピー。
> スマホ Claude (Web / iOS) など skill にアクセスできない環境でも、本 repo を読むだけで
> JIT skill 全文を取得できるようにするためのもの。
>
> **更新元**: `~/.claude/skills/jit-task-execution/SKILL.md`
> **同期方針**: skill 本体を更新したら本ファイルも手動で同期する (CI gate 未設置)。

---

## このスキルが必要な理由

JIT 設計 (tickets.json 信頼源 + dispatcher.sh JIT 生成 + CI 13 gate) はそれ自体は完璧。
だが実装者が以下のような手抜きをすると簡単に漏れる:

- dispatcher を経由せず目視で tickets.json を読んで実装する
- selected-stack に書かれた技術を「動かないから placeholder で」と代替する
- AC の数字 (80%/0-error/100%) を「Phase 0 だから 0% でいい」と下げる
- files_changed_predicted の境界を「ついでに修正」と越える
- 「あとで」「TODO」を口にして gap を累積させる

このスキルは **毎タスク必ず JIT 標準フローを通す** ことで、上記の手抜きを構造的に防ぐ。

---

## 🛑 8 つの絶対ルール (1 つでも違反したら実装中止 + escalation)

### Rule 1: dispatcher 経由を強制
毎タスク `./09_dispatch/scripts/dispatch.sh T-X-Y` を実行する。preview だけで満足しない。
生成された `CLAUDE.md.task` をルートに配置 (既存 CLAUDE.md は `CLAUDE.md.bak` に退避)
してから実装着手。**目視で tickets.json を読んで実装するのは禁止**。

### Rule 2: per-task /goal 固定
dispatcher 出力 + tickets.json から per-task /goal テキストを生成し `/goal` で起動する。
これによりタスクの仕様 (editable / shared_read / forbidden / 3-tier AC) が
セッション中に常時 enforce される。

### Rule 3: selected-stack の確定済技術を必ず使う
`03_architecture/selected-stack.json` に書かれた選定を曲げない:
- `uv` と書いてあるなら uv (pip 不可)
- `Husky + lint-staged` と書いてあるなら Husky (未配線不可)
- `pyright strict` と書いてあるなら strict (standard へ下げ不可)
- `ESLint + Prettier` と書いてあるなら両方入れる (片方不可)

「動かないから placeholder で逃げる」を選んだ瞬間に **STOP** → tickets.json で
scope を expand する別 PR を先に起票する。

### Rule 4: AC 定量条件を絶対に下げない
`acceptance_criteria_inline` の数字 (coverage 80%, 0-error, 100%) を **絶対に下げない**。
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

### Rule 8: CI 13 gate は実体実装で全 PASS
soft-pass (`::notice::pending T-F-XX`) で逃げない。各 gate が「実際に何かを検証する」
状態を維持する。

---

## 🚀 5 STEP 標準フロー

### STEP 0–3: atomic 実行 (推奨)

Atelier では以下 1 コマンドで STEP 0/2/3 を atomic 実行する:

```bash
./scripts/begin-task.sh T-X-Y
```

実行内容:
- STEP 0: `./09_dispatch/scripts/validate.sh` PASS 確認
- STEP 2: `dispatch.sh --preview` を `.jit/preview-T-X-Y.log` に保存
- STEP 3: `dispatch.sh` 実行 → ブランチ作成 → `CLAUDE.md.task` 配置 → `/goal` テキスト生成

完了後の状態:
- 新ブランチ `feat/t-x-y-<slug>` に switch 済
- `./CLAUDE.md.task` (READ THIS BEFORE CODING)
- `.jit/preview-T-X-Y.log` (8 セクション全文)
- `.jit/goal-T-X-Y.txt` (`/goal` 用テキスト)

`.husky/pre-commit` が `feat/t-x-y-*` ブランチに `CLAUDE.md.task` が無い commit を
拒否するように enforce 済 → **begin-task.sh を省略できない構造**。

### STEP 4: 実装 + 3-tier AC ローカル検証

実装中の毎判断で 6 種 chant-check を自己実行:
1. **ファイル境界** — `git status` の変更が editable に含まれるか
2. **selected-stack** — 採用技術が確定済と一致するか
3. **AC threshold** — 数字を下げる変更をしようとしていないか
4. **placeholder 逃避** — `echo placeholder` / `NotImplementedError` / `TODO`
5. **CI soft-pass** — `::notice::pending` / `|| true`
6. **仕様独自解釈** — strict→standard 等の妥協

### STEP 5: push + PR auto-create

```bash
git push -u origin feat/t-x-y-<slug>
```

CI 13 gate 全 PASS で auto-merge。fail なら retry × 3 (backoff 10s/30s/60s)。
3 連続 fail で S-E01 GitHub Issue 自動起票。

完了後:
```bash
git checkout main && git pull --rebase origin main
rm CLAUDE.md.task && [ -f CLAUDE.md.bak ] && mv CLAUDE.md.bak CLAUDE.md
```

---

## 🚨 escalation 判定

以下に該当したら **S-E01 escalation** (人間 review 必須):
- CI gate のいずれかが retry × 3 しても PASS しない
- 致命級タスク (R-T08 RLS / API 契約凍結 / 本番 go/no-go) は経営者承認待ち
- selected-stack / AC の数字を変更する必要があると判断した
- Rule 1-8 を違反しないと進められない状況

GitHub Issue を `escalation,blocking,human-required` ラベルで自動起票。

---

## 🛠 既存スキルとの関係

| スキル | 役割 | 本スキルとの関係 |
|---|---|---|
| distributed-dev | tickets.json + CLAUDE.md 生成 | 本スキルが **消費** |
| task-decomposition | タスクカード生成 | 本スキルが **実装** |
| architecture-design | selected-stack 確定 | 本スキルが **遵守** |
| functional-breakdown | screen/entity/api mapping | 本スキルが **参照** |

本スキルは **実装フェーズの実行統制** を担う。上流 4 スキルの出力を一切曲げずに
「コードに落とす」役割。

---

## モバイル運用 tips

スマホ Claude で skill 本体がロードできない場合:

1. このファイル全文を Claude に読ませる (repo URL → raw → paste、または GitHub MCP)
2. `docs/PROJECT-STATE.md` で現状を把握させる
3. 「次タスク T-X-Y を JIT skill 経由で実装」と指示
4. AI は `./scripts/begin-task.sh T-X-Y` から開始する (1 コマンドで STEP 0/2/3)

PC 上で skill が ~/.claude/skills/ にある場合と等価な遵守が実現する。
