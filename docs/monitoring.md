# 本番監視 (現状)

> **この文書は「実際にあるもの」だけを書く。** 以前の版は Better Stack / PagerDuty /
> Sentry を前提に書かれていたが、**どれも配線されていなかった** (GAP-182 で発覚)。
> 予定は「未実装」として明示する。

## 1. エラー監視 — 自前 (実装済 / GAP-182)

外部の監視 SaaS は使わない（経営者判断 2026-08-19）。スタックトレース・URL・
ユーザー ID を外部に出さず、追加費用もかからない。

| 何が | どこに記録されるか | どこで見るか |
|---|---|---|
| API の未捕捉例外 (500) | `public.error_log` (source=`api`) | 運営メニュー > 監査ログ > **エラーログ** |
| 画面 (Next.js) のクラッシュ | 同上 (source=`web`) — `POST /client-errors` 経由 | 同上 |
| バッチ (cron) の失敗 | `public.cron_run_history` | 自動スケジュール画面 > 実行履歴 |

- 秘匿値 (Bearer / API キー / JWT / DB URL / password=… ) は保存前にマスクされる。
- テナントからは読めない (RLS で policy を一切与えていない)。運営 admin のみ。
- 同種は `fingerprint` でまとまり、直近 24h の件数が一覧に出る。
- 運営ヘルスチェック (`GET /admin/health`) に「エラー監視 (自前 / 外部送信なし)」行があり、
  直近 24 時間の件数を返す。

保持期間: 30 日（`purge_old_errors`）。

## 2. 実行経路の可視化 (実装済)

`GET /admin/health` が「誰の費用で何が動いているか」を実データで返す。

| 行 | 何を見ているか |
|---|---|
| AI 実行経路 / 費用の出どころ | relay (本人サブスク) / agent_sdk / API 課金 のどれか (GAP-178) |
| 意味検索 (埋め込み) の経路 | ローカル / Voyage / 利用不可 + 準備状況 (GAP-180) |
| 議事録の文字起こし経路 | ローカル faster-whisper / OpenAI API (GAP-181) |
| ディスパッチャ / Bridge | 接続 Bridge 数・実行中・キュー待ち |
| エラー監視 | 直近 24h のエラー件数 (GAP-182) |

起動時にも `atelier.llm_route` / `atelier.embedding_route` / `atelier.stt_route` の
3 行がログに出る (警告があれば warning レベル)。

## 3. プラットフォーム標準のログ (実装済 / 外部設定不要)

- **Fly.io**: `flyctl logs --app atelier-api-eb` で API の stdout/stderr
- **Vercel**: プロジェクトの Logs タブで画面側のビルド/実行ログ
- **Supabase**: Dashboard の Logs で Postgres / Auth

## 4. 未実装 (正直に書く)

| 項目 | 状態 |
|---|---|
| Uptime 監視 (外形監視) | **未実装**。落ちても自動では気づけない |
| エラー発生時の通知 (メール / Slack) | **未実装**。エラーログは「見に行けば分かる」段階 |
| APM / p95 レイテンシ計測 | **未実装** |
| RUM (Core Web Vitals 実測) | **未実装** |
| Sentry / Better Stack / PagerDuty | **使わない** (GAP-182 で自前に置換) |

## 5. 日々の確認手順

1. 運営メニュー > 監査ログ > エラーログ を「24 時間」で開く
2. 件数が 0 でなければ `kind` と `24h` 列を見る (同じものが増えていないか)
3. `./scripts/check-monitoring.sh` で主要エンドポイントが 200 を返すことを確認
