# RLS 権限マトリクス（R-T08 越境不可の検証項目）

> 各テーブル × ロール × 操作。★致命級=client_portal/platform は経営者レビュー＋実PG検証必須。
> 実行は実DBが必要（本環境では BLOCKED）。ここでは検証すべき期待挙動を定義する。

| # | テーブル | 期待ポリシー | owner | member | viewer | client_portal | admin | anon |
|---|---|---|---|---|---|---|---|---|
| 1 | workspaces | 所属メンバーのみ select/update、owner が管理 | CRUD | R/一部W | R | ×(越境403) | — | ×(401) |
| 2 | workspace_memberships | 本人/同WSメンバー可視、owner がロール変更 | CRUD | R/一部W | R | ×(越境403) | — | ×(401) |
| 3 | projects | 所属WSのメンバーのみ CRUD | CRUD | CRUD | R | 自projectのみ | — | ×(401) |
| 4 | tasks | 所属プロジェクトのメンバーのみ | CRUD | CRUD | R | ×(越境403) | — | ×(401) |
| 5 | phases | 所属プロジェクト内 | CRUD | CRUD | R | ×(越境403) | — | ×(401) |
| 6 | external_uploads(meetings) | 所属プロジェクト内。書込は uploader | CRUD | CRUD | R | ×(越境403) | — | ×(401) |
| 7 | mocks | 所属プロジェクト内 | CRUD | CRUD | R | ×(越境403) | — | ×(401) |
| 8 | workflow_outputs | 所属プロジェクト内 | CRUD | CRUD | R | 自projectのみ | — | ×(401) |
| 9 | comments | 対象リソースの可視範囲に従属 | CRUD | CRUD | R | 自projectのみ | — | ×(401) |
| 10 | client_invitations | 所属WSメンバーが CRUD / client 本人経路は token_hash | CRUD | CRUD | R | 自projectのみ | — | ×(401) |
| 11 | ai_employees | 所属WS。10体固定、display_name/tone のみ更新 | CRUD | CRUD | R | ×(越境403) | — | ×(401) |
| 12 | knowledge_nodes | account スコープ(project/workspace/platform)。platform 書込は service_role のみ | CRUD | CRUD | R | ×(越境403) | bypass | ×(401) |
| 13 | users | 本人のみ（/me GET/PATCH） | CRUD | CRUD | R | ×(越境403) | — | ×(401) |
| 14 | cron_schedules | 所属プロジェクト内 | CRUD | CRUD | R | ×(越境403) | — | ×(401) |
| 15 | approvals | 本人(user_id=auth.uid)のみ | CRUD | CRUD | R | ×(越境403) | — | ×(401) |
| 16 | account_ai_learning | 本人のみ（AI学習 opt-out） | CRUD | CRUD | R | ×(越境403) | — | ×(401) |

## 重点越境試験（★必須）
- R-T08: client_portal JWT で他 project の GET /client/projects/{id} → **403 cross_project**（S-L03）。
- 検索 GET /search・通知 GET /approval-inbox は RLS 内のみヒット（越境自動除外）。
- platform knowledge は service_role のみ書込（一般 authenticated は read）。
- 全て **実PGでの越境試験 PASS 必須**。本環境は PG 無しのため **BLOCKED**（解除条件: supabase start / staging）。
