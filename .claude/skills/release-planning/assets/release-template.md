# リリース計画書 - {{PROJECT_NAME}} v{{VERSION}}

## リリース概要

| 項目 | 内容 |
|------|------|
| バージョン | v{{VERSION}} |
| リリース日時 | {{RELEASE_DATE}} |
| リリース担当 | {{RELEASE_OWNER}} |
| 承認者 | {{APPROVER}} |
| 監視担当 | {{MONITOR_OWNER}} |
| メンテナンス停止 | {{MAINTENANCE_WINDOW}} |

---

## 変更内容サマリー

{{CHANGE_SUMMARY}}

---

## リリース前チェックリスト

### 機能確認
{{FEATURE_CHECKLIST}}

### 品質確認
{{QUALITY_CHECKLIST}}

### インフラ確認
{{INFRA_CHECKLIST}}

---

## 本番デプロイ手順

{{DEPLOY_STEPS}}

---

## ロールバック手順

### ロールバック判断基準
{{ROLLBACK_CRITERIA}}

### ロールバック手順
{{ROLLBACK_STEPS}}

---

## リリース後監視

| 項目 | 設定値 |
|------|--------|
| 監視期間 | {{MONITOR_DURATION}} |
| エラーレート閾値 | {{ERROR_RATE_THRESHOLD}} |
| レスポンスタイム閾値 | {{RESPONSE_TIME_THRESHOLD}} |
| アラート通知先 | {{ALERT_DESTINATION}} |
| エスカレーション先 | {{ESCALATION_CONTACT}} |

---

## CHANGELOG

{{CHANGELOG}}

---

*作成日: {{CREATED_DATE}} / 作成者: {{RELEASE_OWNER}}*
