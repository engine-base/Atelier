# T-UC-43 — 受入基準

ナレッジUI配線：S-K01 3層ツリー(project層) + 構造ツリー + パネル開閉

## Tier 1 構造
- UBIQUITOUS: S-K01 は 共通/AI社員別/プロジェクト別 の3層ツリー + parent_id 階層 + 左右パネル開閉 をモック通りに提供する
- UBIQUITOUS: 運営デフォルト(platform)はツリーに表示せず参照のみ

## Tier 2 機能
- [EVENT-DRIVEN] When a node with children is expanded, the system shall fetch children via parent_id
- [EVENT-DRIVEN] When a member adds knowledge, the system shall call POST /knowledge and reflect on a fresh GET
- [UNWANTED] If the user is not a workspace member, the system shall not display other tenants' knowledge (RLS 越境=0) （致命）

## Tier 3 回帰
- 既存のナレッジ検索/ノート表示が従来どおり動作する
- パネル開閉が左右独立で中央が拡張する(回帰)

## 関連

- 画面: S-K01 / エンティティ: E-018 / 機能: F-023, F-024
- CI 13 gate すべて PASS を完了条件とする。
