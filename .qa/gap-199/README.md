# GAP-199 — Bridge のセキュリティ強化

## 前提（経営者判断）

2026-08-19「承認モードや bash は Claude もやってるしそのままでいい / **今後強化はしていく**」。
そこで **体験は一切変えず**（既定は今までどおり auto が使える）、構造的な穴だけを塞いだ。

## 見つけた穴と、塞ぎ方

### ① 接続先が無条件に差し替えられた（一番大きい穴）

`atelier-bridge://connect?api=<任意の http URL>&token=...` を開くと、Bridge は
**確認も検証もせずに** `~/.atelier-bridge.json` を上書きして再起動していた。
つまり **悪意のあるページにリンクを踏ませるだけで、この PC の指示元を攻撃者の
サーバーに差し替えられた**。PC 操作が auto なら、そのまま任意コマンド実行に繋がる。

塞ぎ方（2 段）:
1. `parseConnectUrl` が **許可した接続先しか通さない**
   （本番 origin + loopback。自前ホスティングは `ATELIER_BRIDGE_TRUSTED_ORIGINS`
   で**本人の PC の env にだけ**追加できる ＝ クラウドからは増やせない）
2. 既に接続済みで**接続先が変わる**ときは、Electron のダイアログで本人の確認を取る
   （「心当たりが無い場合はキャンセルしてください」）

### ② 実行モードの値が検証されていなかった

`tools_mode` はサーバーが送ってきた値を**検証せず**使っていた。
→ 既知の 3 値（`off`/`approve`/`auto`）に正規化し、想定外の文字列は最も弱い `off`
に倒す（推測で強くしない）。

**PC 側で上限は掛けない**（経営者判断 2026-08-20）— Claude Code もやっていないので
勝手に制限を足さない。auto を指示されたら auto で動く（GAP-134 の仕様のまま）。

### ③ セッション ID が無検証でコマンド引数とファイルパスに入っていた

`--session-id <値>` と `~/.claude/projects/<cwd>/<値>.jsonl` の両方に使われる。
→ **UUID 以外を弾く**（`../` も `-` 始まりも入り込まない）。

### ④ 作業フォルダの外を指すリンクがアップロードされた

成果物集めは拡張子だけを見ていたので、`report.html -> ~/.ssh/id_rsa` を置かれると
中身がサーバーへ送られてしまう。
→ **シンボリックリンクを解決して、作業フォルダの中に無ければ送らない**
（フォルダ内を指すリンクは今までどおり通す）。

### ⑤ 何をさせられたか本人に見えなかった

→ `~/.atelier-bridge-audit.log`（JSON Lines / mode 0600）に 1 ジョブ 1 行:
`at / jobId / requestedMode / effectiveMode / cwd / apiOrigin / outcome`。
**サーバー指定と実際に使った値の両方が残る**（食い違えばそれも残る）。
`ATELIER_BRIDGE_AUDIT=0` で止められる。書けなくても実行は止めない。

## どこで動くか / 誰の費用か

全部 **利用者の PC (Bridge) の中**。運営サーバーは関与せず、追加費用は 0 円。
運営サーバーが乗っ取られても、この 5 つは PC 側で効く。

## 実 e2e (`e2e-output.log`)

ビルド済み dist を使い、**本物の `ChatRelayWorker`** を偽の claude 実行ファイル
（引数をそのまま記録するシェルスクリプト）に対して走らせた。

1. 見知らぬ https の接続リンク → **受理しない** / 本番 origin → 今までどおり受理
2. サーバーが `auto` を指示 → **実際に起動された引数がそのとおり**
   （`bypassPermissions` + GAP-134 のツール一覧）— 勝手に制限を足していない
3. 監査ログに `requestedMode=auto / effectiveMode=auto / apiOrigin=...` が残る
4. 作業フォルダに `stolen.html -> <外部>/id_rsa` を置いても **集められず**、
   正当な `ok.html` だけが集まる（秘密鍵の中身は送信対象に入らない）

## 自動テスト

- `apps/bridge/__tests__/security.test.ts` — 19 件
- 既存 `chat-relay.test.ts` / `deep-link.test.ts` を新しい（厳しい）挙動に更新
- Bridge 全体 181 件 PASS / tsc 0 / eslint 0

## まだやっていないこと（正直に書く）

- **auto モードそのものは変えていない**。auto は「確認なしで bash を動かす」という
  約束で、これは Claude Code と同じ考え方。ここで塞いだのは**指示元のすり替え**。
- Bridge トークンは今も平文 JSON（mode 0600）。OS キーチェーン (safeStorage) への
  移行は Electron 実機での検証が要るため、本 GAP には含めていない。
