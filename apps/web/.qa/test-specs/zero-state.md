# クリーン環境 / 0状態 / 初期構築（seed済みDBでは検出不能・必須軸）

> 実行は実DB(空DB)が必要。本環境は PG 無しのため **BLOCKED**（planned）。検証すべき項目を定義。

| # | 観点 | テスト項目 | 操作手順 | 期待結果 | 結果 | 備考 | タスク | 実行条件 |
|---|---|---|---|---|---|---|---|---|
| Z-001 | H1 空DB起動 | 全テーブル0件でアプリ主要画面/APIを開く | 1. 全TRUNCATE 2. 各画面を開く | 空状態UI/200/適切な4xx。500/undefined参照にならない | | BLOCKED(実DB) | T-D-28 | L1 |
| Z-002 | H2 空での認証拒否 | データ0件で各ログイン試行 | 1. users0件でsignin | 例外でなく401で拒否 | | BLOCKED | T-A-02 | L1 |
| Z-003 | H3 初回ブートストラップ | 最初のユーザ作成→ログイン成立 | 1. signup(auth.users+public.users二重要件) 2. signin | atelier_access cookie発行→保護画面到達 | | BLOCKED | T-I-01 | L1 |
| Z-004 | H4 初回データ投入貫通 | WS作成→project→task を実導線で作成 | 1. 各作成フローをUIで実行 | 別GET/一覧/DBの3箇所に反映 | | BLOCKED | T-I-02 | L1 |
| Z-005 | H5 0→ログイン貫通 | 招待→client_portal でサインイン | 1. 招待発行→token でS-L02サインイン | client_access cookie→S-L03到達 | | BLOCKED | T-I-07 | L1 |
| Z-006 | seed健全性 | 全TRUNCATE→migration→(seed)→素にログイン | 1. supabase db reset相当 | 必須列(PW等)欠落なくログイン成立 | | BLOCKED | T-D-24 | L1 |
| Z-007 | seed健全性 / G-11 | 開発機の DB と CI の DB の差 (テストが前提にする状態) | 1. 空DBに pg-bootstrap → apply-migrations.sh → apply-seeds.sh 2. その DB で API テストを流す | テストの期待値が **migration+seed をゼロから適用した状態**と一致する。開発機にだけ残っている古い行 (法務文書の旧版など) の件数に依存した期待値を書かない | PASS (2026-09-04 実測 — CI 同等 DB を作り直して確認) | CI (Gate #4/#14) だけで落ちるテストは、ほぼこの型 | T-D-24 | L1 |
| Z-008 | 初期構築 / G-13 | workspace を作った直後に AI 社員が居ること | 1. public.workspaces に 1 行 insert 2. その workspace の ai_employees を数える | 運営テンプレ (ai_employee_templates.is_active) と同数の社員が自動で入る (t-d-99 bootstrap トリガ)。**「社員 0 人」を前提にした固定名の insert は必ず一意制約で落ちる** | PASS (2026-09-04 実測 — 10 名) | 実装・テストとも「既にいる方を使う」を既定にする | T-D-24 | L1 |
| Z-009 | seed健全性 / G-15 | PG が要るテストが「無いから skip」で緑になっていないこと | 1. CI と同じ env (`ATELIER_TEST_PG_URL`) で `pytest tests -q -rs` 2. skip の理由を読む | 「Postgres not available」の skip が 0 件。**skip は緑ではない** — 接続先を決め打ちして繋がっていないだけで、その範囲は一度も検査されていない | PASS (2026-09-04 実測 — 決め打ちだった 5 ファイル 61 件が skip から実行に変わり全 PASS) | Gate #14 の skip ガードが見ているのはこれ | T-D-24 | L1 |

解除条件: Docker起動→`supabase start`→`supabase db reset`(migration適用)→web+API起動→Chrome MCPで貫通。
