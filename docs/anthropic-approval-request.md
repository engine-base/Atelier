# Anthropic への事前承認 申請文面（ドラフト）

`docs/anthropic-terms-review.md` の選択肢 1「事前承認を取りに行く」を選んだ場合に
**そのまま送れる文面**。まだ送っていない。送るかどうかは経営者判断。

## 送る前に埋めるもの

| 箇所 | 何を入れるか |
|---|---|
| `[YOUR NAME]` | 差出人の氏名 |
| `[COMPANY / SOLE PROPRIETOR NAME]` | 事業者名（法人なら法人名、個人事業なら屋号または氏名） |
| `[COUNTRY]` | Japan |
| `[PRODUCT URL]` | 公開するときの URL（未公開ならその旨を書く） |
| `[CURRENT USER COUNT]` | 現在の利用者数（0 なら 0 と書く。**盛らない**） |

## 送り先の候補

公開ドキュメントに専用の申請フォームは見当たらなかった。現実的な順に:

1. Anthropic のサポート窓口（https://support.claude.com）から
   "Partnerships / Terms" 相当のカテゴリで送る
2. 営業・パートナー窓口（https://www.anthropic.com/contact-sales）
3. 上記で担当に繋がらない場合、返信の中で正しい窓口を尋ねる

**「返事が無かったので進めた」は承認ではない。** 返信が来るまでは
`docs/anthropic-terms-review.md` の選択肢 3（現状のまま進める）と同じリスク状態が続く、
という理解で扱う。

---

## 本文（英語 / これをそのまま送る）

> **Subject:** Request for prior approval — third-party product using the customer's own Claude subscription (Claude Code CLI)

Hello,

I am writing to request prior approval under the following line in your Agent SDK
documentation:

> "Unless previously approved, Anthropic does not allow third party developers to
> offer claude.ai login or rate limits for their products, including agents built
> on the Claude Agent SDK. Use the API key authentication methods described in the
> Quickstart instead."
> — https://code.claude.com/docs/en/agent-sdk

I want to describe our architecture accurately, including the parts I am least
sure about, and ask whether it is permissible — and if not, what change would make
it so.

### What the product is

**Atelier** is a project-management SaaS for small teams, built by
[COMPANY / SOLE PROPRIETOR NAME] in [COUNTRY]. Product URL: [PRODUCT URL].
Current user count: [CURRENT USER COUNT].

The web application (UI, database, coordination) runs on our servers. **No AI
inference runs on our servers.**

### How Claude is used

Each user installs a desktop application we distribute ("Bridge", an Electron app)
on **their own computer**. Bridge:

1. requires the user to have **their own Claude subscription**, and to have logged
   in themselves via the official Claude Code CLI (`claude /login`) on that machine;
2. launches the **official Claude Code CLI as a local child process** on the user's
   own machine when the user performs an action in our web UI;
3. relays the CLI's output back to that same user's browser session.

Specifically:

- **We never receive, transmit, or store the user's Claude credentials.** The OAuth
  session belongs to the Claude Code CLI's own local storage on the user's machine.
  Our servers have no access to it.
- **We do not pool, share, or resell capacity.** Each user's requests consume only
  that user's own subscription, on that user's own machine. There is no shared
  account and no proxying of one user's traffic through another's session.
