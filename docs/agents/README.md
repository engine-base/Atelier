# 3 役自走運用 (PM / dev / qa) — 起動と運用手順

ターミナル版 Claude Code のセッション間メッセージで、**PM (仕様・検収) →
dev (実装) → qa (独立検証) → PM** のバトンリレーを自走させる仕組み一式。

- 共通規約 (メッセージ種別・状態ファイル・エスカレーション): [`protocol.md`](./protocol.md)
- 役割定義: [`pm.md`](./pm.md) / [`dev.md`](./dev.md) / [`qa.md`](./qa.md)
- バトン強制 (Stop hook): `scripts/agents/flow-stop-hook.sh` (`.claude/settings.json` で配線済)
- 状態確認: `./scripts/agents/flow.sh status`

## 対応 OS と前提 (1 回だけ)

- **macOS**: 3 ウィンドウ表示。`brew install tmux`
- **Linux**: 1 画面 3 ペイン表示。`sudo apt install tmux` 等
- **Windows**: **WSL2 (Ubuntu) 内で** Linux と同様に動く (WSL 内に claude + tmux)。
  ネイティブ Windows はセッション間メッセージが macOS/Linux のみ提供のため不可

### 初回セットアップ (まっさらな PC → 動くまで全コピペ / macOS)

```bash
brew install tmux                                # 1. tmux (未導入なら)
curl -fsSL https://claude.ai/install.sh | bash   # 2. Claude Code CLI (公式)
claude                                           # 3. 起動 → /login → Claude account with subscription でログイン → /exit
cd ~/Atelier                                     # 4. プロジェクトへ (clone 済み前提)
./scripts/flow add                               # 5. 登録 + flow コマンド配置 (1 回きり)
flow                                             # 6. 起動 (以後 毎日これ 1 語)
```

Linux は 1 行目を `sudo apt install -y tmux`、Windows は PowerShell (管理者) で
`wsl --install -d Ubuntu` → 以降 Ubuntu ターミナル内で Linux と同じ。
確認: `claude --version` (**v2.1.224 以上**) / 診断 `claude doctor`。
電源接続で使う (スリープ防止は macOS=`caffeinate` / Linux=`systemd-inhibit` を自動利用)。

## 毎日の起動 (どこからでも 1 語)

```bash
flow            # 登録が 1 件ならそれを起動。複数登録なら番号選択 / flow atelier で名前指定
```

これだけで git pull → 3 ウィンドウ起動 → 案内自動突破 → /rename・/rc →
**開始文の自動送信**まで全部やる。初回のみ、プロジェクトのルートで 1 回:

```bash
./scripts/flow add    # このプロジェクトを登録し、flow コマンドを PATH に配置
```

開始文は `docs/agents/kickoff.txt` が正 (内容を変えたければこのファイルを編集)。
コピペ起動に戻したいときは `CC_AUTO_START= ./scripts/ccstart.sh`。
同時に走らせられる flow は 1 プロジェクトのみ (別プロジェクトへの切替は確認つき)。

これで **pm / dev / qa の 3 つの独立した Terminal ウィンドウ**が立ち上がる
(macOS Terminal 以外や `CC_PANES=1` では 1 画面 3 ペイン)。ウィンドウを
閉じても裏の tmux セッションは生存し `tmux attach -t flow-pm` で開き直せる。
**役割プロンプトは SessionStart hook が自動注入する** (タイミング依存なし —
`CC_ROLE` を見て `docs/agents/boot/` を起動時にコンテキストへ入れる。再開時は
バトン状態も一緒に注入される)。ccstart が文字入力するのは `/rename` と `/rc`
だけ。**`/goal` はこの運用では使わない** — ゴール未達の間セッションが自動継続し
続けるため、バトン待ちの役に付けると待機中もプラン枠を空費する (実測済)。
継続性は Stop hook が担う。3 ペインとも「◯◯ 準備完了」と言ったら、
**pm ペインに開始の一言**を打つ:

