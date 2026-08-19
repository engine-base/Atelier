# GAP-175: 既定が「運営の API キー課金」になっていた — 全ユーザー・全機能を本人サブスクへ

経営者の確認:
「API キーで LLM は動かさない状態にしているよね？？ 全てサブスクプランだよね？？」

**答えは「いいえ」でした。** 確定アーキテクチャ (全ユーザーが自分の PC・自分の
Claude サブスクで実行する) と、実装の既定値が**正反対**になっていた。

## 何が起きていたか

| | 修正前 | 修正後 |
|---|---|---|
| `ATELIER_LLM_PROVIDER` 未設定のとき | relay を**飛ばして** `ANTHROPIC_API_KEY` (運営の従量課金) を使う | **relay = 本人の PC の Bridge** (既定) |
| 環境に API キーがあるとき | Bridge 未接続なら**黙って運営課金**で実行 | `ATELIER_ALLOW_API_BILLING=1` が無ければ使わない → 503 で正直に断る |
| `.env.example` | `ANTHROPIC_API_KEY` を「chat / RAG に**必須**」「本番にも必ず投入」 | 「**既定では使われない**」「API 課金は明示 opt-in」 |
| `SECRETS.md` | 同上 | 同上 + 「`ATELIER_LLM_PROVIDER` は未設定のままにする (未設定 = 本人サブスク)」 |

つまり、**Bridge が繋がっていない利用者の分だけ、LLM 費用が黙って運営持ちに
なる**状態だった。人数が増えるほど運営の従量課金が増える構造で、
GAP-171 で経路を統一した後もこの既定値のせいで意味が半減していた。

**GAP-171 の検証の但し書き (正直な訂正)**: 昨日の実測は
`ATELIER_LLM_PROVIDER=relay` を**こちらで明示設定して**行ったもの。
「relay で動く」ことは証明できていたが、「**既定でサブスクになっている**」ことは
証明していなかった。ここが今回の修正点。

## 実装

- `relay_mode_enabled()`: `ATELIER_LLM_PROVIDER` **未設定 = relay** に反転。
  `agent_sdk` / `api` を使いたいときだけ明示する。
  (テスト専用スタブ `ATELIER_ALLOW_FAKE_LLM=1` の環境には Bridge が無いので
   relay を試さない — この env は本番では絶対に設定しない。)
- `api_billing_allowed()` を新設。`ATELIER_ALLOW_API_BILLING=1` が無い限り
  `ANTHROPIC_API_KEY` 経路は**使わない**。チャット SSE (`use_api`) も同じゲート。
- 経路ゼロのときのエラーを `unconfigured` から **`bridge_offline`** に変更 —
  実態は「利用者の PC が繋がっていない」なので、画面 (GAP-168) が接続フローを出す。
- **併せて実バグを 1 件修正**: `relay._session_factory()` が `lru_cache(maxsize=1)` で
  event loop を跨いで engine を使い回しており、loop が作り直される経路で
  "attached to a different loop" になって **「Bridge 未接続」が「実行が失敗」に
  誤分類**されていた (503 であるべきものが 502)。loop ごとに engine を分けた。
- 例外: **ナレッジ自動キュレーションは運営バッチ**なので従来どおり運営負担
  (この経路を通らない)。

## 自動テスト (`tests/test_llm_billing_default.py`)

- `ATELIER_LLM_PROVIDER` 未設定 = relay (本人サブスク) が既定
- `agent_sdk` / `relay` を明示したときの分岐
- `api_billing_allowed()` は既定 False / `=1` で True
- **本丸**: 環境に `ANTHROPIC_API_KEY` があっても、Bridge 未接続なら
  課金せず `bridge_offline` で断る (fake も API も呼ばれない)
