# 本番ロールバック手順書 (T-I-23)

本番デプロイ後に問題発生した際の **ロールバック判断 + 実施手順** を定める。

## ロールバック判断基準

以下のいずれかに該当する場合 30 分以内にロールバックを開始する:

| 判断軸 | しきい値 |
|---|---|
| Sentry error rate | デプロイ前 baseline の **10x 超** |
| Uptime monitor | 3 endpoint のうち 1 つでも 5 分連続 fail |
| p95 latency | API で 2 連続 1 分 window が **3 秒超** |
| DB pool 枯渇 | connections > 95% を 1 分継続 |
| 致命級 R-T08 違反 | 越境 PASS テスト fail (即時) |

経営者承認は **不要**(SLA 維持優先)、ロールバック後に Slack `#alerts` に報告。

## ロールバック実施手順

### apps/web (Vercel)

```bash
# 1. Vercel CLI で直前の deployment を確認
vercel ls --prod

# 2. promote (atomic、即時切替)
vercel rollback <previous-deployment-url>
```

### apps/api (Fly.io)

```bash
# 1. release history
flyctl releases --app atelier-api

# 2. specific release に戻す
flyctl deploy --image registry.fly.io/atelier-api:<previous-tag>
```

### DB migration ロールバック

DB migration を含むデプロイの場合は **特別注意**。`supabase/migrations/` の
新規 migration を down する必要がある (Supabase migration には down が無いため
逆向き SQL を手動で書く)。

判断:
- 後方互換のある migration (column 追加・index 追加) → ロールバック不要、コードのみ戻す
- 破壊的 migration (column drop, rename) → コード + migration 両方戻す。
  最悪 read-only mode で運用

### キャッシュ / CDN

```bash
# Vercel edge cache をパージ
vercel cache purge --prod

# Cloudflare キャッシュもパージ
cf purge --zone atelier.example
```

## 自動化スクリプト

`./scripts/rollback.sh` で以下を自動実施:
1. Vercel previous deployment promote
2. Fly.io previous release deploy
3. Cloudflare cache purge
4. Slack `#alerts` に完了報告

## ポストモーテム

ロールバック実施後 24 時間以内に postmortem を作成し、以下を記載:

- 発生事象とタイムライン
- 検出方法 (どの monitor が catch したか)
- ロールバックまでの経過時間 (TTR)
- 根本原因
- 再発防止策 (CI gate 追加 / monitor 追加 / 検証手順追加)

ポストモーテムは Atelier 内の `09_dispatch/postmortems/` に置く想定 (別タスク)。

## チェックリスト (本番リリース前)

- [ ] `flyctl releases` で過去 5 リリース分のロールバック可能性確認
- [ ] `vercel ls --prod` で直前 deployment ID を控える
- [ ] `./scripts/rollback.sh --dry-run` で手順 dry-run
- [ ] PagerDuty rotation に on-call ロールバック責任者がいる
