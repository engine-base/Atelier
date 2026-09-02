# 6 種 chant-check の検出方法とアクション

実装中、各判断の直前に内部的に自己 check する。違反検出時は即時 STOP + アクション。

## Check 1: ファイル境界

**検出**:
```bash
# 現在の変更ファイルが editable (new ∪ modify) の部分集合か
git status --short | awk '{print $2}' > /tmp/touched.txt
jq -r --arg id "T-X-Y" '.tasks[] | select(.id==$id) | (.files_changed_predicted.new + .files_changed_predicted.modify)[]' \
  07_tasks/tickets.json > /tmp/allowed.txt
comm -23 <(sort /tmp/touched.txt) <(sort /tmp/allowed.txt)
# → 1 行でも出力されたら違反
```

**アクション**: STOP → tickets.json で当該 task の `files_changed_predicted.modify` または
`new` を expand する別 PR を先行する。

## Check 2: selected-stack

**検出**: 採用しようとしている技術 (pip, ESLint config, など) が
`03_architecture/selected-stack.json` の各 selection に対応するか目視確認。

```bash
jq '.selections | to_entries[] | "\(.key): \(.value.chosen)"' 03_architecture/selected-stack.json
```

**アクション**: 確定済と異なる技術を選ぶなら STOP → selected-stack を更新する別 PR を
先行する (architecture-design スキルで)。

## Check 3: AC threshold

**検出**: 以下の表現を含む変更を検出
- `--cov-fail-under=` の値を下げる
- `thresholds: { lines: 80 }` → `0` に下げる
- `typeCheckingMode = "strict"` → `"standard"` に下げる
- 「Phase 0 だから 0% でいい」「placeholder だから後で」と判断

**アクション**: STOP → 数字を下げるのではなく、テスト追加 / 実装整備 / exclude 追加で対処。
exclude を選ぶ場合は理由を tickets.json か commit message に明示。

## Check 4: placeholder 逃避

**検出**:
```bash
grep -rE "(echo 'placeholder'|raise NotImplementedError|TODO|FIXME|// PLACEHOLDER)" \
  --include="*.py" --include="*.ts" --include="*.tsx" \
  $(git diff --name-only origin/main..HEAD)
```

**アクション**: STOP → 該当箇所が**仕様 (AC)** で要求されているなら実装を完成させる。
要求されていない (本当に後続 task のスコープ) なら `_TRACK:` 接頭辞で gap tracker に登録。

## Check 5: CI soft-pass

**検出**: `.github/workflows/*.yml` で以下のパターン
- `::notice::pending T-F-XX`
- `|| true` で gate を吞んでいる
- `if [ -x "..." ]; then ... else echo notice; fi`

**アクション**: STOP → soft-pass 部分を実体実装に書き直す。依存タスク未完了で
真の実装ができないなら、依存 task の完了を待ち、その PR で gate を有効化する。

## Check 6: 仕様独自解釈

**検出**: 仕様の文言を「実用上」「現実的に」と独自解釈して妥協していないか
- pyright strict → "strict + 一部 suppress" と勝手解釈
- 80% → "phase 0 では 0% でも実質 80%" と勝手解釈
- 100% → "代表 path だけ 100% でいい" と勝手解釈

**アクション**: STOP → 仕様文言通りに実装する。文言が現実に合わないなら
tickets.json または selected-stack を更新する別 PR を出してから戻る。

## 全 chant-check の運用

毎タスクの各 commit 前にこれらを内部実行。1 件でも違反したら commit せず STOP。
将来は v3-gate.yml に Gate #11 (PR scope guard) として組み込み、CI で自動検出する。
