# 3 役自走運用 (PM / dev / qa) — 起動と運用手順

ターミナル版 Claude Code のセッション間メッセージで、**PM (仕様・検収) →
dev (実装) → qa (独立検証) → PM** のバトンリレーを自走させる仕組み一式。

- 共通規約 (メッセージ種別・状態ファイル・エスカレーション): [`protocol.md`](./protocol.md)
- 役割定義: [`pm.md`](./pm.md) / [`dev.md`](./dev.md) / [`qa.md`](./qa.md)
- バトン強制 (Stop hook): `scripts/agents/flow-stop-hook.sh` (`.claude/settings.json` で配線済)
- 状態確認: `./scripts/agents/flow.sh status`

## 前提 (1 回だけ)

1. Claude Code CLI **v2.1.224 以上** (`claude --version`) + Pro/Max で `/login` 済み
2. `brew install tmux` (未導入なら)
3. Mac を電源に接続。スリープ防止はスクリプトが `caffeinate` で自動常駐する

## 毎日の起動 (1 コマンド)

```bash
cd ~/path/to/Atelier
./scripts/ccstart.sh
```

これで **pm / dev / qa の 3 つの独立した Terminal ウィンドウ**が立ち上がる
(macOS Terminal 以外や `CC_PANES=1` では 1 画面 3 ペイン)。ウィンドウを
閉じても裏の tmux セッションは生存し `tmux attach -t flow-pm` で開き直せる。
**役割プロンプトは SessionStart hook が自動注入する** (タイミング依存なし —
`CC_ROLE` を見て `docs/agents/boot/` を起動時にコンテキストへ入れる。再開時は
バトン状態も一緒に注入される)。ccstart が文字入力するのは `/rename` と `/rc`
だけ。3 ペインとも「◯◯ 準備完了」と言ったら、**pm ペインに開始の一言**を打つ:

> 開始。docs/gap-tracker.md の未解消 gap を優先度順に進めて。

以降は pm→dev→qa→pm が自動で回る。権限確認は既定でプロンプトを出さない
(`.claude/settings.local.json` の許可リストを ccstart が自動設定 — bypass の警告
ダイアログも出ない)。プロンプトを残したいときは `NO_AUTO=1 ./scripts/ccstart.sh`。
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
- 条件: Mac が起きていてオンライン (ccstart が caffeinate を常駐させる)

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
