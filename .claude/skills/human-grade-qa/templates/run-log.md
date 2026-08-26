# Run Log: <feature-name>

- Run ID: YYYY-MM-DD-HHmm-<feature>
- 計画書: `plans/.../<feature-spec>.md`
- 実行者: Claude (human-grade-qa skill)
- 環境: dev (localhost:5173) / Chrome MCP / Postgres dev
- 開始: <ISO>
- 終了: <ISO>

## サマリ

| カテゴリ | 計画 | PASS | FAIL | SKIP |
|---|---|---|---|---|
| 正常系 | 3 | 3 | 0 | 0 |
| 異常系 | 4 | 3 | 1 | 0 |
| バリデーション | 12 | 12 | 0 | 0 |
| 境界 | 5 | 4 | 0 | 1 |
| 権限 | 4 | 4 | 0 | 0 |
| 状態復帰 | 3 | 2 | 1 | 0 |
| **合計** | **31** | **28** | **2** | **1** |

PASS 率: 90.3%

## 個別ログ

### ✅ TC-XX-01 正常ログイン

- 開始: HH:MM:SS
- 操作:
  1. `/login` 開く → スクショ `screenshots/login-01-open.jpg`
  2. メール入力 → ...
  3. ログイン押下 → 200 ms 後 `/` へリダイレクト
- DB: `auth_security_events` に 1 行追記確認 (`select count(*)... where event_type='login_success'`)
- 終了: HH:MM:SS
- 結果: **PASS**

### ❌ TC-XX-07 セッション切れ後の API 呼び出し

- 開始: HH:MM:SS
- 期待: 401 → ログイン画面リダイレクト
- 実際: 500 サーバエラー + 白画面
- スクショ: `screenshots/auth-07-fail.jpg`
- 再現手順:
  1. ログイン
  2. DevTools → Application → Cookies で `session` を削除
  3. リロードせず、内部 API を叩くボタン（"保存"）を押す
  4. 500 が返る
- 仮説: 401 を catch せず例外で落ちている（`src/api/foo.ts:42`）
- 重要度: P1
- 結果: **FAIL** → `../failures.md` に追記

### ⏸ TC-XX-12 Unicode 4 バイト絵文字（境界）

- 結果: **SKIP**
- 理由: 入力欄が disabled に。前提条件不足。後段で実施。

## 証跡

- スクリーンショット: `screenshots/<feature>/*.jpg`
- DB ダンプ: `artifacts/<feature>/db-state.sql`
- ネットワーク HAR: `artifacts/<feature>/net.har`
- console log: `artifacts/<feature>/console.txt`

## 所感（次回への改善）

- フィクスチャ準備が手作業 → スクリプト化したい
- セッション切れ系の再現が手間 → ヘルパー関数化
