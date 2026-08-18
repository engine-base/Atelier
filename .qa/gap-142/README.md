# GAP-142 検証証跡 — モックスタジオ (Open Design 型 UI)

経営者指摘「モックの画面が Open Design の UI/UX で徹底されていない。
チャットパネル + 要素選択を再現しろ」への対応。実物
(https://github.com/nexu-io/open-design — Claude Design の OSS 代替) を確認:
中核は **Studio = 会話 + ライブプレビューを 1 画面に統合**。これを S-H01 に実装。

- MockViewer を 3 ペイン化: 左 = 「ワンダとデザイン」会話パネル
  (バージョン履歴を「指示 → ワンダが vN を作成」の会話として表示 + 指示入力
  + 要素選択トグル + 選択チップ)、中央 = ライブプレビュー、右 = 履歴/コメント。
  旧「編集」ボタン + ダイアログは廃止 (常設パネルに置換)。
- 要素クリック選択: mockdb 配信 (?sel=1) に選択スクリプトを注入 —
  hover で紫点線ハイライト、クリックで postMessage
  {type:'atelier-element-selected', selector, label, html} を親へ。
  選択中はチップ表示、送信時に指示へ CSS セレクタ + ラベル + HTML 断片を添付。
- e2e-selection.log + selection-hover.png — **実ブラウザ**で実モック
  (実 claude 生成のダッシュボード) に対し hover ハイライト + クリックで
  実 postMessage (selector/label/html の実値) を確認。

テスト: web vitest bundle-h+a11y 161 PASS (スタジオ 3 追加 + 旧編集テスト 2 改 +
a11y 修正) / pytest 21 (注入 unit 2 + sel=1 統合 1 追加) / ruff / pyright 0 / tsc。
