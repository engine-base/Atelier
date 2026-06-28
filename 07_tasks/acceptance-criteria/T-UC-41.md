# T-UC-41 — 受入基準

プロジェクト・クレデンシャルシークレット。詳細設計は [docs/project-vault-design.md](../../docs/project-vault-design.md)。

## Tier 1 構造
- project_credentials を docs/project-vault-design.md 通りに実装する。
- 平文は DB に保存せず、API 応答にも含めない（reveal を除く）。

## Tier 2 機能
- メンバーが登録 → Fernet 暗号化して暗号文のみ保存。
- 一覧 → name/kind/last4 のみ返す（値マスク）。
- 越境（別 workspace）→ 403 / RLS で 0 rows（致命: 越境=0）。
- 未認証 → 401。
- store/update/delete/reveal すべて audit_logs に記録。
- シークレットデータを AI 学習に使わない（絶対ルール #6）。

## Tier 3 回帰
- CI 10 gate すべて PASS（特に Gate #10 RLS isolation matrix）。
