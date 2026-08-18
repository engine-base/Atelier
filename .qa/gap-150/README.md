# GAP-150: プロジェクトフロー — COO ハブ&スポーク + ステージゲート + フロー起点チャット

## 経営者との設計すり合わせ (承認済み)

「どの社員も自由に使えると逆にやりづらい。基本は COO と会話し、COO が必要な
社員へ繋いで引き継ぎ、終わったら COO に戻る。プロジェクトをどういう順番で
進めるかのフローが基本。スキップできるものもある。チャットのタブも自由という
より、そこの話を進めるか、前の工程の更新・変更のやり取りか」
→ 合意した設計: **フローが背骨、COO がハブ、自由チャットは例外**。
強制はソフトゲート基本 + 致命工程 (契約・納品) のみハードロック。

## 実装

1. **DB (gap-150 migration)**: project_flow_stages — project × stage_key、
   状態は pending/done/skipped の 3 値のみ。「現在のステージ」= 最小 seq の
   pending として**導出** (遷移状態を持たない = 差し戻しも単純 update で整合)。
   RLS: workspace member 可視/更新、削除は service のみ。
2. **フロー・テンプレ** (services/flow): 受託 (client_work) = 商談・ヒアリング →
   提案* → 見積* → 契約† → 要件定義 → アーキ設計* → デザイン・モック →
   タスク分解・実装 → 検証 → 納品・請求† (* = skippable / † = hard_gate)。
   社内/個人 = 商流 3 工程なしの 7 ステージ。担当は部門 → workspace の
   代表社員 (is_default 優先) で解決 — COO = executive (ジャービス)。
3. **API**: GET /projects/{id}/flow (未初期化なら自動生成) /
   {stage}/complete (hard_gate は confirm=true 必須・403) /
   {stage}/skip (skippable のみ・理由必須・hard_gate 403) /
   {stage}/reopen (差し戻し — 後続の完了実績は保持)。全操作 audit。
4. **チャット注入** (flow_context_block): 全社員の system prompt に
   「✓ 1. 商談・ヒアリング (担当: スティーブ) / ● 2. 提案 ← 現在のステージ …」
   + 「担当外の依頼はフロー上の担当社員への切替を案内すること」— COO も
   各社員も進行状況を知った状態で応答・案内する。
5. **UI (FlowRail — チャット左ペイン最上部に常設)**:
   - ✓/⤼/●/○ の実状態 + 担当社員名。クリックで担当のスレッドへ (無ければ作成)
   - **ソフトゲート**: 順序外は「先に「◯◯」が残っています。それでも開きますか？」
   - 現在ステージに「完了」(hard_gate は赤の承認パネル「致命工程です。承認しますか」)
     と「スキップ」(理由入力必須・記録)。完了済みは hover で「差し戻し」
   - 完了直後は「**次は「◯◯」 — △△に繋ぎます 開く →**」の引き継ぎバナー (COO 案内)

## 実ブラウザ証跡

- flow-rail.png: 初期状態 — ● 構想・ヒアリング (現在) + ○ 以降 + ワンダ担当表示
- flow-handoff.png: 完了クリック後 — ✓ 構想・ヒアリング / ● 要件定義 (完了ボタン付き) /
  バナー「次は「要件定義」 開く →」。DB 実測: hearing=done, current=requirements。
- 実バグも発見・修正: connector.sendJson は {data} envelope を剥がして返す仕様で、
  二重に .data を読んで空配列になりフローが消える (実ブラウザで検出 → 修正 → 再実証)。

## テスト

- API: tests/routes/test_flow.py — 自動初期化 (10 工程/順序/hard_gate/担当解決) /
  完了で current 移動 / スキップ規則 (理由必須・hard_gate 403・非 skippable 409) /
  confirm=true で契約完了 / 差し戻し (後続保持) / 不可視 404 / チャット注入。
  chat_sse 含め 15 PASS。ruff / pyright 0。
- Web: flow-rail.test.tsx 6 本 (表示/現在から話す/ソフトゲート/hard_gate 承認/
  スキップ理由/差し戻し) + bundle-h+a11y 全 173 PASS。tsc 0。

## どこで動くか / 誰の費用か

すべて SaaS クラウド側 (DB + FastAPI + Web)。LLM 追加費用なし (注入は既存
チャット文脈の一部)。
