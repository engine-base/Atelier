# Design Audit 進捗台帳 — 全 42 画面の監査ロールアップ（正本）

> 目的: 画面単位監査 (モック忠実化 + 実 API 配線 + 実操作検証 + レスポンシブ) の
> 進捗・検出欠陥・証跡を 1 か所に集約する。個別詳細は `apps/web/.qa/test-specs/screens/<ID>.md` の
> design-audit v2 節、機能欠落は `docs/gap-tracker.md`、機械判定は
> `human-grade-qa/completion_gate.sh` が正。
>
> 状態: **42/42 画面 完了 — design-audit v2 ラウンド全画面完走** / ゲート実測: 全 TC 547 (PASS 534 / BLOCKED 13 / FAIL 0 / 未 0)。
> **completion_gate 判定: 完了** (画面台帳一致 — 仕様書なし画面 0、GAP-101 解消)。
> ※ 正準台帳 (04_functional_breakdown/screens.json) の 35 画面 + 横断ユーティリティ 5 (T-UC-36〜40 = S-U01/U02 ほか)。残 2 は監査済み画面のエイリアス (S-A04→S-A03 内 AI 学習設定 / S-D01→S-E01 スレッド一覧、S-G02→成果物一覧は B02/B03/G01 で被覆、S-AD01/02→S-T01〜06)。

## 監査済み画面 (42) — 各画面とも 実操作全 PASS / vitest / tsc / lint 緑で commit 済

