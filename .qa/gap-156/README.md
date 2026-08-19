# GAP-156: 既存プロジェクトの途中取り込み — 既存資料をツール形式へ + フロー現在地合わせ

経営者すり合わせ (2026-08-18):
「既存プロジェクトのアップロードで途中からでも。既存資料をツールの形式に
当てはめられる状態に」

## 実装 (どこで動くか: SaaS クラウド側。LLM 不使用 = 費用ゼロ・決定的な仕分け)

- **POST /projects/{id}/import** (一括・最大 30 ファイル):
  Bridge のチャット成果物取り込み (GAP-137/139/145) と同じ変換機構を Web の
  一括アップロードに開放。
  - HTML → 内容とファイル名で**モック / 見積書・提案書・テスト仕様書等の成果物へ
    自動仕分け** (GAP-139 の決定的規則)
  - Markdown / テキスト → 閲覧可能な HTML に包んで成果物へ (内容不変 — 変換偽装なし)
  - 画像 / PPTX / PDF / Excel / 動画 → filedb ファイル成果物 (GAP-145)
  - すべて **現在フェーズ (active) にスタンプ** (GAP-152) — 確定フェーズには入らない
  - 1 ファイルの失敗で全体を落とさない (per-file の honest エラー: 非対応形式・
    サイズ超過等)
- **フロー現在地の提案 → ユーザー確定**: 取り込めた資料の種類から
  「もう終わっている工程」(suggested_stage_keys — 現在フェーズの pending のみ・
  フロー順) を提案。**自動では反映しない** — UI のチェック + 「N 工程を完了として
  反映」で既存の flow complete API を叩く (明示確定なので hard gate も confirm)。
- **UI**: プロジェクトナビに「取り込み」を新設 (/import)。ファイル選択 →
  per-file の仕分け結果 → 提案チェック → 確定反映 → 進行タブへの導線。

## 証拠 (実 e2e)

- `gap156-results.png` — 4 ファイル (md/HTML モック/HTML テスト仕様書/PNG) の
  実仕分け結果 + 「要件定義・デザイン/モック・検証」の完了提案
- `gap156-applied.png` / `gap156-flow-after.png` — 確定反映 → 進行タブで
  ✓要件定義 ✓デザイン・モック ✓検証 (現在 = 構想・ヒアリング のまま)
- `e2e-api-evidence.txt` — 反映後フローの実状態 / 取り込み成果物が現在フェーズ
  (フェーズ2) にスタンプ (フェーズ1 の既存成果物と分離) / モック v1 実在
- `shot-gap156.mjs` — 撮影スクリプト。備考: Playwright の setInputFiles が
  この環境では日本語ファイル名を渡せないため撮影は ASCII 名を使用 (製品側は
  日本語ファイル名対応 — API テスト「見積書.html」で検証済み)

## テスト (実 Postgres)

- `tests/routes/test_projects.py::TestGap156Import` — HTML→モック/estimate 成果物、
  MD→requirements 成果物、PNG→ファイル成果物、zip→per-file honest エラー、
  提案 = 取り込めた種類 × フロー順、提案は自動反映されない → ユーザー確定で
  flow complete、RLS 不可視 404 (11/11 PASS)
- web `import-container.test.tsx` (2): base64 ペイロード/結果表示/確定反映
  (confirm: true)/チェック解除の不反映
- ruff / pyright / tsc / next lint クリーン
