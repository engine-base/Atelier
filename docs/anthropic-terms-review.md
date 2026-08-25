# Anthropic の規約・ドキュメントの読み取り記録

> 経営者判断 (2026-08-22): 「向こうが書いているものに違反していなければ、
> Anthropic への書面確認は不要。大きくなってから」。
> **照会しない代わりに、向こうが書いているものを実際に読んで記録する**ための文書。
>
> 実施: 2026-08-22 / 実施者: AI (Claude Code)。
> **注意: 私は弁護士ではない。ここにあるのは条文の引用と、その素直な読み方であり、
> 法的助言ではない。**

## 0. 結論（先に書く）

**「違反していない」とは言えない。** 公開ドキュメントに、Atelier の現在の形を
**名指しに近い形で「承認が無い限り認めない」と書いた一文**がある。

> Unless previously approved, Anthropic does not allow third party developers to
> offer claude.ai login or rate limits for their products, including agents built
> on the Claude Agent SDK. Use the API key authentication methods described in the
> Quickstart instead.
>
> — Agent SDK overview, https://code.claude.com/docs/en/agent-sdk （2026-08-22 取得）

Atelier は「**利用者本人の claude.ai の契約（ログインと利用枠）を、当社製品の
AI 実行手段として提供する**」形をとっている。これは上記の文が言う
"offer claude.ai login or rate limits for their products" にそのまま当たると
読むのが素直である。

そして同じ文が **"Unless previously approved"（事前承認があれば別）** と書いている。
つまり **承認を取りに行く経路が存在し、それが正規の解決策**として示されている。

## 1. 調べた一次情報

| 文書 | URL | 最終更新（表示） |
|---|---|---|
| Consumer Terms of Service | https://www.anthropic.com/legal/consumer-terms | 2025-10-08 |
| Commercial Terms of Service | https://www.anthropic.com/legal/commercial-terms | 2025-06-17 |
| Agent SDK overview | https://code.claude.com/docs/en/agent-sdk | （日付表示なし / 2026-08-22 取得） |
| Usage limit best practices | https://support.claude.com/en/articles/9797557-usage-limit-best-practices | （同上） |

## 2. 該当しそうな条項と、その読み方

### 2.1 第三者製品が claude.ai のログイン／利用枠を提供すること

上記 0. の引用のとおり。**これが一番効く。**

- 「Atelier を使うにはご自身の Claude 契約が必要です」と案内し、
  その契約の**利用枠で当社の機能を動かしている**構造そのものが対象に読める。
- Bridge が呼ぶのが Claude Code CLI であっても、**Agent SDK に限る話ではない**
  （"for their products, including agents built on the Claude Agent SDK" ＝
  SDK 製は例示であって限定ではない）。
- 示されている代替は **API キー認証**。これは Atelier が GAP-175 で
  「既定で塞ぐ」と決めた経路であり、**採用すると費用構造が反転する**
  （利用者負担 → 当社負担、または利用者が API キーを自前で用意）。

### 2.2 自動・非人間手段でのアクセス

Consumer Terms 第 3 条 (Use of our Services) の禁止行為:

> Except when you are accessing our Services via an Anthropic API Key or where we
> otherwise explicitly permit it, to access the Services through automated or
> non-human means

- Atelier の**定時実行（日次ダイジェスト等）**は、人が座っていない時間に
  走る。ここが最も説明の難しい部分。
- 対話操作（利用者が画面で送信 → Bridge が Claude Code を起動）は
  「人間が起点」と主張する余地があるが、**"automated or non-human means" の
  例外は「API キー経由」か「明示的な許可」の 2 つだけ**と書かれている。

### 2.3 アカウント／資格情報の共有

Consumer Terms 第 2 条:

> You may not share your Account login information, Anthropic API key, or Account
> credentials with anyone else.

- Atelier は**利用者の資格情報を当社サーバーへ渡させていない**（Bridge が
  本人の PC 上で本人の Claude Code を起動する）。**この条項には抵触しない**
  設計になっている。ここは現行アーキテクチャの強み。

### 2.4 商用利用

Consumer Terms には、評価目的の利用について
"for your personal, non-commercial use only" の記載がある一方、
**Pro / Max の業務利用そのものを一般的に禁じる文言は見つからなかった**。
ここは 2.1 ほど明確ではない。

## 3. Atelier にとっての意味

| 論点 | 状態 |
|---|---|
| 資格情報を預からない設計 | **問題なし**（むしろ良い） |
| 対話操作で本人の Claude Code を起動 | **グレー**（人間起点と主張できるが、明文の例外には当たらない） |
| 定時実行・無人実行 | **黒に近い**（2.2 の例外に当たらない） |
| 本人の claude.ai 契約を製品の実行手段として提供 | **明文に当たると読める**（2.1）。ただし **事前承認があれば可** |

## 4. 選択肢

1. **事前承認を取りに行く** — 2.1 の "Unless previously approved" が示す正規ルート。
   費用構造を維持したまま解決しうる唯一の道。返答までの時間は読めない。
2. **API キー方式へ切り替える** — ドキュメントが案内する代替。規約上は明快になるが、
   **AI の費用を当社または利用者が別途負担する**ことになり、事業モデルが変わる。
   （GAP-175 で塞いだ経路を開け直すことになる）
3. **現状のまま進める** — リスクを認識したうえでの経営判断。利用者数が増えるほど、
   後から是正するときの影響が大きくなる（利用者の契約にも影響しうる）。
4. **定時実行だけ止める** — 2.2 の一番説明しにくい部分を落として、対話操作に限る。
   1〜3 と併用できる緩和策。

## 5. 記録として残す理由

「聞いていない」だけなら、後から
「知らなかったのか、知っていて放置したのか」が分からない。
**読んだ日・読んだ場所・読み方を残しておけば、少なくとも
「確認したうえでの判断」として説明できる。**

再読の引き金: Anthropic が上記いずれかの文書を更新したとき / 法人顧客が
付いたとき / 有料利用者が実数で増えたとき。
