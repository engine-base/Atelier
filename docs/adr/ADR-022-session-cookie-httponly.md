# ADR-022: セッション JWT を HttpOnly cookie に置く（web オリジンの route handler が持つ）

- **Status**: Accepted（2026-09-03。GAP-261 の「経営判断待ち」を実装側で確定させた）
- **Date**: 2026-09-03
- **Decider**: 実装 AI（経営者の指示「判断待ちは全部そちらで決めて実装しろ」に基づく）
- **Category**: security
- **Related**: GAP-261, 通し J10-03, 正本 SA01-907/908, R-T08（隣接）

## 文脈

サインインで受け取った JWT を、web が `document.cookie` に書いていた。

```ts
document.cookie = `atelier_access=${token}; path=/; expires=…; SameSite=Lax`;
```

HttpOnly が付いていないので **JS から読める** = XSS が 1 つでもあればトークンが
そのまま盗まれる。正本 (通し J10-03) の期待は「HTTP-only cookie で JWT 発行」で、
実装がそれを満たしていなかった。

制約が 1 つある。**web は Vercel (`*.vercel.app`)、API は Fly (`*.fly.dev`) で別オリジン**
であり、共通の親ドメインを持たない。

## 選択肢

| 案 | 内容 | 判定 |
|---|---|---|
| ① API が Set-Cookie を返す | API が `Set-Cookie: atelier_access=…; HttpOnly` を返し、web は `credentials:'include'` に統一 | **却下**。別オリジンなので 3rd-party cookie 扱い。Safari は既定で拒否、Chrome も廃止方向。**サインインできなくなる** |
| ② web を全面 BFF 化 | 全 API 呼び出しを Next の route handler 経由にし、トークンはサーバー側だけが持つ | **却下（今は）**。チャットの SSE が Vercel の関数実行時間の上限に当たる。Bridge 実行は数分続くので、**製品の中心機能が切れる**。XSS 対策のために本業を壊す取引はしない |
| ③ web オリジンの route handler が cookie を持ち、ブラウザはメモリの控えだけ使う | サインイン直後に `POST /api/session` へ預け HttpOnly で保存。Authorization に使う分は `GET /api/session/token` で取り直し、**メモリにだけ**置く | **採用** |

## 決定（③）

- `POST /api/session` … サインイン直後のトークンを HttpOnly + SameSite=Lax + (本番のみ) Secure で保存
- `DELETE /api/session` … サインアウトで確実に消す（HttpOnly は JS からは消せない）
- `GET /api/session/token` … 同一オリジンの JS にだけ渡す（`Cache-Control: no-store`）
- ブラウザ側 (`lib/auth/connector.ts`) は `document.cookie` に **二度と書かない**。
  メモリの控え + 起動時の 1 回の取り直し (`ensureAccessToken`) で Authorization を組む
- cookie 名・形式は据え置き → `middleware.ts` の画面ガードは変更なしで効く
- この変更より前に作られた素の cookie は読めるままにする。**すでにサインイン中の人を
  締め出さないため**で、次のサインインで HttpOnly に置き換わる

## この決定で消えるもの・残るもの（正直に）

**消える**: 保存された資格情報がそのまま抜かれること。cookie は JS から見えず、
`localStorage` にも置かない。盗むには実行中のページに入り込む必要がある。

**残る**: XSS が起きた場合、`GET /api/session/token` を呼べば**その時点の短命トークン**
（1 時間）は取れる。別オリジン構成のまま、ブラウザの JS が Authorization ヘッダーを
組み立てる以上、ここは原理的に閉じない。

**完全に閉じる条件**: 独自ドメインを取り、`app.<domain>` と `api.<domain>` の同一サイト
構成にすること。そうすれば案 ① が成立し、cookie だけで認証できて JS はトークンに
一切触れなくなる（SSE も直結のまま）。**ローンチ時のドメイン取得と同時に案 ① へ移す**
のが次の一手で、その時この ADR を Superseded にする。

## 結果

- `apps/web/app/api/session/route.ts` / `token/route.ts`（新規）
- `apps/web/lib/auth/connector.ts`（`document.cookie` への書き込みを削除）
- `apps/web/app/auth/oauth-complete/page.tsx`（保存できてから遷移する）
- `apps/web/providers/query-provider.tsx`（起動時にメモリへ載せる）
- ストリーム系 5 経路は同期読みから `await ensureAccessToken()` へ
- 正本 SA01-907（cookie に HttpOnly が付く）/ SA01-908（サインアウトで消える）
