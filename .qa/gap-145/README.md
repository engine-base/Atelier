# GAP-145: 成果物の全形式対応 — 画像 / PPTX / PDF / Excel / 動画 等 (Q1 実装)

## 経営者指摘

「なんで PPTX や MP4、画像等できないのか？？」→ できない理由は無かった。
実行エンジン (本人 PC の Bridge + claude CLI) は HTML と同一で、**HTML 以外を
拾って保管・配信する配線が無かっただけ**。本ゲートで配線した。

## 実装 (どこで動くか / 誰の費用か)

生成は従来どおり**本人 PC の Bridge = 本人の Claude サブスク** (追加費用なし)。
保管・配信は SaaS クラウド側 (FastAPI + DB)。

1. **対応形式** (拡張子で決定 — サーバ FILE_TYPES / Bridge BINARY_ARTIFACT_RE を対で保守):
   - 画像: png / jpg / jpeg / gif / webp / svg
   - 文書: pdf / pptx / ppt / xlsx / xls / csv / docx / doc
   - 動画: mp4 / webm / mov
   - 上限: 1 ファイル 8MB (HTML は従来 512KB)・1 ジョブ 10 件。対応外拡張子
     (exe 等) は黙って捨てず 4xx で誠実拒否。
2. **取り込み経路** (relay = Bridge / agent_sdk 両対称):
   - Bridge: 作業フォルダのスナップショット比較を全対応形式に拡張し、
     バイナリは base64 で POST /chat-relay/{job}/artifacts (content_b64)
   - サーバ: artifact_files (bytea / RLS default deny — gap-145 migration) に実体、
     workflow_outputs に `filedb://{id}` の行。**バージョンは project + stage +
     ファイル名で連鎖** (logo.png v1, v2, … — 同 stage の別ファイルと混ざらない)
   - stage 判定はファイル名 (見積/estimate 等の日英キーワード) → 直近ユーザー指示
     → 既定 (画像/動画 = design、他 = delivery) の決定的規則
3. **配信**: GET /outputs/{id}/content が filedb を**実 MIME** (image/png 等) +
   Content-Disposition inline (ブラウザ表示) / ?dl=1 で attachment (ダウンロード)。
   自己署名 URL (HMAC + 期限) は mockdb と同一契約 — Storage 未設定環境でも動く。
4. **UI**: チャットに「画像 / スライド / 表計算 / 文書 / PDF / 動画」の種類ラベル
   つき保存カード + 成果物 (S-G01) リンク。S-G01 の一覧・プレビュー (iframe) は
   既存のまま画像/PDF/動画をネイティブ表示できる。

## MP4 について (誠実な注記)

「MP4 ファイルの取り込み・保管・配信」は本ゲートで対応済。**動画の生成自体**は
LLM の守備範囲外のため、AI に作らせる場合は PC 操作で ffmpeg 等を使う指示になる
(本人 PC にツールがあれば今日から可能 — 例:「ffmpeg でスライドショー mp4 を作って」)。

## E2E 証跡 (実 Bridge + 実 claude + relay / e2e-real-png.txt)

チャット (tools_mode=auto) で「atelier-logo.png を python で生成して」→
実 claude が Bash で実 PNG を生成 → Bridge が base64 で回収 →
type=file / file_kind=image / stage=design の artifact イベント →
workflow_outputs (filedb://) → 配信は **HTTP 200 / image/png / PNG マジック
バイト実確認 / inline & dl=1 attachment** — E2E_OK: True (1 発成功)。

## テスト

- API: unit (file_type_for / classify_file_stage / バイナリ収集) + 統合
  (PNG b64 取り込み→bytes 一致配信 / exe 誠実拒否 / 見積 xlsx の stage 判定)
  含む 28 PASS + relay/SSE/outputs/dispatcher 45 PASS。ruff / pyright 0。
- Bridge: 116 PASS (バイナリ収集 + 対象外除外の新テスト含む)。tsc 0。
- Web: uc08 24 PASS (file カードの新テスト含む)。tsc 0。
