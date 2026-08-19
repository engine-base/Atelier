# GAP-182 — エラー監視を自前にする（Sentry は使わない）

経営者判断 (2026-08-19):
> 「B で進めて」 — A: Sentry.io に送る / **B: 外部に出さず自前の DB + 管理画面**

## 直す前の実態

「Sentry でエラー監視している」とドキュメントに書いてあったが、**実際には何も動いていなかった**。

| 場所 | 書いてあったこと | 実際 |
|---|---|---|
| `docs/PROJECT-STATE.md:24` | 「Sentry EU 接続済」 | **嘘**。接続されていない |
| `docs/monitoring.md` | 「Sentry SDK を初期化済」 | **嘘**。初期化関数はあるが呼ばれていない |
| `apps/api/src/observability/sentry.py` | `init_sentry()` 173 行 | `main.py` から**一度も呼ばれていない** / `sentry-sdk` は依存に**無い** |
| `apps/web/lib/sentry.client.ts` | `initSentryClient()` 130 行 | どこからも import されていない / `@sentry/nextjs` は依存に**無い** |
| `components/ErrorBoundary.tsx` | 「Sentry 配線スロット」 | `onError` は空。しかも **ErrorBoundary 自体がどの画面からも使われていなかった** |

**＝ 本番で API が 500 を返しても、画面が白くなっても、誰も気づけない状態だった。**

## 直したあと

外部 SaaS には 1 バイトも送らない。自分たちの DB に貯めて運営画面で見る。

- `supabase/migrations/gap-182_error_log.sql` — `public.error_log` を新設。
  **RLS policy を 1 つも作らない** ＝ テナントからは読むことも書くこともできない (service_role のみ)
- `src/observability/errors.py` — 記録・一覧・件数・保持期間。記録は best-effort で、
  **書けなくてもリクエストは絶対に止めない**
- `src/errors.py` (UnhandledErrorMiddleware) — API の未捕捉例外を自動記録
- `POST /client-errors` — 画面のクラッシュを記録。`ErrorBoundary` の既定 `onError` がこれを呼び、
  ルートレイアウトに ErrorBoundary を配置したので**実際に効くようになった**
- `GET /admin/errors` + 運営メニュー > 監査ログ > 「エラーログ」パネル (期間切替 24h/7 日/30 日)
- 運営ヘルスチェックに「エラー監視 (自前 / 外部送信なし)」行 — 直近 24h の実件数
- 保持期間 30 日 (`purge-deleted-accounts` の掃除ジョブで削除)
- **秘匿値は保存前にマスク** — Bearer / API キー / JWT / DB URL のパスワード / `password=…`
- Sentry のコードは削除 (`sentry.py` / `sentry.client.ts` / そのテスト)。
  `selected-stack.json#error_tracking` を「自前」に変更、`docs/monitoring.md` を実態に全面書き換え、
  `PROJECT-STATE.md` の虚偽記載を訂正

## 証拠

`e2e-error-log.log`（実 PostgreSQL）:

1. サーバー側の例外を記録（実際の 500 と同じ経路）
2. 画面側のエラーを記録（`POST /client-errors` と同じ経路）
3. **秘匿値が保存されないことを実測** — 書き込んで読み戻し、
   `SUPERSECRET` / JWT / `sk-livekey…` が保存内容に含まれないことを assert
   （保存された文字列: `postgresql://[FILTERED] header="Authorization: [FILTERED] [FILTERED]" key=[FILTERED-KEY]`）
4. 運営画面が読む一覧（発生時刻・場所・種類・24h 件数）

テスト: `apps/api/tests/services/test_error_log.py`（9）、
`apps/web/tests/bundle-i/gap182-error-log.test.tsx`（5）

## どこで動くか / 誰の費用か

| | 記録先 | 費用 | 外部送信 |
|---|---|---|---|
| API のエラー | Supabase (自分たちの DB) | **追加費用ゼロ** | **なし** |
| 画面のエラー | 同上 (`POST /client-errors` 経由) | 同上 | **なし** |

## まだ無いもの（正直に）

- **通知が無い**。エラーログは「見に行けば分かる」段階。メール/Slack 通知は未実装
- **外形監視 (uptime) が無い**。サーバーが完全に落ちた場合は自前ログにも残らない

この 2 つは `docs/monitoring.md` の「未実装」表に明記した。
