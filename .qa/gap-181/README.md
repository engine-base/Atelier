# GAP-181 — 議事録の文字起こしを OSS ローカル (faster-whisper) に切替

経営者判断 (2026-08-19):
> 「② なぜ Whisper（OpenAI）なの 👉これなんか OSS 的なベストなものないの？？」
> 「2 はその OSS で進めましょう」

## 直す前の実態

文字起こしは **OpenAI Whisper API 決め打ち**だった。つまり:

- 従量課金 **$0.006/分** が**運営負担**で発生する
- **お客様の会議音声そのものが OpenAI に送信される**（越境）
- `ATELIER_OPENAI_API_KEY` が無ければ議事録機能は丸ごと動かない
- しかもこのキーは `.env.example` にも `SECRETS.md` にも**書かれていなかった**
- 画面には「解析は Whisper API（クラウド）経由」、登録同意文にも「Whisper 経由の越境同意」と明記

## 直したあと

- `src/services/meetings/stt.py` を新設し、文字起こし経路を 1 箇所に集約
- **既定 = faster-whisper**（OSS / MIT）。OpenAI Whisper と**同じ重み**を CTranslate2 で動かす実装なので
  精度は同等、費用は **0 円**、**音声は外部に出ない**
- OpenAI Whisper API は**削除していない**。`ATELIER_ALLOW_WHISPER_API=1` を明示したときだけ使う
  （キーがあるだけでは使わない — GAP-178 / GAP-180 と同じ設計）
- 経路が無いときは偽の成功を作らず `stt_unavailable` で失敗し、導入手順を返す
- 運営ヘルスチェックに「議事録の文字起こし経路」行、起動ログに 1 行（`atelier.stt_route`）
- 画面の文言を実態に修正（「Whisper API（クラウド）経由」→「Atelier のサーバー内で実行」、
  登録同意文の越境対象から Voyage / Whisper を削除）
- `03_architecture/selected-stack.json#stt` を `faster-whisper (OSS / ローカル)` に変更（仕様変更）
- `.env.example` / `SECRETS.md` に切替スイッチと費用・送信先を明記

## 証拠

`e2e-local-stt.log`:

1. 経路判定の実測
   - キーだけ入れた → `provider=local` のまま + 警告「明示 opt-in が無いため使用しません（課金しません / 音声を外部に送りません）」
   - `ATELIER_STT_PROVIDER=openai` だけ → ローカルで処理 + 警告
   - 明示 opt-in + キー → `provider=openai` / 「運営負担 ($0.006/分) — 音声が OpenAI へ送信されます」
2. **実音声での文字起こし**（espeak-ng で生成した英語音声 5.35 秒）
   - 原文: `This is the Atelier meeting minutes test. The transcription runs locally.`
   - 結果: `[0.00-2.50] This is the RTA meeting minute test.` / `[2.80-5.00] The transcription runs locally.`
   - **OpenAI API を一切呼ばずに完走**（"Atelier" が "RTA" になっているのは、機械合成音声 + 最小モデル `base` のため。
     本番既定は `small`、実際の人の声ではこれより高精度）

テスト: `apps/api/tests/services/test_stt_route.py`（8）、`apps/api/tests/test_transcribe_worker.py`（14）

## どこで動くか / 誰の費用か

| 経路 | どこで動くか | 誰の費用 | 音声の送信先 | 既定 |
|---|---|---|---|---|
| faster-whisper | Fly.io の API プロセス内 | **0 円** | 外部送信なし | ✅ これ |
| OpenAI Whisper API | OpenAI | 運営（$0.006/分） | OpenAI | ❌ `ATELIER_ALLOW_WHISPER_API=1` を明示したときだけ |

導入: `uv sync --extra localrag`（未導入なら「文字起こしできません」と手順つきで正直に出す）
