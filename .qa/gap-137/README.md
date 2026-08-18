# GAP-137 検証証跡 — チャット PC 操作の成果物をツール内モックへ自動反映

構成: 実 PG (54322) + 実 API (uvicorn, ATELIER_LLM_PROVIDER=relay) +
実 Bridge (dist/headless.js --loop, ユーザー PC 相当 /root/UserPCWork-e2e) +
実 claude CLI (実サブスク)。

- e2e-stream.log — 実 SSE: tool (Bash/Write) → artifact (mock_id/画面名/v1) → end。
  content-url が mockdb 自己署名 URL を返し、GET で実 HTML (title「料金ページ」) 配信。
  mocks 行は html_storage_path=mockdb://…, meta author=bridge。
- e2e-version-chain.log — 2 回目の依頼 (実 claude が Edit で上書き) →
  同一画面が v2 で連鎖 (parent_mock_id 付き)。versions API でチェーン確認。
- user-pc-price-page.html — 「ユーザー PC」側に実際に生成されたファイル。
- bridge-log-excerpt.txt — 実 Bridge の completed ログ。

テスト: pytest 30 (unit 10 + relay tools 3 + artifacts 統合 4 + 既存 relay 13) /
bridge vitest 112 / web vitest (uc08 21 + bundle-h) / ruff / pyright 0 errors。