- We explicitly **strip `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and
  `CLAUDE_CODE_API_KEY`** from the child process environment, so that a stray key
  cannot silently redirect usage to metered API billing without the user's knowledge.
- We tell users plainly, before signup, that **a Claude subscription of their own is
  required** and that its cost is not included in our fee.

Our own charge (JPY 5,000 / month per workspace) is for the project-management
software. **We do not charge for AI usage and we do not resell Claude.**

### The two points I am unsure about

I would rather raise these than have you discover them later.

**(a) This is still "offering claude.ai login or rate limits for our product."**
Even though the credentials never leave the user's machine and each user pays
Anthropic directly, our product's core functionality is powered by the user's
claude.ai subscription. I read your sentence as covering this, which is why I am
asking for approval rather than assuming it is fine.

**(b) Scheduled (non-interactive) execution.**
The product has a feature that runs tasks on a schedule, which then invokes the CLI
on the user's machine without a human pressing a button at that moment. I recognise
this is harder to characterise as human-initiated use. **If this specific feature is
the obstacle, we are willing to remove it and limit execution to actions a user
initiates directly.** Please tell us if that would change the answer.

### What we are asking

1. Is the architecture above permissible with prior approval? If yes, what is the
   process to obtain it?
2. If not, is it permissible **without** the scheduled-execution feature described
   in (b)?
3. If neither, we will migrate to API key authentication as your documentation
   directs. We would appreciate knowing this clearly so we can make the change
   before we have a larger user base, rather than after.

We would rather change the product now than build on an arrangement you do not
sanction. Thank you for your time.

Sincerely,
[YOUR NAME]
[COMPANY / SOLE PROPRIETOR NAME]

---

## 和訳（送る文面と同じ内容 / 確認用）

**件名:** 事前承認のお願い — 利用者ご本人の Claude 契約（Claude Code CLI）を使う第三者製品について

Agent SDK ドキュメントの次の一文に基づき、事前承認をお願いしたく連絡しました。

> 事前に承認された場合を除き、Anthropic は第三者開発者が自社製品のために
> claude.ai のログインまたは利用枠を提供することを認めていません（Claude Agent SDK
> で構築されたエージェントを含む）。代わりに Quickstart に記載の API キー認証を
> 使用してください。

**確信が持てない部分も含めて**正確に構造をお伝えし、許容されるか、
許容されないならどう変えれば許容されるかを伺いたいと考えています。

### 製品

Atelier は小規模チーム向けのプロジェクト管理 SaaS です。画面・データベース・調整は
当社サーバーで動きますが、**AI の推論は当社サーバーでは一切動きません。**

### Claude の使われ方

利用者は自分の PC に当社の配布する Bridge（Electron アプリ）を入れます。Bridge は、

1. 利用者**自身の Claude 契約**を必要とし、その PC で公式 Claude Code CLI に
   利用者自身がログイン（`claude /login`）していることを前提とする
2. 利用者が当社画面で操作したとき、**公式 Claude Code CLI をその PC のローカル
   子プロセスとして起動する**
3. その出力を同じ利用者のブラウザへ返す

具体的には:

- **当社は利用者の Claude 資格情報を受け取らず、送らず、保存しません。**
  OAuth セッションは利用者の PC 上の CLI 自身が持っており、当社サーバーからは
  一切参照できません
- **枠の共有・転売をしていません。** 各利用者の要求は、その人自身の契約・その人
  自身の PC の上でのみ消費されます。共有アカウントも、他人のセッションを経由した
  中継もありません
- 子プロセスの環境変数から `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` /
  `CLAUDE_CODE_API_KEY` を**明示的に除去**しています。残っていると、利用者が
  気づかないまま従量課金の API へ流れてしまうためです
- 申し込み前に「**ご自身の Claude 契約が必要で、その費用は当社料金に含まれない**」
  と明記しています

当社の料金（月額 5,000 円 / ワークスペース）はプロジェクト管理ソフトウェアの対価です。
**AI 利用そのものに課金しておらず、Claude を再販していません。**

### 自信が無い 2 点（先に自分から挙げます）

**(a) これは依然として「自社製品のために claude.ai のログイン／利用枠を提供する」
ことに当たると読める。** 資格情報が利用者の PC から出ず、各利用者が Anthropic に
直接支払っていても、当社製品の中核機能が利用者の claude.ai 契約で動いている事実は
変わりません。だからこそ「問題ない」と決めつけず、承認をお願いしています。

**(b) 定時実行（非対話の実行）。** 決めた時刻にタスクを走らせる機能があり、その瞬間に
人がボタンを押していません。人間起点と説明しにくいことは認識しています。
**この機能が支障になるのであれば、削除して利用者が直接操作したときだけの実行に
限定する用意があります。**

### お願いしたいこと

1. 上記の構造は事前承認により許容されますか。許容される場合、その手続きは何ですか
2. 許容されない場合、(b) の定時実行を**外せば**許容されますか
3. いずれも不可であれば、ドキュメントの案内どおり API キー認証へ移行します。
   **利用者が増えてからではなく今のうちに**変更したいので、明確に教えていただけると
   助かります

貴社が認めていない前提の上に製品を積み上げるより、今のうちに変えたいと考えています。
