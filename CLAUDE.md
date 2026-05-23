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
