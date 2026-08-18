# GAP-139 検証証跡 — チャット成果物の自動仕分け (モック / 見積・提案書等)

経営者指摘「HTML だから全部モック、は違う。見積も提案書も HTML の場合がある」
への対応。種類判定 (title → ファイル名 → 直近のユーザー指示、決定的規則) で
mock → mocks / それ以外 → workflow_outputs (S-G01 成果物、stage 別) に振り分ける。

- e2e-estimate.log — 実 claude (実 Bridge / 本人サブスク) に「お見積書 HTML を
  作って」→ quote.html 生成 → **type=output / stage=estimate として
  workflow_outputs に取り込み** (mocks には入っていないことも確認) →
  outputs content-url (mockdb 自己署名) で実 HTML 配信。
- チャットカードは種類ラベル (見積書/提案書/テスト仕様書/モック…) +
  適切なリンク先 (/outputs?output= or /mocks?mock=) を表示。

テスト: pytest 57 (classify 4 追加 / estimate 振り分け統合 1 追加 / 既存全通過) /
web vitest uc08 23 (output カード + 後方互換 2 追加) / ruff / pyright 0 / tsc。
