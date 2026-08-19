# GAP-177: 議事録の解析も本人の Claude サブスクへ（解析だけの再試行つき）

利用者向け AI 機能で最後まで**運営の `ANTHROPIC_API_KEY` を直接叩いていた**のが
議事録の構造化解析 (`services/meetings/analysis.py`) だった。GAP-171 で他を移した
ときに、ここだけ意図的に残していた理由は:

> 解析は文字起こし後のバッチで走る。実行を本人の PC に移すと、バッチが回った瞬間に
> 本人の PC が落ちていれば解析できない。従来の作りではその行は `parsed_at` が入って
> 「完了」扱いになり、**二度と解析されない** — つまり運営 API キーをやめた途端に
> 「解析が永久に欠ける」劣化になる。

その再試行を設計してから移した。

## 実装

1. **DB**: `external_uploads.analysis_pending_since` を追加 (migration
   `gap-177_meeting_analysis_retry.sql`)。null = 保留なし。部分インデックスつき。
2. **解析**: `analyze_transcript(..., actor_id=...)` を費用順チェーンへ
   (relay = **アップロードした本人**の Claude サブスク → agent_sdk → API → fake)。
   未接続は `AnalysisError("bridge_offline")`。
3. **worker**:
   - 文字起こしは成功として確定する (`parsed_at` を入れる = **Whisper を二重に
     叩かない**)。解析だけが無理なら `analysis_pending_since` に印をつける。
   - `list_analysis_pending()` + `retry_analysis_one()` を追加し、`run_once` が
     毎回「保留中の解析だけ」やり直す。**文字起こしは再実行しない** (保存済みの
     結果 JSON を読み直して解析部分だけ差し替える)。
   - まだ繋がっていなければ保留のまま残す (取りこぼさない)。
   - 戻り値に `analysis_retried` / `analysis_pending` を追加。
4. **画面**: S-M01 の「構造化解析は未実行です」の理由を
   「お使いのパソコン (Bridge) が未接続でした。**接続すると自動で解析されます**」に。
   ユーザーが何をすればいいか分かる文言にした。
5. **古い記述の是正**: 「ANTHROPIC_API_KEY 未設定は…」と書いたままだった
   docstring 7 ファイルを実態 (本人サブスク) に合わせた。コードが嘘をつかない状態に。

## これで利用者向け機能の API キー直叩きはゼロ

残る `ANTHROPIC_API_KEY` の実利用は次の 2 つだけ:

| 箇所 | 扱い |
|---|---|
| `chat_sse/__init__.py` の API 経路 | `api_billing_allowed()` ゲート内 (GAP-175/178)。既定 OFF |
| `knowledge/curation.py` | **運営バッチ** — 元から運営負担と決めている (対象外) |

## 自動テスト

`tests/test_transcribe_worker.py::TestGap177AnalysisRetry` (3):
- 未接続なら**解析を失わずに保留**する (文字起こしは成功のまま / `pending=True` が DB へ)
- 後から PC が繋がったら**解析だけやり直して**保留を解除する
  (`actor_id` がアップロード者本人であることも検証 = 本人の費用で走る)
- まだ繋がっていなければ保留のまま残す

`tests/test_transcript_analysis.py`: 経路なしは `bridge_offline` で、
かつそれが `RETRYABLE_CODES` に含まれる (= 後で必ず拾われる) ことを検証。
