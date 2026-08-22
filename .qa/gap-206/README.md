# GAP-206 — GAP-203 / GAP-204 の仕上げ（残っていた 4 つの穴）

## きっかけ

経営者から「**次にすることはありますか？まだできてない点で**」「**完璧にお願いします。
もちろん通しのテストとかブラウザでの操作で通しとかもしてよ**」。

GAP-203（順番待ち）と GAP-204（流出防止・規約）を入れた直後の状態を点検し、
**入れたつもりで効いていない**ところを 4 つ見つけて塞いだ。

## 見つけた穴と、実際にやったこと

### ① 規約を新しくしたのに、既存ユーザーが旧版のまま（一番大きい）

同意 (`consents`) を記録していたのは **新規登録のときだけ**だった。GAP-188（各自の
Claude 契約が必要）・GAP-204（複製/模倣の禁止・機械学習への利用禁止）を規約へ足したが、
**旧版に同意したままの利用者に再同意を求める導線が一つも無かった**。足した条項が
効きにくい＝入れた意味が半分失われている状態。

- `GET /me/consents` — 「同意済みの版」と「今の版」を突き合わせて、ずれを返す
- `POST /me/consents` — **画面が見せた版を指定させて**記録する。古い版を見ていたら
  409 で拒否（読んでいない文面に同意させない）。**旧版の記録は消さない**（append-only）
- `ReconsentNotice`（全画面の上端の帯）— 何が更新されたか・本文を読むリンク・同意ボタン

**やらなかったこと（意図的）**: 同意するまで使わせない、という強制は入れていない。
それは法務レビューの結果と経営判断で決めることで、実装が先走ってよいものではない。
「あとで」で閉じられる。ただし**版が変われば また出る**（閉じたことを永久に引きずらない）。

### ② 流出検査に「登録漏れ」の穴があった

GAP-204 の検査は、対象ファイルを **手で書いた一覧**（`SERVER_ONLY_SOURCES`）で
持っていた。つまり新しくプロンプトを持つファイルを足して一覧に書き忘れると、
**そのファイルは丸ごと検査を素通り**する。実際に **4 ファイル漏れていた**
（`services/knowledge/curation.py` / `services/mocks/design_note.py` /
`services/mocks/generate.py` / `services/mocks/revise.py`）。

`apps/api/src` を機械的に走査し、プロンプトの印（`あなたは`）を含むのに
登録されていないファイルがあれば **CI を落とす**ようにした。誤検知は
`NOT_A_PROMPT` に理由つきで書く（黙って除外させない）。漏れていた 4 件は登録済み。

### ③ 503 が全部「パソコンを繋いでください」に見えていた

503 は「本人の PC (Bridge) 未接続」「保存先が未設定」「LLM 経路が未設定」で
**まったく別の話**なのに、画面に届いていたのは status だけだった。だから画面は
原因を推測するしかなく、**設定漏れでも「パソコンを繋いでください」と案内**していた。

- `X-Atelier-Reason` ヘッダに原因コードを載せる（`service_unavailable()` で統一。
  12 ファイル・31 か所。**素の 503 を 1 つも残さない** — 残すとその画面だけ誤案内が生き残る）
- CORS の `expose_headers` に入れる — **入れないとブラウザから読めない**（＝誤案内が戻る）
- 判定の**正本を 1 つにした**: `components/bridge/BridgeOfflineNotice.tsx` の
  `isBridgeOffline()` が `reason === "bridge_offline"` を見る。ここが「503 かどうか」を
  見ていたのが誤案内の根っこだった。各画面のコピーを消して正本を使う
- グローバル toast も同じ — 未接続以外の 503 は**サーバーの本文をそのまま**出す
- 見直しで**追加で見つかった 5 か所**も直した:
  Excel/PDF の AI 修正 (`SheetEditor`)、デザインテンプレのスタジオ、
  工程のフェーズ提案 (`PhaseListContainer`)、成果物の修正提案の生成と承認

### ④ 順番待ちが起きても運営が気づけなかった

GAP-203 で「断らずに並ばせる」ようにしたが、**並んだこと自体は運営画面を見に行かないと
分からなかった**。しかも順番待ちの数は machine ごとのプロセス内カウンタで、cron は
1 台でしか動かないため「**もう 1 台で起きた混雑には構造的に気づけない**」。

- `capacity_events` — 混雑した **その瞬間に** 1 行残す（machine ID つき）
- `capacity_alert_state` — 冷却 60 分（鳴りっぱなしにしない）
- 集計と通知は **既存の error-alerts cron に相乗り**。専用 cron を足すと
  machine の起動回数＝課金が増えるため、あえて足していない
- 断ったときと待たせただけのときで **本文を変える**（対応が違うため）
- `capacity_events` は **90 日で消す**（無限に太らせない）。掃除も
  既存の `purge-deleted-accounts` ジョブに相乗り（エラーログ 30 日と同じ場所）

## どこで動くか / 誰の費用か

すべて **SaaS クラウド側**（API = Fly.io、DB = Supabase、画面 = Vercel）。
費用は運営のインフラ費のみで、**LLM は 1 回も呼んでいない**（＝利用者の Claude
サブスクも消費しない）。混雑通知のメール送信だけは既存の通知経路（運営側）を使う。

