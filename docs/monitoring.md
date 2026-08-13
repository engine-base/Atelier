# 本番監視ダッシュボード (T-I-22)

Better Stack (旧 Logtail + Better Uptime) を中心とした本番監視構成。

## 監視対象

| 種別 | 対象 | 計測 | しきい値 |
|---|---|---|---|
| Uptime | `https://app.atelier.example` | 1 分 ping | 1 min 3 連続 fail で alert |
| Uptime | `https://api.atelier.example/healthz` | 1 分 ping | 同上 |
| Uptime | `https://client.atelier.example` | 5 分 ping | 同上 |
| Logs | Fly.io apps/api stderr | 全件 | level=ERROR で alert |
| Logs | Vercel apps/web edge | 全件 | 5xx rate > 1% で alert |
| Metrics | apps/api 主要 endpoint p95 | 1 分 | > 500ms で warn / > 1s で alert |
| Metrics | DB connection count | 1 分 | > 80% pool で alert |
| RUM | apps/web Core Web Vitals | 全 page view | LCP > 2.5s / CLS > 0.1 で warn |

## 通知

- **error 級**: PagerDuty → on-call SMS + Slack `#alerts`
- **warn 級**: Slack `#alerts` のみ
- **info 級**: メール daily digest

## Sentry

実配線は T-F-42 で完了 (それ以前は実装のみで**呼び出し元が無く**、捕捉件数は
構造的にゼロだった — GAP-108)。現在の呼び出し経路は以下の 3 箇所:

| 面 | 実装 | 呼び出し元 (実行経路) |
|---|---|---|
| API | `apps/api/src/observability/sentry.py` `init_sentry()` | `apps/api/main.py` の `lifespan` (起動時に 1 回・idempotent) |
| Web 初期化 | `apps/web/lib/sentry.client.ts` `initSentryClient()` | `apps/web/providers/observability-provider.tsx` (`app/layout.tsx` のツリー) |
| Web エラー送信 | `providers/observability-provider.tsx` `captureException()` | `apps/web/components/ErrorBoundary.tsx` の `componentDidCatch` |

- 必要な環境変数: API = `SENTRY_DSN` / Web = `NEXT_PUBLIC_SENTRY_DSN`
  (どちらも未設定なら skip ログのみで通常起動・通常描画する)
- Release tag: GitHub Actions の `${{ github.sha }}` を Sentry に通知
- Sourcemaps: Vercel から自動アップロード
- PII scrub: `sentry.py` の `before_send` が Authorization / Cookie / API key
  ヘッダを `[Filtered]` に置換

## Better Stack ダッシュボード

ダッシュボード ID: `atelier-prod-overview` (Better Stack の Workspace 内)。
SLI / SLO:
- Web availability: 99.9% (monthly)
- API availability: 99.9% (monthly)
- p95 latency: < 500ms (95% of 5min windows)

## 復旧時間目標

| 重大度 | RTO | RPO |
|---|---|---|
| Sev-1 (全断) | 30 分 | 5 分 |
| Sev-2 (一部障害) | 2 時間 | 30 分 |
| Sev-3 (劣化) | 24 時間 | 24 時間 |

## チェックリスト

- [ ] Better Stack の uptime monitor が 3 ドメインで GREEN
- [ ] Sentry に直近 24h の error 件数を確認、新規 issue 0 件
- [ ] PagerDuty rotation が当週分セット
- [ ] `./scripts/check-monitoring.sh` で全 endpoint が 200 を返すこと
