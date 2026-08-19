# GAP-176: Excel / PDF 成果物を HTML の iframe に流し込んでいた（空の白枠）

経営者指摘:「出てきたものも修正して / iframe なんで？？」

`.qa/gap-174/174-excel-no-toast.png` に写っていたとおり、Excel 成果物の画面に
**空の白い枠**が出ていた。原因は、成果物ビューアが `activeFormat === "html"` の
とき**中身が何であっても iframe に URL を流し込む**作りだったこと。
Excel も PPTX も画像も、全部「HTML プレビュー」として空の iframe になっていた。

## 修正 (contract-first)

サーバーは中身の種別を知っているのに、それを画面へ渡していなかった。
そこを契約から直した:

1. `07_api_design/openapi.yaml` の `ContentUrl` に **`kind` / `file_name` / `mime`** を追加
   (`kind`: html / pdf / image / sheet / binary)。`scripts/sync-types.sh` で
   TS と Pydantic を再生成。
2. `GET /outputs/{id}/content-url` が filedb 成果物の実体 MIME から `kind` を返す。
3. 画面は `kind` で描き分ける:
   - **sheet (Excel/CSV)** … iframe を出さない。「下の表で確認・編集できます」と
     案内し、実体の表は既存の SheetEditor が描く
   - **image** … `<img>` で表示 (iframe ではない)
   - **pdf** … iframe のまま (ブラウザ内蔵ビューアで読める)。題を「〜（PDF）」に
   - **binary (PPTX/動画 等)** … 「この画面で表示できない形式です」+ 原本/DL 導線
   - **html** … 従来どおり
4. 形式タブと副題のラベルも種別に合わせた (**Excel を「HTML」と呼ばない**)。

## 実測 (実 API + 実ブラウザ)

```
CONTENT_URL_KIND: sheet | file_name: 御見積明細.xlsx | mime: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
IFRAME_COUNT: 0        ← 空の白枠が消えた (修正前は 1)
SHEET_NOTICE: 1        ← 「表計算ファイルです」の案内が出ている
TABLE_CELLS: 16        ← 実体の表は従来どおり編集できる
ERROR_TOASTS: 0
```

- `176-excel-no-empty-frame.png` — 修正後。タブが「HTML」→「**表計算**」、
  副題が「v1・**表計算** プレビュー」、空枠の代わりに案内文、下に実体の表。
- 修正前は `.qa/gap-174/174-excel-no-toast.png` (同じ画面に空の白枠と「HTML」)。

## 自動テスト

`tests/bundle-h/uc12-output-viewer.test.tsx` (5 追加、コンテナ経由 = 実 API 応答の形):
Excel は iframe を出さず案内を出す / 画像は `<img>` / PDF は iframe で題に PDF /
表示不可形式は原本・DL へ誘導 / `kind` の無い応答 (HTML 成果物) は従来どおり iframe
