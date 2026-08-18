# GAP-148: チャット実行中表示を Claude Code 風に (実値行 + 内訳サマリー)

## 経営者指摘

「チャット部分のランタイム、結果までの間の感じを Claude Code みたいな状態に
してほしい」— 従来はツール名だけの実況 (「ツール実行中: Bash」) で、
何を実行しているかが見えなかった。

## 実装

1. **Bridge (chat-relay.ts)**: assistant 完成メッセージの tool_use ブロックから
   実入力を要約 (`extractToolDetails` — Bash はコマンド、Edit/Write はファイル
   パス) し、kind='tool' chunk に JSON {tool, summary} で送る。CLI はツール
   実行**前**に assistant メッセージを完成させるため実況として間に合う。
2. **Web (ChatPanel/ChatContainer)**: Claude Code 風のタイムライン —
   `⏺ Bash(printf 'hello' > check.txt && cat check.txt)` の実値行を時系列に
   縦に並べ、実行中の行は ⏺ + パルス、完了行は ✓。ヘッダに経過秒。
   名前だけの行 (tool_start) は要約が届いた時点で実値行に格上げ。
3. **完了サマリーの内訳**: 「PC 操作完了: N ツール実行 · コマンド n 件 ·
   ファイル編集 m 件 (s 秒)」。

## 実 e2e (e2e-tool-detail.txt)

実 Bridge + 実 claude の auto ジョブで、SSE の tool chunk に
`{"tool":"Bash","summary":"printf 'hello gap148' > gap148-check.txt && cat gap148-check.txt"}`
という**実コマンド**が載ることを確認 (E2E_OK: True)。

## スマホ対応の実測 (mobile-chat.png — 経営者質問への回答材料)

390×844 (iPhone 相当) の実ブラウザでチャット画面を実測: 横スクロール無し・
入力欄/送信ボタン操作可能・履歴表示正常。**PC を起動したまま (Bridge 常駐)
であれば、スマホのブラウザからチャット操作できる** — 実行はリレー経由で
本人 PC の Bridge が行うため、スマホ側に必要なのはブラウザだけ。

## テスト

bridge 118 PASS (+2: extractToolDetails) / web 46 PASS (uc08 + chat-panel-more
更新) / tsc 0。