| # | 画面 | ラウンド成果 (検出 → 是正) | 実操作 | commit |
|---|---|---|---|---|
| 1 | S-F01 工程 | タブ切替不能・9 工程ステッパー・詳細/サイドレール再構築、phase 名日本語⇄英語キー不整合の実バグ修正 | 全 PASS | ~813cf8f 以前 |
| 2 | S-E01 チャット | 死にボタン 4 (添付//コマンド等) 検出 → メンション/ナレッジ参照を本実装・撤去+GAP-001/002。エラー二重表示修正 | 全 PASS | 2f38c5c |
| 3 | S-B02 プロジェクトダッシュボード | KPI/フィード/承認カード/成果物を全領域実データ化 (GAP-005) | 全 PASS | cbc10f3 |
| 4 | S-B01 プロジェクト一覧 | 実工程バッジ・相対時刻・モーダル Escape 追加 | 全 PASS | 64b41aa |
| 5 | S-I01 タスクボード | 選択一括再生/ツールバー/分類グループ/リスト表を実 API 配線 (GAP-006) | 全 PASS | 813cf8f |
| 6 | S-J01 承認インボックス | KPI 実算出・カテゴリチップ・詳細ペイン (工程チェック→note 永続) 新設。決裁の DB 突合 | 9/9 | bbb6133 |
| 7 | S-C01 AI社員組織図 | disabled「リスト」トグル→実装、生 UUID スキル→GET /skills 新設で名前解決 (contract-first) | 9/9 | 876092f |
| 8 | S-C02 AI社員編集 | 死にタブ 2 + disabled ボタン 2 検出 → ナレッジタブ/Lucide ピッカー実装 (icon が組織図へ波及)、保存後 dirty 残留バグ修正 (GAP-008/009) | 10/10 | b394841 |
| 9 | S-K01 ナレッジ | 死に検索/リスト/複製→実装、実バグ 4 (子重複表示/パネル 0 幅列/無限再帰/WS 行き止まり) 修正、Markdown 描画 (GAP-010〜012) | 15/15 | 5af911e + 03ccf03 |
| 10 | S-K02 ナレッジ昇格 | 偽装却下 (リロード復活) → 実 DELETE、編集して採用 (PATCH→promote) 実装、DB 突合 (GAP なし追加) | 13/13 | 8d2c7da |
| 11 | S-O01 自動スケジュール | **到達不能画面** (導線ゼロ) → ナビ追加。upcoming 時系列/カテゴリ群/cron 日本語ラベル実装 (GAP-013/014) | 10/10 | 869e04f |
| 12 | S-M01 議事録 | D&D 非対応・accept 矛盾・履歴皆無 → 実装。storage 503 の明示エラー化 (GAP-015)。**追記: Whisper worker 不在をユーザー指摘で検出 (GAP-016) — UI は完成だがパイプ終端が未実装** | 9/9 | 44389d0 |
| 13 | S-B03 プロジェクト設定 | **死に入力 (クライアント名: 保存が黙って捨てられる)**・種別 select 欠落 → openapi 契約拡張 (client_name/type) で貫通。**実バグ 2 (draft が保存で「進行中」に化ける / AI 学習トグルが GET 実値を無視し常に OFF)** 修正。死にボタン 5 (エクスポート) → 実 /outputs 配線。偽トグル撤去 (GAP-017)。削除 2 段階化。仕様書新規作成 (GAP-101 を 1 枚解消) + S-E01 の未実施 2 行も実走決着 (planned=0) | 17/17 | 47f4f2e |
| 14 | S-B04 シークレット | **作成者列欠落** → openapi 契約拡張 (created_by_name, users join)。**生 ISO 日付表示 (鉄則5 違反)** → YYYY-MM-DD 整形。**reveal 失敗の握り潰し** → 明示エラー。**確認なし即削除** → 2 段階化。web テスト 0 本 → 9 件新設。暗号化 DB 突合・reveal 監査ログ +1・RLS 実ユーザー越境=0 を実証。仕様書新規 (GAP-101 -1) | 16/16 | 6386ac5 |
| 15 | S-N01 商談ドラフト | **到達不能画面** (導線ゼロ・S-O01 と同型) → ナビ新設。**死にタブ 5** → 実タブ 2 (実件数バッジ) + doc_type 未対応 3 種撤去。**disabled placeholder 3 (Rule 10 違反)** → 修正依頼=チャット実リンク・PDF/送信撤去 (GAP-018)。**保存物一覧なし (リロードで全消失)** → GET /sales-docs 実一覧 + 版数 + 2 段階削除。仕様書新規 (GAP-101 -1) | 12/12 | 14e2812 |
| 16-19 | S-PUB01〜04 公開系 | **偽フォーム (PUB04: 削除申請の onSubmit が no-op)** → 実 API 配線し audit_logs 記録まで実証。**法令文書の正本乖離 (PUB01〜03: 正本 API があるのにハードコード縮約版、特商法は事業者名まで別物)** → LegalDocArticle で正本描画に統一。公開ヘッダー新設。見出し二重表示をスクショ目視で検出→修正。仕様書 4 枚新規 (GAP-101 -4) | 14/14 | ec3b91f |
| 20-25 | S-T01〜06 admin 系 | **共通シェル不在 (6 画面間の導線ゼロ)** → ダーク管理サイドバー AdminShell 新設 (モック準拠・モバイルはチップナビ)。**実バグ: スキル重複登録が 500** → 409 + 明示エラー (pytest 回帰追加)。**UI 断線: T06 削除 API があるのに削除ボタン不在** → 2 段階削除実装。**T05 390px はみ出し実バグ** → 集計 2×2/フィルタ折返し/表は自前スクロール。T01: KPI 欠落 (監査イベント24h) 追加・actor 生 UUID → メール解決。T05 死に select 撤去。非 admin 403 / CRUD / フィルタを DB 突合で実証。仕様書 6 枚新規 (GAP-101 全解消) | 24/24 | 00ea0e1 |
| 26 | S-A01 サインイン | **UI 断線: Magic Link API 実在なのにボタン不描画** → 配線 (存在秘匿通知 + audit_logs 突合)。同意文が平文 → 利用規約/プライバシー実リンク + 越境同意文言。フッター特商法も実リンク化。OAuth ボタンは API 不在で撤去 (GAP-020)。実サインアップ→自動サインイン→consents 3種/AI学習OFF を DB 突合。redirect 検証の偽陽性 (query マッチ) を TC 側でも検出→pathname 厳密化 | 11/11 | 003cbc7 |
| 27 | S-A03 WS 設定 | **死にタブ 7** → 実リンク化 (プラン撤去 GAP-021)。**UI 断線: WS 削除 API 実在なのに非表示** → 2 段階削除実装。**API 契約違反: GET /me が required の ai_learning_opt_out を返さない** → API 修正 (pytest 更新)。AI 学習トグルのレース (me 未解決で常に OFF) 修正。アイコン変更死にボタン撤去。サブタイトルの WS 名ハードコード是正。WS フォールバック追加。検証 WS 実作成→改名→招待→トークン→削除の DB 突合 | 11/11 | f8d7fff |
| 28 | S-F02 フェーズ管理 | 未使用の started_at/completed_at を期間表示化 (モック準拠)。状態遷移 select を PATCH→DB 突合(往復)で実証。AI 提案フェーズ/F-IMP01 影響範囲解析/per-phase タスク数「8/24」は供給 API 不在で honest 撤去 (GAP-022) | 7/7 | d68019e |
| 29 | S-G01 成果物ビューア | disabled「編集」死にボタン撤去 (GAP-023)。コメント status(未解決/解決) 配線 + 解決ボタン (PATCH)。返信インデント表示。作成者の生 UUID → ラベル化 (鉄則5)。コメントパイプを API で e2e 実証 (POST→GET→PATCH resolve→DB)。storage 503 は honest 表示 (iframe は dev 制約) | 9/9 | (this) |
| 36-40 | T-UC-36〜40 横断ユーティリティ | **到達不能 3 件是正**: TopBar に通知ベル (未読バッジ = approval-inbox pending 実件数・GAP-007 の導線部分を解消)・検索アイコン・プロフィール (アバター実リンク化) を新設。通知→承認への実リンク。切替 2 画面は listbox 実操作で localStorage 永続検証 (テキストクリック偽陽性を排除)。表示名変更 DB 突合・横断検索実ヒット・5 画面 390px。既読ボタン縦折れ修正 | 16/16 ×3 | (this) |
| 35 | S-L03 クライアントポータル | **R-T08 実バグ: client JWT が staff API で 401 でなく 500** (署名検証を通過し uuid cast で爆発) → decode_supabase_jwt で明示拒否 + pytest 回帰。ログアウト実装 (cookie 破棄→signin、Playwright 突合)。越境 403 (API+UI)・JWT 系統分離・ガード (リダイレクト/改ざん 401) を通しで実証。コンテンツ系は client read API 不在で honest (GAP-029) | 13/13 ×3 | (this) |
| 34 | S-L02 ポータルサインイン | **同意ゲート丸ごと欠落 (規約/プライバシー/越境・機密保持)** → 必須チェック 2 種 + 実法務リンク実装、未同意ブロックを DB 突合で実証。招待発行→署名→/portal の通しで used_at/R-T08 cookie 分離/410/401 文言を実証。招待プレビュー・同意永続は API 不在 (GAP-028) | 12/12 ×3 | (this) |
| 33 | S-L01 クライアント招待 | **死に入力 3 (表示名/有効期限/スコープ — API 全対応済みなのに黙って捨てられる)** → IssueInput で全配線 (DB 突合)。表示名列 (契約 client_display_name 未使用) 追加。失効 2 段階化。?project 無し行き止まり→useProjectId フォールバック。使用回数→使用日 (used_at 実データ) 置換・再送ボタン不描画 (GAP-027)。R-T08 平文不保存を DB 突合で実証 | 14/14 ×3 | (this) |
| 32 | S-I03 実行モニタ | **主機能欠落**: モックのフリートビュー (統計/要対応/進行中/順番待ち) が丸ごと無く単一 SSE ログのみだった → FleetMonitorContainer 新設 (lifecycle/dispatch で実分類・統計実算出)。カード上の承認/差戻/再試行 (DB 突合)。かんばんに導線追加 (到達不能是正)。担当/ステータス生コード→日本語化。ダークテーマ再現。Bridge 接続/一時停止/枠数/停止/キュー取消は API 不在で未描画 (GAP-026) | 18/18 ×3 | (this) |
| 31 | S-I02 タスク詳細 | **到達不能** (かんばんから詳細への導線ゼロ) → カード/リスト行を実リンク化。**UI 断線: approve/reject/retry API (x-screen-ids: S-I02) が UI 皆無** → 操作バー実装 (2 段階確認・状態限定描画)。**API 契約違反: Task.dependencies/prerequisites/blocks 欠落** → サービス修正 + 依存タブ新設。**実バグ: 実行 status 判定が completed 比較 (実 enum は succeeded) で永遠に灰色** → 修正 + 日本語ラベル。死にタブ 2 (入出力/添付) 撤去→モック準拠 5 タブ。担当 AI 生コード→表示名解決。コメント投稿実装。スコアサークル実データ化 (GAP-025) | 23/23 ×3 | (this) |
| 30 | S-H01 モックビューア | **到達不能画面** (導線ゼロ・S-N01 同型) → ナビ「モック」+ 一覧ピッカー新設。**UI 断線 2: バージョン履歴 (GET /mocks/{id}/versions 実在) とコメント (target_type=mock 対応済) が未実装** → 実 API 配線 (表示中マーク/note/旧版リンク/最新ピル/追加/解決)。修正依頼→チャット実リンク。storage 503 を全面エラー→frame 限定 honest 化 (パネルは稼働)。390px トグル縦折れ修正。**API 全体の構造バグ検出: read-your-own-write レース (commit がレスポンス送信後) → CommitBeforeResponseMiddleware で全エンドポイント是正** (pytest 5 件 + 3 連続 25/25 で実証)。編集/…メニューは API 不在で未描画 (GAP-024) | 25/25 ×3 | (this) |

横断整備: TopBar 死にワークスペースピッカー→実ドロップダウン / 通知ベル撤去 (GAP-007) /
偽アバター→GET /me 実配線 / 死にクリック総当たりスイープ 139 要素 (再実行可能) — 8993ecf。

## 横断で確立した検証プロトコル (全画面共通)

1. モック + 実装 1440/768/390 スクリーンショット (390 は目視監査 — S-K01/K02/O01 で計 6 欠陥を検出)
2. インタラクティブ要素台帳 (Rule 10: 実装 / 撤去+gap 起票 / ユーザー判断 の 3 分類。disabled placeholder 禁止)
3. Playwright 実操作 (`apps/web/.audit-*.mjs` — 再実行可能) + DB 突合 (psql)
4. vitest / tsc / ESLint (+ API 変更時 pytest / Ruff) 全緑
5. QA 仕様書 `screens/<ID>.md` に v2 節追記 → completion_gate.sh で台帳突合
6. 1 画面 = 1 commit + push、証跡スクリーンショットをユーザーへ送付

## 残り画面: なし — v2 ラウンド完走

- 次フェーズ候補: GAP-104 (e2e-journey-walkthrough 通し) の実施、GAP-016 (Whisper worker) の起票実装、CI Gate #6 実照合化 (GAP-102)

## 未解消 gap (正本: docs/gap-tracker.md)

- 機能 gap: GAP-001〜029 (29 件) — バックエンド API 不在により UI から撤去/未描画にしたもの。**GAP-016 (Whisper worker 不在) は S-M01 の主機能を塞ぐ最重要 gap**
- プロセス gap: GAP-101 (仕様書 13 画面) / GAP-102 (CI Gate#6 スタブ) / GAP-103 (tickets.json テンプレ AC)
