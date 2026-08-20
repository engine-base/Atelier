# GAP-194 — エラーが起きたときに運営へ通知する

## 何が問題だったか

GAP-182 で `public.error_log` への記録はできるようになったが、**そこで止まっていた**。
運営が S-T05 を開きに行かない限り、本番が壊れていても誰も気づけない。
`docs/gap-backlog.md` にも「今は『見に行けば分かる』段階」と書いてあった。

## どこで動くか / 誰の費用か

- **どこで動くか**: 運営サーバー (Fly.io) の cron `error-alerts`
- **誰の費用か**: 運営。Resend は無料枠 (月 3,000 通)、Slack Webhook は無料。
- **Fly.io の課金は増えない**: 既存の `user-schedules` と同じ `*/15 * * * *` に
  合わせてあるので、machine の起床回数が増えない。その代わり **通知は最大 15 分遅れる**。
  これは「常時起動して即時通知する（月額が上がる）」より安いほうを選んだ結果で、
  画面 (S-T05) にも `最大 15 分` と表示している。

## 送りすぎない仕組み

| 仕掛け | 効果 |
|---|---|
| fingerprint 単位の冷却 (既定 60 分) | 同じ不具合で何百通も来ない |
| 前回通知以降の増分だけを伝える | 「また 300 件」ではなく「新たに 12 件」 |
| 1 回の実行で最大 5 件 | 一斉障害でもメール爆撃にならない (残りは次回) |
| warning は既定で送らない | ノイズを増やさない (`ATELIER_ALERT_NOTIFY_WARNINGS` で ON) |
| `AlertDeliveryFailed` は対象外 | 通知の失敗が次の通知を呼ぶ無限ループを作らない |

## 嘘をつかない仕組み

- 送信先が未設定 → `skipped` として記録し、`last_notified_at` を**進めない**。
  設定した瞬間に、それまでのエラーがちゃんと 1 通目として届く。
- 配送失敗 → `failed` として記録し、こちらも進めない。次回再試行される。
- Resend の dry-run (API key 未設定) は**成功に数えない**。
- 画面は「未設定 — どこにも通知できていません」と赤字で出す。

## 設定

| 環境変数 | 意味 |
|---|---|
| `ATELIER_ALERT_EMAIL_TO` | 通知先メール (カンマ区切り) |
| `ATELIER_ALERT_SLACK_WEBHOOK_URL` | Slack Incoming Webhook |
| `ATELIER_ALERT_COOLDOWN_MINUTES` | 再通知までの冷却 (既定 60) |
| `ATELIER_ALERT_NOTIFY_WARNINGS` | warning も送るか (既定 false) |
| `ATELIER_ALERT_MAX_PER_RUN` | 1 回の最大送信数 (既定 5) |
| `ATELIER_ALERT_DASHBOARD_URL` | 本文に載せる運営画面 URL |

メール送信そのものは既存の `ATELIER_EMAIL_API_KEY` (Resend) を使う。

## 実 e2e (`e2e-output.log`)

ローカルに本物の HTTP 受信サーバーを立て、実 Postgres にエラーを記録して cron を回した。

1. 本物のエラーを 1 件記録
2. cron 実行 → `candidates=1 sent=1`
3. **受信サーバーに実際の本文が届いた**（内容・発生場所・件数・運営画面リンク）
4. DB の送信記録が `sent / 回数 1 / 伝えた件数 1`
5. 冷却中に同じエラーが再発しても**再送されない**

## 自動テスト

- `apps/api/tests/test_error_alerts.py` — 21 件
- `apps/web/tests/bundle-i/gap194-alert-status.test.tsx` — 4 件
