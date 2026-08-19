# GAP-154: 出力テンプレート — workspace 単位・種類ごと自作・生成時に必ず注入

経営者すり合わせ (2026-08-18):
「見積もりとか出力のテンプレは自作できる形にして基本的にそれを使う。
ワークスペース単位でつけるべきかな」→ 決定: **workspace のみ**。

## 実装 (どこで動くか: SaaS クラウド側 — API + DB + Web。管理は人間、注入は自動)

- **output_templates テーブル** (`gap-154_output_templates.sql`): workspace × 種類
  (workflow_stage_enum = 成果物の stage 体系、14 種: 見積書/提案書/請求書/契約/NDA/
  議事録/要件定義書/テスト仕様書/納品書 等) で 1 件 (upsert)。RLS member。
- **「基本的にそれを使う」を構造で保証** (任意参照ではなく自動注入):
  1. **チャット生成** — 全チャットの system prompt に現在工程 (active フェーズの
     current stage) のテンプレを注入。「必ずこの構成・項目・書式に従うこと。
     独自構成へ勝手に変えないこと」の契約文つき (GAP-147 と同じ契約先行の設計)。
  2. **スティーブ改訂 / AI 修正提案の承認適用** — その成果物の種類のテンプレを
     system prompt に注入 (revise_output 経由の全経路)。
- **API**: GET/PUT/DELETE `/workspaces/{id}/output-templates[/{stage}]`
  (未知の種類 404 / 他人の workspace は RLS 404 / 削除で「テンプレ無し生成」に復帰)。
- **UI**: ナビ「WS設定」の実体ページを新設 (従来はリンク先未実装のデッドリンク)。
  種類ピッカー (設定済みバッジ) + Markdown エディタ + 保存/削除。

## 証拠 (実 e2e)

- `gap154-editor.png` / `gap154-saved.png` — WS設定 UI から議事録テンプレを作成・保存
  (「設定済み — 生成時に必ず使用」バッジ)
- `e2e-api-evidence.txt` — UI 保存された実データが GET で返り、**実チャットの
  system prompt (context-preview) に「# 出力テンプレート: 議事録・ヒアリングメモ
  （社内標準 議事録）」+ 本文が注入されている実測**
- `shot-gap154.mjs` — 撮影スクリプト (Playwright 実ブラウザ)

## テスト (実 Postgres)

- `tests/routes/test_outputs.py::TestGap154OutputTemplates` (3):
  CRUD/upsert/未知種類 404/RLS 404/削除復帰、**スティーブ改訂の system prompt に
  テンプレが入る (capture クライアントで実測)**、**チャット context-preview に
  現在工程のテンプレが入る**
- web `output-templates.test.tsx` (3): 設定済み/未設定バッジ・保存 PUT・削除通知
- 回帰: outputs + chat_sse 27 PASS、ruff / pyright / tsc / next lint クリーン
