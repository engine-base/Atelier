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

## プロセス gap (計画・ゲートの構造欠陥)

| ID | 内容 | 現状 | 解消に必要なもの | 起票日 |
|---|---|---|---|---|
| GAP-101 | QA 仕様書の欠落 13 画面 | completion_gate.sh の画面台帳突合で検出: S-B03 / S-B04 / S-N01 / S-PUB01〜04 / S-T01〜06 (S-E01 は 2026-07-18 作成済、S-J01 は既存仕様に design-audit v2 節を追記済) | 各画面の監査ラウンドで `screens/<ID>.md` を作成 (design-audit の画面順に消化) | 2026-07-18 |
| GAP-102 | CI Gate #6 (mock-impl diff) がスタブ | 「Phase 0 なので構造のみ確認して PASS」のままファイル数を数えて常時 PASS | モック要素 ↔ 実装の実照合 (human-grade-qa の mock-fidelity 軸を CI 化) | 2026-07-18 |
| GAP-103 | tickets.json の UI タスク AC がテンプレコピペ | 全 UI タスクの tier_2 が同一文言で画面固有の actions が AC 化されていない (T-UC-08 と T-UC-09 が一字一句同じ) | task-decomposition 絶対ルール10 に従い screens.json の fields/actions/states を 1要素=1AC で転写する tickets.json 改訂 PR | 2026-07-18 |
