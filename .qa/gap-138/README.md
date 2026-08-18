# GAP-138 検証証跡 — モック作成フロー + キャンバス + LLM サブスク経路統一

構成: 実 PG + 実 API (relay) + 実 Bridge + 実 claude CLI (実サブスク)。

- e2e-generate.log — POST /mocks/generate (画面名 + 指示) → **実 claude が
  Bridge (= 本人サブスク) で生成** (meta model="relay")、mockdb 保存 25KB、
  content-url → 実 HTML 配信 (<!doctype html)。
- e2e-revise.log — 生成モックへの修正依頼 →「紺色ヘッダー + タイトル変更」が
  実 HTML に反映 (V2_HAS_NAVY/TITLE: True)、v2 が parent 連鎖。
- dashboard-v1.png / v2.png — 実生成モックのスクリーンショット
  (v2 はヘッダー紺 + 『Atelier ダッシュボード』 — 指示どおり)。
- 実バグ修正: off モードの relay ジョブが Bridge 起動 cwd で claude を実行して
  いたため、cwd がリポジトリだと .claude (hooks/CLAUDE.md) を拾い不安定に
  失敗 (exit=1・無出力を実測)。全モードで作業フォルダ cwd に固定して解消。

テスト: pytest 78 (affected 9 ファイル: llm_chain 4 追加 / mock_generate 4 追加 /
既存全通過) / bridge vitest 112 / web vitest bundle-h 138 (uc13 +4, 文言 1 改) /
ruff / pyright 0 errors / tsc クリーン。
