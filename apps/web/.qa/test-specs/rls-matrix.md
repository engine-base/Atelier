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
- 全て **実PGでの越境試験 PASS 必須**。

## 実PG での越境試験 結果（2026-08-27 更新）

**本環境には実 Postgres があり、RLS 越境試験は BLOCKED ではなく実行済み。**
`apps/api/tests/rls/` の越境試験群が実 PG に対し PASS:

- `test_blanket_deny.py` — client_invitations の permissive/restrictive 同居検査 + 自表参照ポリシー 0 件（GAP-224/229）
- `t-i-05〜08.py` — テーブル×ロールの越境不可マトリクス
- `t-d-36_vault.py` — Vault 列 revoke
- **合計 12 passed**（`pytest tests/rls/`）

通し検証でも直接実測した越境（いずれも他テナントから遮断）:
- **audit_logs**: 別テナント j52 は自分の行のみ・他 WS の行 0 件・非 admin の /admin/audit-logs は 403（J61-02）
- **client_invitations**: 画面経路の件数 = service 経路の DB 件数（service では見えるのに画面 0 件、が起きない・SL01-051）
- **output_design_templates**: 別テナントが他 WS の design-templates/versions を叩くと 404（TEMPLATES-012）+ 上書き済み WS は運営既定改訂で書き換わらない（ST07-016/018）
- **workspace_memberships**: 自表参照ポリシーの再帰を is_workspace_owner() で解消（GAP-229）、招待 INSERT は owner のみ・非 owner の自己昇格は RLS 拒否
- **client_portal JWT**: 招待失効が毎リクエストで効く（assert_invitation_active・GAP-227、J24-02）

★致命級（client_portal/platform）は実 PG で PASS 済。**残る対象外は Supabase staging での本番同等 RLS 確認**（ローカル PG と本番 Supabase のロール設定差の最終確認）。
