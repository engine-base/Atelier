# Chrome Driving Recipes

Claude in Chrome MCP（`mcp__Claude_in_Chrome__*`）を使ってブラウザを操作するレシピ集。
「ヒトのフリ」をするための定型パターン。

## 起動と接続

1. 接続中ブラウザ確認: `list_connected_browsers`
2. 必要なら `select_browser` で対象を選ぶ
3. `resize_window` でビューポート固定（再現性のため。例: 1440x900）

## 基本操作

| 目的 | 道具 |
|---|---|
| URL を開く | `navigate` |
| クリック | `find` でセレクタ取得 → `computer` でクリック、または `javascript_tool` で DOM API |
| 入力 | `form_input` |
| ファイル添付 | `file_upload` |
| スクショ | `computer.screenshot` |
| DOM 読む | `read_page` / `get_page_text` |
| console 読む | `read_console_messages` |
| network 読む | `read_network_requests` |
| バッチ実行 | `browser_batch`（複数操作を 1 コール） |

## スクショの命名

```
screenshots/<feature>/<TC-id>-<step-no>-<what>.jpg
例: screenshots/F-01/TC-01-03-after-submit.jpg
```

各ステップ完了でスクショ。FAIL 時は

- ステップ N: 期待 UI 画面
- ステップ N + 1: 直後の DOM 全体
- console 全文を `console.txt` に保存
- network 全文を `network.json` に保存

## よく使う JS スニペット

`javascript_tool` で実行する典型コード:

```js
// 全リンクの URL を列挙
[...document.querySelectorAll('a[href]')].map(a => a.href)

// inline validation メッセージ取得
[...document.querySelectorAll('[aria-invalid="true"]')].map(el => ({
  name: el.getAttribute('name'),
  msg: el.parentElement?.querySelector('[role="alert"], .error, [class*="error"]')?.textContent?.trim()
}))

// localStorage / sessionStorage 検査
Object.fromEntries(Object.entries(localStorage))

// ネットワーク確認用に最近の fetch を上書き（テスト先頭で入れる）
window.__net = []
const _f = window.fetch
window.fetch = (...a) => {
  const start = performance.now()
  return _f(...a).then(r => {
    window.__net.push({ url: a[0], status: r.status, ms: performance.now() - start })
    return r
  })
}

// 状態スナップショット
JSON.stringify({
  url: location.href,
  title: document.title,
  storage: Object.fromEntries(Object.entries(localStorage)),
})
```

## 認証の通し方

### 普通のメール / パスワード

`form_input` で入力、`computer.click` でログイン押下。
`read_network_requests` で `POST /api/auth/login` の 200 を確認。
`read_console_messages` でエラーが無いことを確認。

### Admin / 開発者バイパス

プロジェクトに開発者バイパスがある場合（例: `localStorage.moonshot_api_token` に test token）:

```js
localStorage.setItem('moonshot_api_token', '<TEST_TOKEN>')
```

事前にユーザに「テストアカウントを使うのは OK?」を確認。
本番 token をハードコードしない。`.env.local` から読む。

### OAuth / SSO

実 OAuth フローは外部依存が大きいので:

- 開発時は stub provider を使う（プロジェクトが用意していれば）
- なければ事前に 1 回ヒトに OAuth を通してもらい cookie を保持
- それでも難しい場合は **ヒトに依頼** に回す

### Cookie / Bearer 注入

`javascript_tool` で document.cookie に直接書く or `localStorage` に set。
ただし HttpOnly cookie は JS から触れないので、API 直接呼んで受け取った Set-Cookie を Chrome 起動時に流し込む。

## 自動 OK ダイアログ

ブラウザの `confirm()` / `alert()` で止まりたくない時:

```js
window.confirm = () => true
window.alert = () => {}
```

ただし「実装が期待する挙動」を変えないように、テストの目的が「警告 UI」自体なら使わない。

## 操作の冪等化

同じテストを 2 回回せるようにする:

- 作成テストの最後に teardown（削除）を入れる
- もしくは固定の seed データを使い、編集テストは編集前後の状態を assert する
- DB に直接 insert / delete してリセットしてよいが、計画書にその旨を明記

## アサーションの粒度

- テキスト一致は **ユーザに見えるラベル** で（i18n キーや HTML 構造で見ない）
- セレクタは `data-testid` 優先、なければ visible text、最後の手段で xpath
- 「画面遷移したか」は URL の正規表現で

## 安全策

- スクショに **token / 個人情報 / 決済情報** が映ったら撮影前にスクロールアウト or マスク
- パスワード入力フィールドの値は記録しない
- 録画する場合は password / token を `***` でマスク
