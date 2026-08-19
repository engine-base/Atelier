# GAP-174: 画面は正しく出ているのに赤い「エラーが発生しました（HTTP 409）」が出る

Excel / PDF の成果物を開くと、表もファイル名も正しく表示されているのに、
右下に赤い toast で **「エラーが発生しました（HTTP 409）」** が出ていた。

## 原因

成果物ビューアは `GET /outputs/{id}/anchors` (コメントを本文の位置に紐づけるための
id 属性の一覧) を必ず取りに行く。Excel / PDF (filedb) は**テキストではない**ので、
API は 409「バイナリ形式のファイルはテキスト差分を表示できません」を返す —
**これは正常な応答**で、画面も位置指定 UI を出さないだけで正しく描けている。

ところが `QueryCache.onError` が横断でグローバル toast を出す作りだったため、
**画面が正しく処理している想定内の状態まで赤い toast になっていた**。
「エラーが出ているのに画面は正常」という、利用者が最も混乱する状態。

## 修正

- `reportQueryError(error, source)` が query / mutation の `meta` を見るようにし、
  **`meta: { expectedErrors: true }` を宣言したものはグローバル toast の対象外**にした。
  条件は「画面側でその状態を必ず表示していること」。握りつぶしではない。
- 宣言したのは、画面が確実に描き分けている 4 か所だけ:
  - `/outputs/{id}/anchors` — Excel/PDF は 409 が正常 (位置指定 UI を出さない)
  - `/outputs/{id}/content-url` — storage 未設定 (503) / HTML 未生成 (409) は専用文言
  - `/outputs/{id}/content-url?format=…` — その形式が未生成なら 409 で専用文言
  - `/outputs/{id}/sheet` — PDF 等は 409 で「この画面では編集できません」を出す
- それ以外は従来どおり toast する (本当の障害を隠さない)。

## 証拠

- `174-excel-no-toast.png` — Excel 成果物 (御見積明細.xlsx) を開いた実ブラウザ。
  実測値: `ERROR_TOASTS: 0` / `SHEET_VISIBLE: 2` (= 中身は表示されている)。
  修正前の同じ画面は `.qa/gap-168/168-output-file-edit.png` の右下に
  「エラーが発生しました（HTTP 409）」が写っている (before/after の比較材料)。

## 自動テスト

- `tests/bundle-a/query-client.test.ts` (2 追加):
  `expectedErrors` を宣言したクエリの 409 は toast を増やさない /
  宣言していないものは従来どおり toast する

## 併せて見つけた未修正の点 (報告のみ)

Excel 成果物の画面上部に「HTML プレビュー」の**空の白い枠**が出る
(`174-excel-no-toast.png` で確認できる)。バイナリを HTML の iframe に流し込んで
いるため。表そのものはその下に正しく出ている。別途対応が必要。
