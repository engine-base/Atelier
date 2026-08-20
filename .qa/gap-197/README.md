# GAP-197 — DB 接続プールの拡張（実測したら「拡張」より先に直すものがあった）

## 依頼

「DB 接続プールの拡張 — 現在 1 台あたり 15 接続（2 台で 30）。数百ユーザーを
超えるあたりで見直し」

## 測ったら前提が違った

まず数えた。結果:

| | engine 数 | 要求しうる最大接続数 / machine | 2 台合計 |
|---|---|---|---|
| **実測 (before)** | **13** | **195** | **390** |
| docs の記載 | 1 相当 | 15 | 30 |

各サービスが個別に `create_session_factory(create_engine())` を呼んでおり、
`@lru_cache` で **プロセス内に AsyncEngine が 13 個**生きていた。
1 engine = pool_size 10 + overflow 5 なので、負荷がかかると最大 195 接続を
要求しうる。Supabase の接続上限（直接接続でおおよそ 60）を軽く超える。

つまり **「15 接続だから増やそう」ではなく「13 倍に増殖していたので減らす」**
のが正しい対応だった。しかも **どれだけ使っているか見る手段が無かった**ので、
負荷がかかって落ちるまで気づけない。

さらに cron handler は**呼ばれるたびに engine を作って dispose していなかった**
（transcribe-queue は毎分）。実測で 10 回呼ぶと接続が +5 増えた。

## 直したこと

1. **engine はプロセス（event loop）に 1 つ** — `shared_session_factory()` に
   19 か所すべてを寄せた。RLS セッションも同じプールを使う
   （role / claims は `set local` = transaction-local なので次の transaction に漏れない）。
2. **プールの実使用量を見えるようにした** — `pool_stats()` を運営ヘルスチェック
   （S-T01「DB 接続プール」行）に出す。**測ってから増やす**ための数字。
3. **既定値を実態に合わせて設定** — 1 engine になったので 20 + 10 = 30/machine。
   `max_machines_running=2` で合計 60 = 接続予算ちょうど。
4. **接続予算のチェック** — `ATELIER_DB_CONNECTION_BUDGET`（既定 60）を超える設定は
   起動ログで warning、運営画面では「予算超過」として err 表示。
   盛りすぎた設定に**負荷が来る前に**気づける。
5. **`pool_timeout` を 30 秒 → 10 秒** — 長く待たせると「遅い」が「壊れている」に
   見えない。待つより早く原因の分かる失敗にする。

## 結果 (`e2e-output.log`)

```
旧方式の再現: engine 13 個 / 195 接続 per machine (2 台で 390)
現方式の実測: engine 1 個 / 30 接続 per machine (2 台で 60 = 予算ちょうど)
実接続: 同時 5 セッションで使用中 5 → 解放後 0 (数字が実態と一致)
枯渇時: 1.0 秒で TimeoutError (無限に待たず、原因の分かる失敗)
```

## どこで動くか / 誰の費用か

運営サーバー（Fly.io）と Supabase の間。**費用は増えない** — むしろ接続の
無駄遣いが止まる。VM のスペックも変えていない。

## この先「本当に足りなくなった」ときの手（今はやらない）

数百ユーザーで 60 接続が足りなくなったら、**Supabase の Supavisor
（transaction pooler / port 6543）**へ切り替える。クライアント接続を数百まで
受けられる。ただし asyncpg では `statement_cache_size=0` が必要
（prepared statement が pooler と相性が悪い）。実 Supabase での検証が要るので、
**今の段階では入れない**。予算超過チェックがあるので、そのときは数字で気づける。

## 自動テスト

- `apps/api/tests/test_db_pool.py` — 10 件
  （engine が 1 個であること / cron を回しても増えないこと /
  ソースに `create_session_factory(create_engine())` が残っていないこと /
  使用中カウントが実態と動くこと / 予算超過の検出）
