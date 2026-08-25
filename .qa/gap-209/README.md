# GAP-209 — 帰れない・出られないをなくす

## きっかけ

GAP-207 の完了報告に自分で書いて、backlog に積んだ 2 件:

- 「**サインアウトの導線がアプリ本体に無い**」
- 「**`/t-uc-36`〜`/t-uc-40` はベア画面で戻る導線が無い**」

どちらも「押した先から帰れない / そもそも出られない」で、同じ性質だったので 1 本で直した。

## 直したもの

### ① 帰れない画面をなくした（画面側 = Vercel。API も LLM も増えない）

シェル判定が `/t-uc` を **prefix で丸ごと bare** にしていた。t-uc-35（初回ウォークスルー）
だけが素であるべきなのに、**通知センター・プロフィール・WS 切替・PJ 切替・検索まで
巻き込まれ**、TopBar から押して飛んだ先にナビもヘッダーも無く、**ブラウザの戻るでしか
帰れなかった**。

→ bare は `/t-uc-35` だけに絞り、他はシェルを付けた。

### ② 出る口を作った（サーバー側 = Fly。LLM は使わない）

出られるのは**クライアントポータルだけ**で、社内側の画面にサインアウトが無かった。
共有 PC で使うと**前の人のセッションのまま次の人が使える**。
i18n 辞書には `nav.signOut` =「サインアウト」が最初から入っていたのに、
**それを使う導線がどこにも無かった**。

アバターを（プロフィールへのリンク 1 本から）メニューにし、押すと 3 つ全部やる:

1. `POST /auth/signout` で**サーバー側の refresh token を失効**
2. cookie（`atelier_access` / `atelier_refresh` / `atelier_csrf`）を捨てる
3. **localStorage も捨てる**（前の人が見ていた WS / PJ を次の人に見せない）

サーバーに繋がらなくても手元は必ず片付ける（**出られない、を作らない**）。

### ③ ついでに見つけた実バグ — 失効が一度も効いていなかった（本題より重い）

`refresh_access_token` の照合 SQL がこうなっていた:

```sql
and not exists (
  select 1 from public.audit_logs r
  where r.action = 'auth.refresh.revoked_all'
  and r.actor_id = (after->>'user_id')      -- ← 修飾が無い
  and r.created_at > public.audit_logs.created_at
)
```

**修飾を省いた `after` は、内側の `r.after` に解決される。** `revoked_all` 行の
`after` は `{"reason": ...}` で `user_id` を持たないため比較が常に NULL になり、
**この条件は一度も成立していなかった** = 失効の仕組みが丸ごと空振りしていた。

つまり **パスワードを変えても、盗まれた refresh token はそのまま使えていた**
（`confirm_password_reset` も同じ仕組みに乗っている）。サインアウトを作った結果
初めて表に出たが、**バグ自体はサインアウトより前から存在していた**。

`public.audit_logs.after->>'user_id'` と修飾して修正。**実 Postgres で
「直す前 = 1 件通る / 直した後 = 0 件」を確認してから**直した:

```
--- BUGGY (unqualified after->>user_id resolves to r.after) ---  hits: 1
--- FIXED (qualified public.audit_logs.after) ---               hits: 0
```

テストも「直す前は落ちる」ことを確認済み（片方だけ直すと 2 件とも赤になる）。

## 証拠

`e2e-output.log` — 実行全文（**21 チェック / NG 0**）。本番ビルドの Next.js (:3100)
＋ 実 API (:8123) ＋ 実 Postgres (:54322) に対し、**ワークスペースを持つ利用者**を
使い捨てで 1 人作り、**盗まれた想定の refresh token を 2 本仕込んで**操作した。

| 見たこと | 結果 |
|---|---|
| サインアウト**前**は refresh が通る（土台） | `POST /auth/refresh -> 200` |
| t-uc-36〜40 にナビとアカウントメニューがある | 10/10 OK |
| t-uc-35 は**素のまま**（全部に付けたのではない） | ウォークスルー本体が出た上で nav 0 件 |
| アバターがメニューになり**サインアウトが出る** | OK（プロフィール導線も残っている） |
| 押すとサインイン画面に着地する | `http://localhost:3100/signin` |
| cookie が消える | OK |
| localStorage の前の人の文脈が消える | `{"ws":null,"pj":null}` |
| サインアウト**後**は refresh が通らない | `POST /auth/refresh -> 401` |
| 出た後に画面を直接開いても戻される | OK |

- `gap209-shelled.png` — 検索画面にサイドバー＋ヘッダーが付いている
- `gap209-walkthrough.png` — ウォークスルーは素のまま
- `gap209-menu.png` — アバターのメニューに**サインアウト**が出ている
- `gap209-after-signout.png` — 押した後のサインイン画面

### e2e 自体の空振りも 1 度踏んだ（正直に）

最初 `isVisible({ timeout })` で書いたが、Playwright の `isVisible()` は**待たない
即時判定**で、まだ hydrate していない画面を「ナビが無い」と誤判定して 10 件 NG に
なった。`waitFor({ state: "visible" })` に直したら全て OK になった（**実装ではなく
検査側の誤り**だったので、実装を触って通したわけではない）。t-uc-35 の判定も
「画面が出ていないから nav も無い」という空振りの合格を作らないよう、
**ウォークスルー本体が出ていること**を先に確かめるようにした。

## テスト

- `apps/api/tests/routes/test_auth.py` — `TestSignOut` 3 件 +
  `test_password_change_revokes_refresh_tokens` 1 件（**③ の回帰**）。
  全体 **1434 passed / 1 skipped**
- `apps/web/tests/bundle-b/gap209-signout-and-shell.test.tsx` — 11 件。
  全体 **827 passed**
- `pnpm -r type-check` / `next lint` / eslint / ruff format クリーン、
  流出検査 856 件 0 漏洩、Gate #5 endpoint drift 0、`sync-types.sh` 差分なし

## 再現手順

```bash
# 前提: web :3100 (next build && next start) / API :8123 (uvicorn, JWT=e2e-secret) /
#       Postgres :54322
bash .qa/gap-209/run-browser-e2e.sh
```
