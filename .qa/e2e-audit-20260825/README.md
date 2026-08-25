# 画面別 e2e 37 本を実際に走らせて測った（2026-08-25）

## 何を測ったか

「`/e2e/` の画面別 spec が CI で走っていない」と報告したので、**実際に走らせて
何本落ちるか**を測った。推測で「たぶん壊れている」と言い続けないため。

## 分かったこと ①：CI どころか、そもそも収集されていなかった

`e2e/playwright.config.ts` は `testDir: './tests'` を指している。一方、画面別の
spec 37 本は `/e2e/` の**直下**にある。

```
$ cd e2e && npx playwright test --list
Total: 41 tests in 2 files      ← tests/a11y.spec.ts と tests/smoke.spec.ts だけ
```

つまり 37 本は **CI で走っていない**のではなく、**ワークスペース自身の
`pnpm test` でも収集されない**。置いてあるだけのファイルだった。

## 分かったこと ②：走らせると 34/37 が落ちる。が、原因は認証だった

`testDir` だけ差し替えて走らせた（`orphan.config.ts`）:

| | 結果 |
|---|---|
| 認証なし | **34 failed / 3 passed** |
| 認証あり（e2e-seed の QA ユーザーで cookie 注入） | **23 failed / 14 passed** |

37 本のうち auth ヘルパーを使っているのは **1 本だけ**。残りは cookie 無しで
保護ページへ行き、middleware に `/signin` へ飛ばされていた。

```
$ curl -o /dev/null -w "%{http_code} -> %{redirect_url}" .../projects
307 -> /signin?redirect=%2Fprojects
```

## 分かったこと ③：残る 23 本も、**製品は無事**だった

「spec が古いのか / 画面が壊れているのか」を分けるため、**実ブラウザで 19 画面を
1 枚ずつ開いて中身を見た**（`inspect.mjs` + `shots/`）。

**19 画面すべて正常に描画されていた。**

| spec が期待 | 実際 | 何が起きているか |
|---|---|---|
| `/projects/s_b01` の見出し「プロジェクト一覧」 | `/projects` に 308、見出しは「プロジェクト」 | **旧内部 URL と旧文言**。意味的 URL へ移行済み |
| `/client/s_l01` | `/portal/invitations` | 画面がリネームされた |
| `/public/s_pub04` | `/data-deletion` | 同上 |
| `/auth/s_a01` の heading「サインイン」 | 見出しは「Atelier へようこそ」、"サインイン" は**タブ** | 役割が heading → tab に変わった |
| `/admin/s_t01` の「運営ダッシュボード」 | 「運営 admin 専用です」の alert | **製品が正しく権限を弾いている**。spec が admin 前提だった |
| 各画面の見出し | 「〜を選択すると表示します」 | **正しい空状態**。spec がプロジェクト未選択を想定していない |

つまり **23 本の失敗はすべて spec が古いことによるもので、製品の不具合は 0 件**。

### 私の自動判定も 1 件間違えた（正直に）

`s_a01` を「本文が 101 文字しかない」という理由で ★要調査 と出した。
スクリーンショットを見たら**完全に正常なサインイン画面**だった。
しきい値（120 文字）が厳しすぎただけ。**自動判定を鵜呑みにせず画面を見て良かった**。

## 結論

- **今 CI に載せるのは無駄**。載せる前に 37 本を現行 URL・現行文言に直す作業が要り、
  それは「壊れていないものを直す」作業になる
- **測ったことに意味はあった**: 「壊れているかもしれない 37 本」が
  「製品は無事・spec が古いだけの 23 本」に変わった。もう不明点ではない
- backlog の該当行に、この測定結果を反映した

## 再現

```bash
# 前提: web :3100 (本番ビルド) / API :8123 / Postgres :54322 + scripts/ci/e2e-seed.sql
cd e2e && npx playwright test --config=../.qa/e2e-audit-20260825/orphan.config.ts       # 認証なし
cd e2e && npx playwright test --config=../.qa/e2e-audit-20260825/orphan-auth.config.ts  # 認証あり
cd apps/web && node ../../.qa/e2e-audit-20260825/inspect.mjs                            # 実ブラウザで 1 枚ずつ
```
