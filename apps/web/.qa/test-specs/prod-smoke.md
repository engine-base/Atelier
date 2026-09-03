# 本番スモーク テスト仕様（prod-smoke / human-grade-qa）

> 対象: 本番 API `https://atelier-api-eb.fly.dev`（Fly Tokyo）+ Vercel フロント + Supabase atelier-prod。
> 目的: デプロイ後に「実ユーザーが新規登録から実際に触れる」ことを実機で保証する。
> 実行 = 2026-07-15（実キー投入・DB 復元後）→ **再実行 = 2026-09-02（GAP-237 凍結解除 + deploy #73 成功後の全行再測。結果列は 09-02 実測が正）**。

## 前提チェック（環境の生存）
| ID | 対象 | 手順 | 期待 | 結果 | タスク | 実行条件 |
|---|---|---|---|---|---|---|
| PS-00 | デプロイ鮮度 | deploy.yml 最新 run | success かつ main HEAD 反映 | **PASS (2026-09-02)**: deploy #73 が main HEAD (0fd4bf6) で全ステップ成功 (migration 98本収束 → seed → Fly → /health 200)。※過去 2 回の教訓 (FLY_API_TOKEN 失効 6 週停止 / 8-13 凍結 6 週) から要監視は継続 | T-F-06 | L4 |
| PS-01 | API health | GET /health | 200 | **PASS (2026-09-02 実測 200)** | T-F-04 | L4 |
| PS-02 | Supabase 生存 | auth/v1/health | 200/401（up） | **FAIL (2026-08-27 実測)**: `rgxwmdnqnlkgrgdfafih.supabase.co` が接続不能 (http 000・名前解決レベルで死) = **無料枠の自動休止が再発 (INFRA-2)**。7 月から約 6 週無活動のため。本番 API の DB 依存操作は全 500 (signin 実測 500)。deploy #71 も migration 手前で安全停止 (pooler が tenant not found)。**解除条件: Supabase ダッシュボードでプロジェクトを Restore/Resume (経営者のみ可)。90 日超休止は削除リスクがあるため早急に** → **PASS (2026-08-27 経営者が Restore・2026-09-02 実測 auth health 401=稼働)**。※無料枠は 1 週無活動で再休止するため恒久対策 (Pro 化 or 定期アクセス) は別途判断 | T-F-05 | L4 |
| PS-03 | web デプロイ鮮度 (Vercel) | 本番 `/signin` を GET し SSR HTML を検査 | AppShell の nav (`aria-label="ホーム"`) が**含まれない** (サインインは bare) — 含まれていたら本番 web が古いビルド (デプロイ乖離) | **PASS (2026-08-27 実測)**: 凍結解除 (GAP-237, main=a4b7fc9) 後の Vercel 自動デプロイで新ビルドへ切替を確認 — /signin の SSR にサイドバー 0 件。実ブラウザ再現でも `/`→`/signin` でサイドバー一瞬表示なし (旧ビルドでは実測 true だった)。経営者指摘のチラつきは解消 | T-F-06 | L4 |
| PS-04 | migration の稼働中 DB 耐性 | 「既に現行データが居る DB」への全 migration 再適用 (収束ループ) | 全 migration が適用順・適用済み状態に依存せず収束する (まっさら DB だけで検証しない — Gate #14 は fresh DB のみで、**稼働中の本番へ当てて初めて落ちる migration を検出できない**) | **FAIL→修正済 (2026-08-27)**: deploy #72 で gap-188 が「現行版を外す前に is_current=true で insert」しており legal_documents_current_uidx に衝突、4 周しても収束せず (97/98 適用・deploy 中断)。demote→insert 順序則 + 「より新しい現行が居たら現行化しない」へ是正 = GAP-238。使い捨て DB で本番順 (旧現行→gap-208→gap-188)・まっさら順 (gap-188→gap-208) の両方の収束を実証。**PASS (2026-09-02)**: deploy #73 で全 98 migration が稼働中の本番 DB へ収束・エラー 0 | T-D-28 | L4 |
| PS-05 | Storage バケットの実在 | API が使う全バケット (chat-attachments / outputs / mocks / avatars / meetings / transcripts / reference-uploads) について、本番で署名 URL 発行 (例: POST /chat/attachments/upload-url) が通り、PUT まで成功する | **バケットがコード (migration) で作られ、本番に 7 つとも存在する** — 添付・成果物・モック・アイコン・議事録・参考資料の保存が 502 にならない (ダッシュボードの手作業に依存しない) | **PASS prod(pre-launch) (2026-09-03 再測)**: deploy e9e8a00 後、chat-attachments / avatars / meetings の 3 バケットで署名 URL 発行 → 実 PUT 200（証拠 evidence/ps05-17-prod-20260903.txt）。残り 4 バケット (outputs / mocks / transcripts / reference-uploads) は同じ migration gap-242 で同時作成（サーバー側書込のみで署名 URL 経路が無い） | T-F-05 | L4 |
| PS-28 | 本番 API 並行 | owner JWT で GET /me を同時 10 本 × 3 回、GET /projects を直列 20 本 | 5xx が 0 (画面 1 枚の初期ロードは 4〜6 本を同時に発行する) | **FAIL (2026-09-03)**: 同時 30 本で 500 が 2 本、直列 20 本で 500 が 3 本 (1〜2 秒で失敗 = プール待ちの 10 秒ではない)。参照 ID 304f0a0e-… ほか。GAP-291 (サーバーログで原因特定が要る) | T-I-24 | L4 |
| PS-29 | 本番 公開 API | 未認証で GET /public/legal-documents?locale=ja と 3 種の詳細 | 全部 200 | **FAIL (2026-09-03)**: 3 種とも 500 (GAP-290)。認証付き経路は同じ表を読める | T-I-24 | L4 |

## 認証（新規登録から）
| ID | 対象 | 手順 | 期待 | 結果 | タスク | 実行条件 |
|---|---|---|---|---|---|---|
| PS-10 | 新規登録 | POST /auth/signup（consents 2 種・version=semver/日付） | 201・consents_recorded | **PASS (2026-09-02 再測)**: 現行版 2026-08-22 で 201・consents_recorded=2 (QA アカウント) | T-A-01 | L4 |
| PS-11 | consent version 検証 | version='v1'（不正）で signup | **422**（500 でない） | **PASS (2026-09-02 再測 422)** バグ#25。加えて **GAP-235 (実在しない版=1999-01-01 → 409 + 定型文・記録なし) も本番実測 PASS** | T-A-01 | L4 |
| PS-12 | signup 原子性 | DB 失敗を誘発 | Supabase auth.users を孤児化しない | **PASS（2026-07-15 修正後実証）**。2026-09-02 は未再測 (本番 DB の故意破壊を伴うため実施せず — 回帰はユニットテストが担保) | T-A-01 | L4 |
| PS-13 | サインイン | POST /auth/signin | 200・access_token 発行 | **PASS (2026-09-02 再測 200・token 発行)** | T-A-02 | L4 |
| PS-14 | 認証ガード | 無認証で保護 API | 401 | **PASS (2026-09-02 再測 401)** | T-A-04 | L4 |
| PS-15 | 画面描画 | S-A01 を本番 API 相手に表示 | サインイン/新規登録が正常描画 | **PASS (2026-09-02 実ブラウザ再測)**: フォーム描画・実サインイン→/projects 着地・復元導線 (GAP-233) と特商法同意文言も表示 | T-UC-01 | L4 |
| PS-16 | 退会/復元の step-up | ログイン済で POST /auth/account/delete (正 password) → 退会受付 → signin 拒否 → restore → 復活 | 正しい password で受付・全周が回る | **FAIL→修正済 (2026-09-02)**: 本番で正 password でも 401 = **誰も退会できなかった** (GAP-239 — step-up が dev/test 用 sha256 スタブ検証を無条件使用。bcrypt を持つ本番 Supabase では必ず不一致)。signin 同一経路 (Supabase 優先/stub フォールバック) へ修正・回帰テスト 2 本。**PASS (2026-09-02 deploy #74 後に本番全周再測)**: 誤 pw 401 → 正 pw 200 (deleted_at + scheduled_purge_at=30日後) → signin 401 (存在秘匿) → restore 200 → signin 200 → 再退会 200。QA アカウントは退会状態で終了 (30 日後自動削除) | T-A-05 | L4 |
| PS-17 | 退会でセッションが終わる | 退会 (200) の直後に、退会前に発行された JWT で保護 API (GET /workspaces 等) と Bridge トークン (POST /chat-relay/pick) を叩く | **どちらも 401** — 退会したのに既存のブラウザ/PC 接続だけ生き残らない (signin の 401 と整合)。復活 (restore) 後は再び通る | **PASS prod(pre-launch) (2026-09-03 再測)**: 退会 200 → 旧 JWT で GET /projects 401 / X-Bridge-Token で pick 401（退会前は 200）/ signin 401。restore 200 → 新 JWT で 200。退会前のトークンは復活後も 401（再発行が要る）。証拠 evidence/ps05-17-prod-20260903.txt | T-A-05 | L4 |

## 主要フロー（実 AI まで）
| ID | 対象 | 手順 | 期待 | 結果 | タスク | 実行条件 |
|---|---|---|---|---|---|---|
| PS-20 | ワークスペース作成 | POST /workspaces | 201 | **PASS (2026-09-02 再測 201)**。T-A-54 の AI 社員 10 名自動シードも実測 (ジャービス/トニー/ナターシャ/…) | T-A-06 | L4 |
| PS-21 | プロジェクト作成 | POST /projects | 201 | **PASS (2026-09-02 再測 201)** | T-A-10 | L4 |
| PS-22 | チャット実 AI | 新規WS→社員自動シード→スレッド→送信 | **(期待を現行仕様へ改訂 — GAP-175/178)** AI 実行は本人の PC 上の Bridge + 本人の Claude 契約が既定。Bridge 未接続では**偽成功を出さず**、SSE で経路と復旧手順を明示する | **PASS (2026-09-02 再測・経路)**: スレッド作成 201 → SSE 200・整形イベント → error「ローカル実行 (Bridge) がオフラインのため応答できません。お使いの PC で Bridge を起動してから再送してください。」= 現行仕様どおりの正直な挙動。**実 LLM 応答も PASS (2026-09-02 本番実測)**: 検証用サンドボックスで Bridge をヘッドレス起動 (`node dist/headless.js --loop`、接続トークンは画面と同じ POST /bridge-tokens で発行) → 本番スレッドへ送信 → SSE が run(job_id) → delta ×4 → end (assistant_message_id・101 文字) を 6.4 秒で返却。応答「こんにちは、営業・契約部長のトニーです。…『QA Bridge 案件』について…」= ペルソナ + プロジェクト文脈が注入済み。DB にも user/assistant 両メッセージが永続。**実行場所 = Bridge 側 (経営者の Claude ログイン) / 費用 = 本人サブスク / サーバー側 API キー課金なし**。証拠 `.qa/evidence/ps22-prod-bridge-sse-20260902.txt`。接続トークンは検証後に失効済 | T-F-41 | L4 |
| PS-23 | RAG 実引き | ナレッジ参照質問 | **(期待を現行仕様へ改訂 — GAP-133/200)** 意味検索が使えない環境では黙って劣化せず search_mode を明示して text_fallback する。意味検索本体はサーバー同梱モデル (server_ai=true・VM 2GB) が必要で既定 OFF (運営費用を勝手に増やさない) | **PASS (2026-09-02 再測・degrade 経路)**: ナレッジ作成 201 → POST /knowledge/search が `search_mode: text_fallback` を明示しキーワードでヒット 1 件。**意味検索 (embedding) 本体は BLOCKED** (解除条件: deploy を server_ai=true で実行 = 経営者の費用判断) | T-A-36 | L4 |
| PS-24 | リロード永続 | F5 | ログアウトせず維持 | **PASS (2026-09-02 本番実ブラウザ再測)**: サインイン → /projects → F5 → ログイン維持・WS 名表示のまま | T-US-03 | L4 |
| PS-25 | staging 指定の deploy が本番へ落ちない (G-11) | `gh workflow run deploy.yml -f environment=staging` を **STAGING_* secrets 未登録** の状態で実行 | Verify required secrets で **fail**（本番 app / 本番 DB に一切触らない）。secrets 登録後は staging app だけに deploy | **FAIL→修正済 (2026-09-03)**: `cond && A ｜｜ B` の式で A が空だと本番の値に落ち、staging 指定が本番へ deploy された (run 33699651244、同一コードのため実害なし)。commit c6bcb21 で Verify が遮断。再測: 未 | T-F-06 | L4 |
| PS-26 | 用意スクリプトの無言終了 (G-15) | `scripts/staging-bootstrap.sh <org>` を実行 | 途中で失敗したら **行番号つきで止まる**。exit 0 なのに何も作られていない状態を成功と見なさない | **FAIL→修正済 (2026-09-03)**: `tr ｜ head` の SIGPIPE × pipefail で 1 行目で無言終了し、何も作られないまま次の deploy に進んだ。commit 72fb2d0 で openssl rand + ERR trap。再測: 未 | T-F-06 | L4 |
| PS-27 | ローンチ前の全消去が同じコードで再構築できる (G-11) | `scripts/prelaunch-wipe.sh` を本番 (pre-launch) で実行 → deploy.yml と同じ seed が入り直る → PS-00〜05 を再実行 | バックアップが取れてから消える。消去後は auth.users / workspaces / projects / storage.objects が seed 以外 0 件。再構築後に /health 200・signup/signin・バケット PUT が通る (ローンチ判定 T-I-24 の前提) | 未 (ローンチ直前に経営者が実行。手順 docs/prelaunch-wipe.md) | T-D-24 | L4 |

## 恒久対策（INFRA-3 / production readiness）
1. ✅ **schema/verification 分離**: t-d-31/32 に `@verification-only` マーカーを付与し本番から除外（PR #276）。
2. ✅ **deploy に schema-only 冪等適用ステップを追加**: `apply-migrations.sh` の `SCHEMA_ONLY=1` を
   deploy.yml から実行（`PROD_DATABASE_URL` secret があるときのみ）。使い捨て DB で
   「37 適用→再適用で冪等→workspace insert でトリガ動作」を実証済み（PR #276）。
3. ✅ **完了 (2026-07-15)**: `PROD_DATABASE_URL` を GitHub secret 登録 → 再 deploy で
   `37 applied / 2 skipped (SCHEMA_ONLY=1)` を実行、本番スキーマ同期完了。
   PS-20/21 が本番実測 201 で PASS 化（旧 INFRA-3 500 が解消）。
   - 副作用対応: DB パスワード reset に伴い Fly の `ATELIER_DB_URL`/`DATABASE_URL` も新パスワードへ更新（signin 復旧）。
   - ⚠ 未解決の製品ギャップ **#27**: 新規 WS に AI 社員を追加する API/フローが無く、
     新規ユーザーがチャットを開始できない。テンプレからの「hire」エンドポイント実装が別途必要（PS-22〜24 の解除条件）。
   ```bash
   # Supabase Dashboard → Connect → Session pooler の URL (postgresql://...) を取得し:
   gh secret set PROD_DATABASE_URL --repo engine-base/Atelier   # 値を貼る
   gh workflow run deploy.yml --ref main                        # 再deploy でマイグレーション適用
   ```
4. 上記 3 完了後に PS-20〜24 を実ブラウザで実走し本欄を PASS 化する（実 AI チャットは
   フルスタックで実証済み＝RESULTS v22。本番でも同一コードで動く）。
