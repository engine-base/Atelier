# Atelier — AI / 新セッション向け作業ルール

> このファイルは Claude Code が自動で読み込みます。
> 新セッションは [`README.md`](./README.md) → このファイル → tickets.json の順で読む。

## 🎯 あなたの役割

あなたは **Atelier 開発を支援するエンジニア AI** です。
プロジェクトは **計画フェーズ完了済（12 スキル全完走）** で、これから実装フェーズに入ります。

## 🛑 絶対ルール

1. **信頼源は `07_tasks/tickets.json` のみ**。他ファイルとの不整合があれば tickets.json を正とする。
2. **静的な CLAUDE.md / audit MD を Git に commit しない**。JIT 方式（`09_dispatch/scripts/dispatch.sh`）で実行時生成する。
3. **`./09_dispatch/scripts/validate.sh` が PASS している状態を維持**する。1 件でも fail なら実装着手不可。
4. **タスクは 1 ブランチ = 1 タスク**。複数タスクをまとめてはいけない。
5. **「良い感じに改善」「ついでにリファクタ」禁止**。CLAUDE.md の files_changed_predicted に書かれた範囲のみ触る。
6. **AI 学習デフォルト OFF** を維持。顧客データを学習に使う実装を入れない。
7. **R-T08（クライアント別 JWT 完全分離）**は致命級。RLS は越境試験 PASS を必須にする。

## 🚀 タスク着手の標準フロー

```bash
# 1. validate（毎回）
./09_dispatch/scripts/validate.sh

# 2. やるタスクを決める（schedule.json の wave/start_date 順）
jq -r '.tasks[] | select(.wave==0) | .id + " " + .title' 07_tasks/tickets.json

# 3. JIT 生成して内容確認
./09_dispatch/scripts/dispatch.sh --preview T-F-01 | less

# 4. 実装開始
./09_dispatch/scripts/dispatch.sh T-F-01
# → 案内に従って branch 作成 → CLAUDE.md をルートに配置 → 進めて

# 5. 実装中
#    - files_changed_predicted の new / modify のみ触る
#    - shared_read は読むだけ、編集禁止
#    - forbidden は絶対に触らない（他タスク専有）

# 6. 3-tier AC 全 PASS を確認
#    - Tier 1 structural: mock / spec / OpenAPI と一致
#    - Tier 2 functional: EARS 5 形式（UNWANTED 句は access policy）
#    - Tier 3 regression: CI gate 10 種 PASS

# 7. push
git push -u origin <branch>
# → PR auto-create → 10 gate PASS → auto-merge

# 8. 一時 CLAUDE.md を削除
rm CLAUDE.md  # ルートに置いた一時ファイルのみ
```

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
