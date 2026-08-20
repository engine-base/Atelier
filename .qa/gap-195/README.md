# GAP-195 — 外形監視 (uptime)

## 何が問題だったか

エラーは自前の `error_log` に貯めていた (GAP-182/194)。しかしそれは
**サーバーが生きている前提**でしか書けない。Fly.io が完全に落ちたら
記録も通知も残らず、復旧後に「いつからいつまで落ちていたか」を答えられなかった。

## どこで動くか / 誰の費用か

- **どこで動くか**: 運営インフラ (Fly.io / Vercel) の**外側** — GitHub Actions。
  15 分ごとに `/health` と画面を叩く。
- **誰の費用か**: 運営。ただし **このリポジトリは public なので GitHub Actions は
  無料 (分数無制限)**。月 2,880 回動かしても 0 円。監視 SaaS の契約も不要。
- **記録先**: **API を経由せず直接 Supabase** (`uptime_checks`)。API が落ちている
  ときに API 経由では記録できないため。deploy.yml と同じ `PROD_DATABASE_URL` を使う。

## 送りすぎない / 黙らない

| 状況 | 動き |
|---|---|
| 稼働中の初回観測 | 通知しない（静かに記録） |
| 落ちた | 通知する |
| 落ちたまま | **通知しない**（15 分ごとに「まだ落ちています」を送らない） |
| 落ちたまま 6 時間 | 定期リマインドを 1 通 |
| 復旧した | 通知する（停止していた開始時刻つき） |
| 通知が届かなかった | `notified=false` のまま記録 → **次の判定で黙らない** |

1 回のタイムアウトで「落ちた」と決めつけない（3 回試行して全部失敗したときだけ）。

## 設定

| 設定 | 種別 | 例 |
|---|---|---|
| `PROD_DATABASE_URL` | Secret | deploy.yml と共用 |
| `ATELIER_UPTIME_TARGETS` | Variable | `api=https://atelier-api-eb.fly.dev/health,web=https://atelier-web-coral.vercel.app` |
| `ATELIER_ALERT_SLACK_WEBHOOK_URL` / `ATELIER_ALERT_EMAIL_TO` | Secret | GAP-194 と共用 |
| `ATELIER_ALERT_DASHBOARD_URL` | Variable | 通知本文に載せる運営画面 URL |

未設定なら **workflow が exit 1 で赤くなる**（GAP-192 と同じ方針で、設定漏れで
監視が動いていない状態を黙って作らない）。

## GitHub 側の制約（隠さずに書く）

- `schedule` は混雑時に遅れることがある。分単位の精度は保証されない。
- リポジトリが 60 日間非活性だと `schedule` は自動停止する。
- Supabase まで落ちた場合はここにも記録が残らない。その場合は workflow の実行
  自体が失敗し、通知は DB を使わない経路（Slack / メール）で飛ぶ。

画面 (S-T05) は観測が 1 件も無いとき「異常なし」に見せず、
**「外からの観測がまだ 1 件もありません。監視が動いていない可能性があります」**と出す。

## 実 e2e (`e2e-output.log`)

本物の HTTP サーバー（監視対象）と本物の Webhook 受信サーバー（通知先）を立て、
実 Postgres に記録しながら **稼働 → 停止 → 停止継続 → 復旧** を観測した。スタブは 0。

1. 稼働中の初回観測 → 通知 0 件（静かに記録）
2. 503 を返す状態に落とす → **「応答しません」が実際に届いた**（症状 HTTP 503 / 3 回試行）
3. 落ちたまま再観測 → **再通知されない**
4. 復旧 → **「復旧しました」が届いた**（停止開始時刻つき）
5. 集計 → 4 回中 2 回成功 = **24h 稼働率 50.0%**

## 自動テスト

- `apps/api/tests/test_uptime.py` — 24 件（実 HTTP の生死判定・再試行・通知判定・
  実 PG 記録・集計・workflow が黙って skip しないこと）
- `apps/web/tests/bundle-i/gap195-uptime.test.tsx` — 4 件
