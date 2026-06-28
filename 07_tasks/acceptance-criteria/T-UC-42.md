# T-UC-42 — 受入基準

運営UI配線：S-T02 スキル管理(upload/edit/新規) + S-T06 運営デフォルトナレッジ管理

## Tier 1 構造
- UBIQUITOUS: S-T02 は SKILL.md upload/編集/新規登録/装着 を、S-T06 は platform ナレッジ CRUD/visible_in_tree トグル をモック通りに提供する
- UBIQUITOUS: 両画面とも admin(運営)のみ到達可能

## Tier 2 機能
- [EVENT-DRIVEN] When an admin saves a skill on S-T02, the system shall call the skills API and reflect the result on a fresh GET
- [EVENT-DRIVEN] When an admin creates platform knowledge on S-T06, the system shall call POST /knowledge with account_type=platform
- [UNWANTED] If a non-admin opens S-T02/S-T06, the system shall redirect/deny (admin gate) （致命）

## Tier 3 回帰
- 既存 admin 画面(S-T01/03/04/05)と AppShell ナビが従来どおり動作する

## 関連

- 画面: S-T02, S-T06 / エンティティ: E-009, E-018 / 機能: F-007, F-023
- CI 13 gate すべて PASS を完了条件とする。
