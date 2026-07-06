# TUC39 プロジェクト切替 画面別テスト仕様（T-UC-39・human-grade-qa test-plan）

> 種別: list / 結果列は空=planned（実機実行は環境要因で BLOCKED）。

| ID | 画面 | テスト観点 | テスト項目 | 前提条件 | 操作手順 | 期待結果 | 結果 | 備考 |
|---|---|---|---|---|---|---|---|---|
| TUC39-001 | プロジェクト切替 | 画面表示 | 画面が正常表示（全 UI 要素・モック準拠） | - | 1. プロジェクト切替 を開く | モックの全要素（見出し/ボタン/一覧/フォーム）が表示される | PASS |  |
| TUC39-002 | プロジェクト切替 | 視覚忠実度 | 配色/角丸/タイポが design token 準拠 | - | 1. 画面を目視 | --color-* / --rounded-* / --text-* トークンで描画（ハードコード色なし） | | 段1: token値=DESIGN-atelier.md 一致(済) |
| TUC39-003 | プロジェクト切替 | データ取得 | loading skeleton 表示（現在WS内プロジェクト） | 取得未完 | 1. プロジェクト切替 を開き取得完了前を観察 | <Loading>（role=status/aria-live）が出る | |  |
| TUC39-004 | プロジェクト切替 | 空データ | 0 件時の空状態（現在WS内プロジェクト） | GET /projects?workspace_id が空配列 | 1. データ0件で開く | 空状態メッセージを表示（500/undefined 参照にならない） | | セクションH |
| TUC39-005 | プロジェクト切替 | エラー | 取得失敗の inline error + toast（現在WS内プロジェクト） | GET /projects?workspace_id が 5xx | 1. API を 500 でモックし開く | role=alert の inline error 表示 かつ toast 発火 | | UNWANTED critical |
| TUC39-006 | プロジェクト切替 | 権限 | 403 拒否表示（現在WS内プロジェクト） | 権限なしユーザ | 1. 権限なしで プロジェクト切替 を開く | 「権限がありません」等の拒否表示（他人のデータは出さない=RLS） | | セクションG 越境 |
| TUC39-007 | プロジェクト切替 | インタラクション | 「Project picker」を操作すると動作する（死にボタン検査） | - | 1. 「Project picker」を選択 | localStorage(atelier_current_project) 永続化（onClick/href/API が実在し、押すと副作用が起きる） | | 死にボタン |
| TUC39-008 | プロジェクト切替 | a11y | axe scan で 0 critical/serious | - | 1. axe を実行 | critical/serious 違反 0（semantic role/aria） | PASS | vitest-axe 実測済(該当時) |
| TUC39-009 | プロジェクト切替 | レスポンシブ | 320/768/1024/1440 で崩れない | - | 1. 各幅で開く | 横スクロール/はみ出し/縦折れが無い | PASS | Playwright responsive.e2e 26画面×4幅 実走 第8軸 |
| TUC39-010 | プロジェクト切替 | 状態永続 | F5 リロードでログアウトに飛ばない | ログイン済 | 1. 画面で F5 | 保護ガードで維持・状態復元（URL クエリ等） | | セクションG G4 |
| TUC39-011 | プロジェクト切替 | 到達性 | ナビ/リンクからUIで到達でき遷移先が正しい | - | 1. 導線から本画面へ到達→主要リンクを辿る | 死リンク無し・遷移先が正しい文脈(param)で開く | PASS | I4-S（全体で死リンク0確認済） |