## 証拠（この e2e は実物しか使っていない）

`e2e-output.log` — 下記 3 本の実行全文（**42 チェック / NG 0**）

### (A) `run-browser-e2e.sh` + `e2e-browser.mjs` — 実ブラウザ (Chromium)

本番ビルドの Next.js (:3100) + 実 API (:8123) + 実 Postgres (:54322) に対して、
**旧版に同意したままの利用者を実際に 2 人作って**操作した。

- 帯が出る → 更新されたものだけ載る（同意済みの プライバシーポリシーは載せない）
- 「利用規約を読む」→ 本文に **GAP-204 で足した第9条・機械学習への利用禁止**が実際にある
- 「同意する」→ 送っているのは `{"doc_type":"terms_of_service","version":"2026-08-21"}`
  （**画面が見せた版**）1 回だけ → 帯が消える → 再読み込みでも出ない
- **DB を直接見て**確認: 旧版 `2026-05-25` の行は残ったまま、`2026-08-21` の行が増え、
  User-Agent も記録されている
- 「あとで」→ 閉じられる。同じ版では再表示しない。**閉じても同意にはなっていない**
  （`needs_consent` は true のまま / DB に行は増えない）
- **503 の理由をブラウザの `fetch` で実際に読めた**:
  `{"status":503,"reason":"provider_disabled",...}` → **`bridge_offline` ではない**

画面: `gap206-banner.png`（帯）/ `gap206-terms.png`（本文）/
`gap206-after-accept.png`（同意後）/ `gap206-dismissed.png`（あとで）

### (B) `e2e-registration-gap.sh` — 検査を実際に漏らして確かめる

「検査が PASS した」だけでは意味がない（何も見ていなくても PASS する）。

1. プロンプトを持つファイルを**実際に新規作成** → 登録漏れとして落ちる（ファイル名と直し方つき）
2. 登録すると通る
3. **登録したファイルの文言を画面側の JS へ実際に埋め込む → 落ちる**（登録が飾りでない）
4. ファイルだけ消すと「古い登録」として落ちる（一覧が腐らない）
5. 後片付けして元どおり PASS

### (C) `e2e-capacity-alert.py` — 実アプリ起動 + 実 SSE 経路 + 実 DB

単体テストは `main.py` の文字列を見ているだけなので、**本物の lifespan を起動**して確かめた。

- 起動前は記録先なし → **起動後に差し込まれている**
- **本物の `guarded_stream`** で上限まで埋めて 3 人目を溢れさせる → 断られず並ぶ
- DB に 1 行残る: `kind=queued machine=e2e-machine-1 open=2/2 queued=1 detail=1 人目`
- 別 machine の行を足すと **2 台ぶんまとめて**集計される（`machines=2 peak_queued=7`）
- 通知本文: `[Atelier] 順番待ちが発生しました（2 回 / machine 2 台）`＋「断ってはいません」
- 送信先が未設定 → `sent=0 skipped=1`、`last_notified_at` は **進めない**
  （＝**送ったふりをしない**。次回また試す）

## テスト

- `apps/api/tests/test_consents_reconsent.py` — 10（実 Postgres）
- `apps/api/tests/test_capacity_alerts.py` — 16（実 Postgres。**実際に送る経路**と保持期間を含む）
- `apps/web/tests/bundle-i/gap206-reconsent.test.tsx` — 9
- `apps/web/tests/bundle-h/bridge-offline-notice.test.tsx` — **未接続でない 503 では
  接続フローを出さない**ことを固定（この GAP の要点そのもの）。既存の
  「503 → 接続フロー」テストは、サーバーが `bridge_offline` を申告する形に更新
- 全体: API `1404 passed / 1 skipped`（全体 coverage 82.0% / **変更行 92.9%**）、
  web `808 passed`、`pnpm -r type-check` / `next lint` / ruff /
  pyright（触ったファイル 0 error）/ 流出検査 856 件 0 漏洩

## 再現手順

```bash
# 1) API (JWT=e2e-secret) と 画面 (本番ビルド) を上げる
cd apps/api && ATELIER_DB_URL='postgresql+asyncpg://postgres@/postgres?host=/tmp&port=54322' \
  ATELIER_AUTH_JWT_SECRET=e2e-secret uvicorn main:app --port 8123 &
cd apps/web && NEXT_PUBLIC_API_URL=http://127.0.0.1:8123 pnpm exec next build \
  && NEXT_PUBLIC_API_URL=http://127.0.0.1:8123 pnpm exec next start -p 3100 &

# 2) e2e 3 本
bash .qa/gap-206/run-browser-e2e.sh
bash .qa/gap-206/e2e-registration-gap.sh
python .qa/gap-206/e2e-capacity-alert.py
```

## 残っていること（判断待ち — AI が決めてよいことではない）

- **規約の法務レビュー**と、レビュー後の版で改めて再同意を取り直すか
- 同意するまで使わせない **強制にするかどうか**（今は強制していない）
- 混雑通知の宛先 (`ATELIER_ALERT_EMAIL_TO` / Slack Webhook) の設定
  — 未設定のあいだは `skipped` として残るだけで、**誰にも届かない**
