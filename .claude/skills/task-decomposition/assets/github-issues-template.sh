#!/bin/bash
# GitHub CLI を使ったタスクカード一括作成スクリプト
# 使用前に: gh auth login でGitHubにログインしておく
# 実行: bash github-issues-template.sh [リポジトリ名] [マイルストーン名]

REPO="${1:-owner/repo}"
MILESTONE="${2:-Phase 1}"

echo "Creating issues in $REPO for milestone: $MILESTONE"

# タスクカード作成関数
create_issue() {
  local title="$1"
  local body="$2"
  local labels="$3"
  local milestone="$4"

  gh issue create \
    --repo "$REPO" \
    --title "$title" \
    --body "$body" \
    --label "$labels" \
    --milestone "$milestone"

  echo "Created: $title"
  sleep 0.5  # Rate limiting
}

# ===== タスクカードをここに追加 =====
# 以下のフォーマットでタスクを追加してください

create_issue \
  "[TASK-001] 認証API実装 - ログインエンドポイント" \
  "## タスク概要
POST /auth/login エンドポイントの実装

## 入力
- 前タスク成果物: なし（DBスキーマ確定後着手可能）
- 参照ファイル: \`src/types/auth.ts\`, \`prisma/schema.prisma\`

## 実装内容
- [ ] メール/パスワードのバリデーション
- [ ] BCryptでのパスワード検証
- [ ] JWTトークン生成・返却
- [ ] エラーレスポンス（401, 422）

## Done Criteria
- [ ] \`POST /auth/login\` が200を返す
- [ ] 不正パスワードで401が返る
- [ ] ユニットテストが通る（カバレッジ80%+）

## やってはいけないこと
- パスワードを平文で保存・ログ出力しない
- このタスクにサインアップ機能を含めない

## 工数目安
4時間" \
  "task,auth,phase-1" \
  "$MILESTONE"

# ===== ここにタスクを追加し続ける =====

echo "Done! Check issues at: https://github.com/$REPO/issues"
