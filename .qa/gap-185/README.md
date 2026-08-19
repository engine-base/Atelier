# GAP-185 — 止まったものを「進めて」と言えば再開できる

経営者判断 (2026-08-19):
> 「上限で止まったジョブの自動再開がありません。→ 自動はしなくていいけど、
>   止まった状態で"進めて"と言ったりしたら再開はできる状態にしておかないとね」

## 直す前の実態

止まる箱は 2 つある。どちらも**人が押して進める入口が無かった**。

| 止まるもの | 止まる印 | 直す前 |
|---|---|---|
| 議事録の構造化解析 | `external_uploads.analysis_pending_since` | バッチが 1 分ごとに拾うのを待つしかない。画面に何も出ない |
| 自動実行 (スケジュール) | `cron_run_history.status = 'deferred'` | 次の定刻 (毎朝 9 時など) まで待つしかない |

止まる理由はどちらも **時間で必ず解ける** 2 つだけ:
- `bridge_offline` — 利用者の PC が繋がっていなかった
- `rate_limited`  — 本人の Claude プラン枠が上限だった (5 時間 / 7 日)

恒久的な失敗 (`parse_failed` など) は「再開」ではなく作り直しなので対象外。

## 入れたもの

### 1. 議事録: `POST /meetings/{id}/resume-analysis`

- 保留中の解析だけを**今すぐ**やり直す
- **文字起こしはやり直さない** — 二重に PC を使わせない・二重に枠を消費しない
- まだ繋がっていなければ**保留のまま残す**。「実行しました」とは言わない
- 画面では、止まっている議事録にだけ「解析を再開」ボタンが出る
  (`RESUMABLE = bridge_offline / llm_unconfigured / rate_limited`)

### 2. 自動実行: `POST /cron-schedules/{id}/run-now`

- 次の定刻を待たずに 1 回だけ動かす
- **`next_run_at` は変えない** — 手動実行で定期スケジュールをずらさない
- **一時停止中の行でも動く** (「止まっているものを進める」用途なので)。
  ただし `enabled` は勝手に true にしない
- 上限中なら `deferred` を返し、履歴も `deferred`。`success` にはしない

### 誰の費用か・どこで動くか

| 部分 | どこで | 誰の費用 |
|---|---|---|
| ボタン・API・DB 更新 | Fly.io / Supabase (運営) | 運営 — 押した瞬間だけの数十 ms。実質増分ゼロ |
| 解析・レポート生成の AI | **利用者の PC の Claude (Bridge)** | **利用者のプラン枠** |
| 集計だけの自動実行 (ダイジェスト等) | Fly.io の SQL | 運営 (既存の枠内) |

**自動再開はしない**のが要点。人が押したときだけ利用者のプラン枠を使う。

## 証拠 — `e2e-manual-resume.log` (実 PostgreSQL、再現スクリプト同梱)

Supabase Storage だけこの環境に無いのでメモリに差し替え。解析本体・LLM チェーン・
DB 更新・監査ログはすべて本物を通している。`ATELIER_ALLOW_FAKE_LLM` は未設定。

1. プラン枠上限で 4 時間止まった議事録が保留一覧に出る。文字起こし本文は保持
2. PC 未接続のまま「進めて」→ `still_pending` / 保留は解除されず / 解析結果も入らない
   (**嘘の成功を出さない**)
3. 繋がった後に「進めて」→ `done`。要約・決定事項・要件・未決・数値がすべて入り、
   保留が解除され、監査ログ `meeting.analysis.retry_complete` が残る。
   文字起こし本文も消えていない
4. 保留でないもの / 存在しないものには `not_pending` / `not_found` を返す
5. 自動実行を今すぐ実行 → `success` 履歴 1 件。`next_run_at` は 1 秒未満のずれ = 不変
6. 一時停止中の自動実行も 1 回だけ動く。`enabled` は false のまま
7. 上限中の AI 自動実行 → `deferred`。履歴も `deferred` (success ではない)

## テスト

- `apps/api/tests/test_manual_resume.py` — 9 件 (実 PG)
- `apps/web/tests/bundle-i/gap185-manual-resume.test.tsx` — 5 件
- `apps/web/tests/bundle-i/uc25-cron-schedule.test.tsx` — 「今すぐ実行」が出る側へ更新

## 残っていること (別 GAP)

**実行中の追い足し指示ができない。** チャットは生成中に入力欄が `disabled` になり、
中断ボタンも無い。「今みたいに実行中に別のことを伝える」は現状**待つしかない**。
落ちてはいない (送信自体ができない) が、割り込みもできない。→ `docs/gap-backlog.md` に GAP-189 として起票。
