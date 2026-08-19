# GAP-161: 添付・参考資料を AI が実際に読む (画像/PDF/Excel/Word/PowerPoint)

経営者指摘 (2026-08-19):
「しかもデザインモックも、このテンプレもだけど画像や PDF やファイルやエクセルを
 アップロードしてそれを参考にすることがチャットでできていないけどどうして？？」

## 原因 (実バグ)

チャットの添付は **保存と画面表示だけ** で、**LLM に一切渡っていませんでした**
(`chat_messages.attachments` に入るが system prompt にもユーザー文にも入らない)。
さらに Excel/Word/PowerPoint は添付の許可形式にすら入っていませんでした。
モックスタジオ・テンプレスタジオには資料を渡す口自体がありませんでした。

## 実装

1. **サーバー側でテキスト抽出** (`services/attachments`) — PDF / Excel / Word /
   PowerPoint / CSV / テキストを **LLM を使わず決定的に** 抽出。追加費用ゼロで、
   Bridge (本人サブスク) / サブスク / API の**どの実行経路でも同じに効く**。
2. **チャットへ注入** — 現在のメッセージ + 直近 6 メッセージ分の添付 (最大 5 件) を
   「# 添付資料」ブロックとして system prompt に入れる。「さっき送った資料を見て」が成立する。
3. **正直な degrade** — 取得失敗・未対応形式・壊れたファイルは「取り込めませんでした」と
   明示し、**画像は内容を推測しない**と明記する (でっち上げ防止)。
4. **許可形式を拡張** — Excel(xlsx/xls) / Word(docx) / PowerPoint(pptx) を追加 (API・Web 両方)。
5. **スタジオの参考資料** — `POST /reference-uploads` を新設し、モックスタジオ (ワンダ) と
   デザインテンプレスタジオに「参考資料を追加」を設置。渡した資料は生成/改訂の
   system prompt に「# 参考資料」として入る (「この請求書の様式に寄せて」が可能に)。
6. **画像は Bridge 経路で実物を渡す** — ジョブ作業場 seed (GAP-141) を拡張し、
   スレッドの添付を base64 で配布。本人の PC で走る Claude Code が画像/PDF を直接開ける。

## 証拠

### 実 HTTP 全経路 (`curl-evidence.txt`)

実ファイル (見積内訳.xlsx) を **実 API でアップロード → 実 storage → 抽出 → prompt**:

```
## 見積内訳.xlsx（…spreadsheetml.sheet / 1 シート）
## シート: 見積内訳
項目 | 数量 | 単価 | 金額
要件定義 | 1 | 400000 | 400000
デザイン | 1 | 350000 | 350000
実装 | 2 | 600000 | 1200000
```

未対応形式 415 / サイズ超過 413 / storage 未設定 503 も実測。

**但し書き (正直な記載)**: この環境には Supabase Storage が無いため、storage だけ
**Supabase 署名 API 互換のローカルスタブ**を立てて実 HTTP で往復させています
(署名発行・PUT・GET は実通信)。抽出と prompt 注入は本番と同一コードです。

### 実ブラウザ (`161-template-reference.png` / `161-mock-studio-reference.png`)

```
TEMPLATE_PICKER: 1        TEMPLATE_UPLOADED_CHIP: 1   ← 実ファイルを実 PUT して添付済チップ表示
MOCK_LINKS: 5             MOCK_STUDIO_PICKER: 1       ← ワンダのパネルにも同じ口
```

## 自動テスト

- API `tests/services/test_attachments_extract.py` (5): Excel/Word/PowerPoint/PDF/CSV の
  実ファイルからの抽出、画像は推測しない、壊れたファイル・未対応形式は正直に、
  ブロック文面に「推測で補わず」が入ること
- API `tests/routes/test_chat_sse.py::TestGap161AttachmentsReachTheAI` (2):
  Excel 添付の**中身**が system prompt に入る / 取得できない添付は「取り込めませんでした」
- API `tests/routes/test_outputs.py` の参考資料テスト (1): スタジオに渡した Excel の
  中身がワンダの system prompt に入る
- Web `tests/bundle-h/reference-file-picker.test.tsx` (3): 署名 URL → 実 PUT → 親へ受け渡し /
  失敗は正直に出して追加しない / 未対応形式は上げる前に断る
- Bridge vitest 118 PASS (seed の base64 分岐追加後の回帰)
