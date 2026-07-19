# Gap Tracker — design-audit で確定した未実装/未整備の正本

> CLAUDE.md ルール12 準拠: 「あとで」「placeholder」を口にした時点で登録する台帳。
> 各項目は解消 PR で本ファイルからチェックを付けて消し込む。黙って消さない。

## 機能 gap (バックエンド未実装のため UI から要素を撤去したもの)

| ID | 内容 | 現状 | 解消に必要なもの | 起票日 |
|---|---|---|---|---|
| GAP-001 | S-E01 チャット添付 | ボタン未描画 (Rule 10: 死にボタンで置かない) | チャット添付アップロード API + storage 配線 + messages への添付関連付け | 2026-07-18 |
| GAP-002 | S-E01 /コマンド | ボタン未描画・placeholder 文言からも削除 | コマンド体系の設計 (例: /summary, /タスク化) + API + コマンドパレット UI | 2026-07-18 |
| GAP-003 | S-F01 確定事項の「ピン留め」操作 | 表示のみ (モックにあるピン操作は未実装) | decisions への pin フラグ + PATCH 配線 | 2026-07-18 |
| GAP-004 | phases への担当 AI 社員割当 | S-F01 ヘッダーのアバターはスレッド/確定事項からの実集計で代替中 | phases.assignee 群 or phase_assignments テーブル | 2026-07-18 |
| GAP-005 | S-B02 の「未解決コメント」KPI | 「確定事項」KPI に置換して表示中 | プロジェクト横断の未解決コメント集計 API (comments は target 単位のみ) | 2026-07-18 |
| GAP-006 | S-I01 の「依存グラフ」ビュー | 表示トグル自体を出していない | タスク依存 (depends_on) の API 公開 + グラフ描画 | 2026-07-18 |
| GAP-007 | TopBar の通知ベル (通知センター) | ボタン未描画 (死にクリック総当たりスイープで検出 → 撤去) | 通知 API (一覧/既読) + 通知生成イベント設計 + ドロップダウン UI | 2026-07-18 |
| GAP-008 | S-C02 の「活動履歴」タブ + 「最近の活動」カード | 未描画 (per-employee 活動 API が存在しない。executions/audit_logs に employee 紐付けの公開 read なし) | AI 社員別活動フィード API (tasks/decisions/executions の employee 横断集計) | 2026-07-19 |
| GAP-009 | S-C02 の「画像アップロード」(アイコン画像) | ボタン未描画 (storage アップロード API 未提供。「Lucide から選ぶ」は実装済で icon 変更自体は可能) | アイコン画像 storage アップロード + ai_employees.icon への URL 格納 + 描画 | 2026-07-19 |
| GAP-010 | S-K01 の「グラフ」ビュー | トグル未描画 (グラフ描画・ノード関係 API 未実装) | ナレッジ間リンク構造の API + グラフ描画コンポーネント | 2026-07-19 |
| GAP-011 | S-K01 の「Obsidian で開く / Vault に書出」 | ボタン未描画 (Obsidian 連携 API 不在) | Vault export API + URI scheme 連携 | 2026-07-19 |
| GAP-012 | S-K01 の「バックリンク」セクション | 未描画 (参照元逆引き API 不在。関連ナレッジ(RAG) は実装済) | knowledge 参照元 (tasks/ADR/機能仕様) の逆引き API | 2026-07-19 |
| GAP-013 | S-O01 の「実行履歴」テーブル | 未描画 (cron 実行履歴 API 不在) | cron 実行結果の記録テーブル + 一覧 API | 2026-07-19 |
| GAP-014 | S-O01 の「法令・運用バックエンド (必須)」セクション | 未描画 (プラットフォーム必須ジョブの可視化 API 不在 — 偽の稼働状況を出さない) | 退会データ削除等プラットフォームジョブの実装 + read-only 可視化 API | 2026-07-19 |
| GAP-015 | S-M01 の解析結果構造化 (サマリー/話者分離/要件抽出/アクションアイテム) | 文字起こし本文のみ表示 (構造化解析 API 不在。モックのナターシャ/スティーブ解析ブロックは未描画) | 議事録構造化解析 API (要約・話者分離・要件抽出) + 要件承認フロー連携 | 2026-07-19 |
| GAP-016 | **議事録パイプラインの Whisper worker が全リポジトリに不在** | POST /transcribe は DB に queued と書くだけ (`transcripts/queued/` を消費するコードが存在しない)。storage を設定しても parsed_at は永遠に立たず、アップロードは必ずタイムアウトする。原因: T-A-38 が API endpoint のみを scope し「外部バックエンドジョブ」が未起票 (GAP-103 と同型の分解漏れ) | Whisper 呼出 worker (queue 消費 → OpenAI audio API → parse_result_path へ書込 → parsed_at 更新) の起票と実装。GAP-015 (構造化解析) の前提 | 2026-07-19 |

## プロセス gap (計画・ゲートの構造欠陥)

| ID | 内容 | 現状 | 解消に必要なもの | 起票日 |
|---|---|---|---|---|
| GAP-101 | QA 仕様書の欠落 13 画面 | completion_gate.sh の画面台帳突合で検出: S-B03 / S-B04 / S-N01 / S-PUB01〜04 / S-T01〜06 (S-E01 は 2026-07-18 作成済、S-J01 は既存仕様に design-audit v2 節を追記済) | 各画面の監査ラウンドで `screens/<ID>.md` を作成 (design-audit の画面順に消化) | 2026-07-18 |
| GAP-102 | CI Gate #6 (mock-impl diff) がスタブ | 「Phase 0 なので構造のみ確認して PASS」のままファイル数を数えて常時 PASS | モック要素 ↔ 実装の実照合 (human-grade-qa の mock-fidelity 軸を CI 化) | 2026-07-18 |
| GAP-103 | tickets.json の UI タスク AC がテンプレコピペ | 全 UI タスクの tier_2 が同一文言で画面固有の actions が AC 化されていない (T-UC-08 と T-UC-09 が一字一句同じ) | task-decomposition 絶対ルール10 に従い screens.json の fields/actions/states を 1要素=1AC で転写する tickets.json 改訂 PR | 2026-07-18 |
| GAP-104 | 通し (e2e-journey-walkthrough) が一度も実行されていない | GAP-016 (Whisper worker 不在) を全テストレイヤーが素通りした構造原因の 1 つ。pytest は「queued と書けたか」だけ、vitest はモッククライアントで polling 契約だけを検証し、実際に 1 本通せば初回アップロードのタイムアウトで即検出できた。通しは「human-grade-qa 完了後の最終関門」として後置されたまま未実施 | 主要ジャーニー (登録→プロジェクト→議事録→承認→納品) の e2e-journey-walkthrough 実施。画面監査完了を待たず主要 1 本を先行実施する (スキル絶対原則 9.5 に反映済) | 2026-07-19 |
