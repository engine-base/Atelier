# S-E01 escalation 運用フロー

CI gate 3 連続 fail / 致命級タスク / 仕様変更要請 で発動する人間 review フロー。

## 自動起票条件

1. **CI gate fail × 3**: `auto-merge.yml` の `retry-on-fail` job で
   `attempts >= 4` なら GitHub Issue 自動起票
2. **致命級タスク**: tickets.json の `blocking: true` + `R-T08` 系
   は AI 単独 merge 禁止、PR open 時点で escalation
3. **仕様変更要請**: 実装中に selected-stack や AC を変える必要が出たら
   実装側から escalation Issue を手動起票

## Issue 形式

タイトル: `[S-E01] <理由> — PR #N`

本文:
```markdown
# S-E01 Human Escalation

## Context
- PR: #N
- HEAD SHA: `<sha>`
- Trigger: <CI fail 3x / blocking task / spec change request>
- Workflow run: <url>

## CLAUDE.md ルール
> CI gate 失敗 → auto retry 最大 3 回 (10s/30s/60s)
> 3 連続失敗 → S-E01 チャットに human-escalation 通知
> blocking task の場合: 経営者承認待ち (0.5h)

## 次のアクション
1. 失敗ログを確認 → 構造的問題か一時的問題か判断
2. 構造的問題: tickets.json 更新 PR を起票
3. 一時的問題: PR を rerun
4. blocking task: 経営者承認後に手動 merge
```

ラベル: `escalation,blocking,human-required`

## PR comment

Issue 起票と同時に対象 PR にコメント:
> 🚨 **S-E01 escalation**: <reason>. Created tracking issue. Human approval required to proceed.

## 致命級タスクの一覧 (Atelier の場合)

| Task | 内容 | 承認時間 |
|---|---|---|
| T-D-22 | R-T08 RLS 設計レビュー | 3h |
| T-A-45 | API 契約凍結 | 2h |
| T-I-24 | 本番 go/no-go | 2h |

これらは AI が PR を open しても `auto-merge` を bypass し、人間 approve まで待機。

## 解決プロトコル

1. 人間が Issue を確認
2. ログから原因分類:
   - 構造的問題 (selected-stack / AC / 設計の見直し必要) → tickets.json 更新 PR
   - 一時的問題 (flaky test / 環境問題) → PR rerun
   - 致命級 → 経営者署名後に手動 merge
3. 解決後、Issue を close + PR comment で報告
