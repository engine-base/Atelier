# GAP-141 検証証跡 — ローカル⇄クラウド二重化の解消 (workspace seed)

問題 (経営者指摘): チャット PC 操作はローカルフォルダに、正本は Supabase に —
二重化するとローカルの古いファイルを土台に編集され版連鎖が乱れる。

解法: **ローカル = 正本のチェックアウト**。ツールジョブ開始前に Bridge が
GET /chat-relay/{job}/workspace でプロジェクト最新版 (モック各画面 +
mockdb 成果物) を取得し、作業フォルダへ上書き展開してから CLI を起動。
展開後にスナップショットするので未編集の seed は再取り込みされない。

- e2e-seed.log — **空の作業フォルダ**で実行:
  seed が 3 ファイル (price-page.html=料金ページ v2 / quote.html=見積 /
  ダッシュボード.html) を実体化 → 実 claude が Read/Edit で追記 →
  **料金ページ v3 として正しく連鎖** (VERSION_CHAIN [1,2,3])、
  追記 (id="seed-e2e") と元の内容の両方を新版で確認。
- パス逸脱 (../evil.html) は basename 化で workspace 内に封じ込め (unit test)。
- seed 失敗はジョブを止めない (従来動作で続行)。

テスト: pytest +1 (最新版のみ返す/401) / bridge vitest 114 (+2: 展開+
未編集 seed 非取り込み+順序 / off ジョブは seed しない) / ruff / pyright 0。
