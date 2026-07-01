# クリーン環境 / 0状態 / 初期構築（seed済みDBでは検出不能・必須軸）

> 実行は実DB(空DB)が必要。本環境は PG 無しのため **BLOCKED**（planned）。検証すべき項目を定義。

| # | 観点 | テスト項目 | 操作手順 | 期待結果 | 結果 | 備考 |
|---|---|---|---|---|---|---|
| Z-001 | H1 空DB起動 | 全テーブル0件でアプリ主要画面/APIを開く | 1. 全TRUNCATE 2. 各画面を開く | 空状態UI/200/適切な4xx。500/undefined参照にならない | | BLOCKED(実DB) |
| Z-002 | H2 空での認証拒否 | データ0件で各ログイン試行 | 1. users0件でsignin | 例外でなく401で拒否 | | BLOCKED |
| Z-003 | H3 初回ブートストラップ | 最初のユーザ作成→ログイン成立 | 1. signup(auth.users+public.users二重要件) 2. signin | atelier_access cookie発行→保護画面到達 | | BLOCKED |
| Z-004 | H4 初回データ投入貫通 | WS作成→project→task を実導線で作成 | 1. 各作成フローをUIで実行 | 別GET/一覧/DBの3箇所に反映 | | BLOCKED |
| Z-005 | H5 0→ログイン貫通 | 招待→client_portal でサインイン | 1. 招待発行→token でS-L02サインイン | client_access cookie→S-L03到達 | | BLOCKED |
| Z-006 | seed健全性 | 全TRUNCATE→migration→(seed)→素にログイン | 1. supabase db reset相当 | 必須列(PW等)欠落なくログイン成立 | | BLOCKED |

解除条件: Docker起動→`supabase start`→`supabase db reset`(migration適用)→web+API起動→Chrome MCPで貫通。