> 開始。docs/gap-tracker.md の未解消 gap を優先度順に進めて。

以降は pm→dev→qa→pm が自動で回る。権限は既定で **auto モード** (各ウィンドウ下部に
「⏵⏵ auto mode on」と表示 — ツール実行ごとに危険操作を自動判定し安全なら実行) +
許可リスト (`.claude/settings.local.json` を ccstart が自動設定) の併用で、
プロンプトは出ない。手動確認を残したいときは `NO_AUTO=1 ./scripts/ccstart.sh`。
起動が遅い環境で `/rename` が空振りするなら `CC_BOOT_TRIES=300 ./scripts/ccstart.sh`。

### 自動化が効かなかったペインの手動復旧

```
/rename pm        ← そのペインの役割名 (pm / dev / qa) — 入っていなければ
/rc               ← スマホ管理する場合
```

役割注入 (準備完了の応答) が無い場合のみ `docs/agents/boot/<役割>.txt` の内容を
そのまま貼る (hook と同じ内容なので二重になっても害はない)。

## スマホ (Remote Control) での日通し管理

- 各ペインの `/rc` 出力に従い、スマホの Claude アプリ **Code タブ** から接続
- 普段見るのは **pm だけ**。進捗報告・確認事項は pm から来る。返信・「続けて」も
  スマホから送れる。dev / qa を覗くのは異常時のみ
- 条件: Mac が起きていてオンライン (ccstart が caffeinate を常駐させる)。
  Remote Control はサブスクログインが前提 (API キー認証では使えない)
- 常に自動で有効にしたい場合は `/config` の "Enable Remote Control for all
  sessions" を ON (全プロジェクトに効く点だけ注意)
- PC 側でまとめて監視したいときは別ターミナルで `claude agents`
  (全セッションの一覧・状態・アタッチが 1 画面でできる)

## 止まったときの復旧 (よくある 3 パターン)

| 状況 | 見分け方 | 復旧 |
|---|---|---|
| レート制限 | ペインに制限メッセージ。`/status` で 5h/週の残量確認 | 枠回復後、そのセッションに「続けて」と送る (スマホからで OK)。自動再開はしない |
| バトン落ち (誰も動いていない) | `./scripts/agents/flow.sh status` で holder を確認 | holder のセッションに「protocol.md に従って続きを進めて」と一言 |
| セッション/PC が落ちた | ペインが shell に戻っている | そのペインで `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_API_KEY CC_ROLE=<役割> claude --continue` → 直近の会話から再開。全滅なら ccstart をやり直し (`tmux kill-server` 後) |

課金は常に **Claude アカウントのプラン (subscription)**。シェルに API キーが
設定されていても ccstart がキーを無視して起動する (API 従量課金には流れない)。

## 運用ルールの要点 (詳細は protocol.md)

- 仕様の正は tickets.json 等のファイル。メッセージはバトンのみ
- 同時に動くのは 1 役だけ。git 操作はバトン保持者のみ
- dev/qa はユーザーに直接聞かない — PM 経由 (`ESCALATE`)
- 致命級 (R-T08 等)・仕様変更・外部契約は必ず PM → ユーザー承認
- Stop hook が「報告・メッセージ送信・`flow.sh handoff`」を済ませないターン終了を
  差し戻すため、静かなバトン落ちは構造的に起きにくい

## 他のプロジェクトでも使う

この仕組みの汎用版が `tools/flow-kit/` にある。任意のリポジトリへ
`./tools/flow-kit/install.sh ~/path/to/other-project` で 1 コマンド導入でき、
プロジェクト固有の仕様源・DoD は導入先の `docs/agents/project.md` に書く
(詳細: `tools/flow-kit/README.md`)。

## 並列化したくなったら

dev を `dev-a` / `dev-b` の 2 枚にし、PM が files_changed_predicted の重ならない
束を同時に 2 つ払い出せばパイプライン並列になる (レート消費は約 2 倍)。
最初は直列 3 役で回し、様子を見てから検討を推奨。
