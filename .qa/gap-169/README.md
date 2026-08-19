# GAP-169: 接続トークンを発行しても繋がらなかった 3 つの実バグ + Bridge 実往復の実測

GAP-168 で「未接続なら接続フローを出す」を全画面に入れた直後、**その接続フローで
発行したトークンで実際に Bridge を繋いでみた**ところ、繋がらない / 繋がっても
ファイルが届かないことが分かった。この環境 (Linux コンテナ) に `headless` Bridge を
本当に起動して往復させたことで初めて出た不具合で、いずれも**画面には成功に見える**
ものだった。

## 見つかった実バグ (すべて修正済)

### ① 運営が `ATELIER_BRIDGE_TOKEN` を入れていないと、本人トークンが 500

`verify_bridge_token` は最初に `ATELIER_BRIDGE_TOKEN` (インスタンス共通トークン)
の設定有無を見て、未設定なら**そこで 500** を返していた。インスタンス トークンは
kanban / タスク実行系のための任意設定で、**本人の PC を繋ぐのに必須ではない**。
本番でこの環境変数を入れ忘れると、画面 (GAP-122 / GAP-168) からトークンを発行しても
Bridge が `bridge auth failed: 500` で全員繋がらない。

→ 本人トークンの検証をインスタンス トークンの有無から独立させた。
未知トークン・ヘッダー無しは 500 ではなく **401** (誤設定と誤認証を混同しない)。

### ② 作業場 seed が 500 (KeyError) — Excel/PDF が本人の PC に届かない

`GET /chat-relay/{job}/workspace` は `html=f["html"]` の決め打ちで組み立てており、
base64 のファイル項目 (GAP-161 の添付 / GAP-166 のファイル成果物) が 1 つでも
混ざると `KeyError: 'html'` で **seed 全体が 500**。Bridge 側は「seed 取得失敗は
実行を止めない」設計なので、**作業場が空のまま Claude Code が起動**していた。
= GAP-166 (Excel/PDF を本人の Claude Code に直してもらう) は実際には成立していなかった。

→ html / content_b64 の両方を通すようにし、使わない側は null ではなく**省略**して
返す (`response_model_exclude_none=True`)。

### ③ Bridge が `html: null` を「値あり」と誤読してファイルを落としていた

②の修正後も Excel は届かなかった。Bridge の seed 展開が `f.html !== undefined`
で分岐しており、サーバーが返す `html: null` が真になって
`writeFileSync(target, null)` が投げ、**catch で黙って握り潰されて**いた。

→ `typeof f.html === 'string'` の型判定に変更し、api-client 側でも `null` を
`undefined` に正規化。

## 実往復の実測 (この環境で本当に Bridge を動かした)

`apps/bridge/dist/headless.js --loop` を、画面で発行したのと同じ**ユーザートークン**で
実 API に繋ぎ、`claude` の位置にスタブ CLI を置いて動かした。
スタブは「渡された作業場の xlsx を実際に開いて 1 行足して保存する」だけのもので、
検証対象は **LLM の賢さではなく往復の配線**（ジョブ → 作業場 seed → 実ファイル編集 →
成果物検出 → 新版の取り込み）。

```
before version: 1
PASS  ai-file-edit が受理される (202)
PASS  Bridge の実行結果が新しい版として取り込まれた
new version: 2 御見積明細.xlsx
rows: [['項目','数量','単価','金額'],['要件定義',1,300000,300000],['UI デザイン',1,450000,450000],['実装',1,1200000,1200000],['保守費',1,120000,120000]]
PASS  追加された行が Excel の実体に入っている
PASS  元の明細も残っている (全面差し替えではない)

4 PASS / 0 FAIL
```

`roundtrip.txt` が実行ログ、`bridge-headless.txt` が Bridge 側の実出力。

**正直な但し書き**: `claude` 本体はこのコンテナに無いのでスタブに置き換えている。
したがって「本人の Claude サブスクで実際に賢く直る」品質そのものは、経営者の Mac 上で
本物の Bridge を繋いだときの結果になる。ここで証明したのは
**ジョブが本当に本人の PC 側へ渡り、そこで書き換えたファイルが新しい版として
ツールに戻ってくる配線が通っていること**であり、GAP-166 で「未実測」と書いた部分は
これで解消した (そして実測した結果、上の 3 つが壊れていた)。

## 自動テスト (回帰)

- API `tests/routes/test_bridge_tokens.py::test_user_token_works_without_instance_token`
  — `ATELIER_BRIDGE_TOKEN` を消した状態で本人トークンが 200 / 未知は 401 / 無しは 401
- API `tests/routes/test_chat_artifacts.py::test_workspace_seed_mixes_html_and_binary_files`
  — HTML と Excel が混ざった seed が 500 にならず、使わない側のキーは出ない
- Bridge `__tests__/chat-relay.test.ts` — `html: null` + `contentB64` の項目が
  作業場にバイナリとして展開される
