# Atelier Bridge — ユーザー向けセットアップガイド (全 OS / GAP-135)

> 対象: Atelier を使う **すべてのユーザー**（開発者ではない人を含む）。
> Bridge はあなたの PC に常駐し、あなたの Claude サブスクプランで
> チャット応答・PC 操作を実行するアプリです。Atelier 側に LLM 追加費用は発生しません。

## セットアップは「初回 1 回だけ」3 ステップ

アプリを起動すると **オンボーディング画面**が現在の状態を診断し、
足りないステップだけを OS に合わせた手順つきで表示します
（`apps/bridge/renderer/index.html` + `src/doctor.ts`）。

### 1. Bridge アプリのインストール（1 回だけ）

| OS | インストーラ | ビルド |
|---|---|---|
| macOS | `.dmg` (arm64 / x64) | `apps/bridge/scripts/build-dmg.sh` |
| Windows | installer `.exe` (NSIS) | `apps/bridge/scripts/build-msi.sh` |
| Linux | AppImage / `.deb` | `apps/bridge/scripts/build-linux.sh` |

- 以後の起動は不要 — **接続完了時に「OS ログイン時の自動起動」が自動登録**される
  (GAP-126: macOS/Windows は LoginItem、Linux は XDG autostart)。
- 新バージョンが出るとアプリ内バナーが通知し、ワンクリックで自 OS 用インストーラの
  ダウンロードへ誘導する (GAP-135: `src/updates.ts` + API `/public/bridge-latest`)。
  リリース配信はサーバー env (`ATELIER_BRIDGE_LATEST_VERSION` /
  `ATELIER_BRIDGE_DOWNLOAD_URL_{MAC,WIN,LINUX}`) を更新するだけ。
  ※ サイレント自動更新 (electron-updater) は各 OS の**コード署名インフラが前提**のため
  通知 + ワンクリック DL までを提供する。署名整備後の切替は本ファイルを更新すること。

### 2. Claude Code CLI + ログイン（1 回だけ）

- macOS / Linux: `curl -fsSL https://claude.ai/install.sh | bash`
- **Windows: PowerShell で `irm https://claude.ai/install.ps1 | iex` — WSL は不要**。
  PC 操作 (Bash ツール) を使う場合のみ Git for Windows を追加。
- ログイン: `claude auth login`（本人の Claude サブスクプランがそのまま使われる）

### 3. Atelier と接続（1 回だけ）

Atelier をブラウザで開き **設定 → Bridge 接続 → 「アプリで接続」**。
ディープリンク `atelier-bridge://connect` で接続トークンが渡り、
`~/.atelier-bridge.json` (mode 0600) に保存される (GAP-122)。トークンは無期限。

## 再インストール・再起動は必要か？

| イベント | ユーザー操作 |
|---|---|
| PC 再起動 / ログアウト | **不要** — ログイン時に自動起動して接続復帰 (GAP-126) |
| Bridge のバージョンアップ | バナーから新インストーラを 1 クリック DL → 上書きインストール。設定 (`~/.atelier-bridge.json`) は保持されるので再接続不要 |
| Claude CLI の更新 | claude 側の自動更新に任せる（Bridge は毎回実体を解決して起動する） |
| 接続トークンの失効/削除 | Atelier 画面から「アプリで接続」をやり直すだけ |

## OS ごとの技術的差異 (GAP-135 で吸収済み)

`src/command.ts` が spawn 前に claude の実体を解決する:

- **Windows ネイティブ**: `claude.exe` (ネイティブインストーラ) を最優先。
  npm 版の `claude.cmd` シムは **shell を経由せず** 同 prefix の
  `node_modules/@anthropic-ai/claude-code/cli.js` を `ELECTRON_RUN_AS_NODE=1` で
  直接実行する（.cmd は Node の spawn で起動不可・shell 経由は
  system prompt がコマンドとして再解釈されるインジェクション経路のため不採用）。
- **macOS の GUI 起動**: Dock/Finder 起動の Electron は login shell の PATH を
  継承しない（`/usr/bin:/bin:/usr/sbin:/sbin` のみ）。PATH に加えて
  `~/.local/bin` / `/opt/homebrew/bin` / `/usr/local/bin` / `~/.claude/local` /
  `$NVM_BIN` を実体確認して解決する。
- **Linux**: 同上の既知ディレクトリ + XDG autostart。
- 解決できない場合は従来どおり ENOENT → GAP-127 の `[claude-not-found]` 分類に落ち、
  オンボーディング画面が OS 別の導入コマンドを表示する。

## 実行中でも指示が届く (GAP-191)

Bridge は**スレッドごとに Claude を常駐**させる。だから

- 2 ターン目以降は**起動もセッション復元も要らない**（体感が速くなる）
- **作業中に追加で伝えた指示が、そのまま今の実行へ届く**
  （Claude Code のインタラクティブで作業中に入力するのと同じ）

画面には「（実行中に追加で伝えました）」として残るので、**黙って会話に混ざらない**。

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `ATELIER_BRIDGE_PERSISTENT` | (ON) | `0` で従来の「1 ターン 1 プロセス」に戻す |
| `ATELIER_BRIDGE_PERSISTENT_IDLE_MS` | 900000 (15 分) | 使われなくなってからプロセスを畳むまで |

常駐するのはツールあり（PC 操作）のときだけ。パソコンを再起動すればプロセスは
消えるが、**会話は残る**（transcript の実ファイルから `--resume` で続く）。

## セキュリティ (GAP-199)

Bridge は **クラウドから来た指示で、このパソコンの Claude Code を動かす**。
そこで「クラウドが乗っ取られてもパソコン側で止まる」形にしてある。

| 守り | 中身 |
|---|---|
| 接続先の固定 | `atelier-bridge://connect?api=...` は**許可した接続先だけ**受理する。以前はどんな http URL でも無条件に保存していた（リンクを踏ませるだけで指示元を差し替えられた） |
| 接続先変更の確認 | 既に接続済みで接続先が変わるときは、ダイアログで本人の確認を取る |
| 実行モードの上限 | サーバーが送ってきた `tools_mode` を、このパソコンの上限まで**自動で格下げ**する |
| セッション ID の検証 | UUID 以外は使わない（引数とファイルパスの両方に入る値のため） |
| 持ち出し防止 | 作業フォルダの外を指すシンボリックリンクはアップロードしない |
| ローカル監査ログ | `~/.atelier-bridge-audit.log` に 1 ジョブ 1 行（JSON / mode 0600） |

設定 (すべて**このパソコンの env** — クラウドからは変えられない):

| 環境変数 | 既定 | 意味 |
|---|---|---|
| `ATELIER_BRIDGE_MAX_TOOLS_MODE` | `auto` | このパソコンで許す最大の実行モード (`off`/`approve`/`auto`)。既定は今までどおり |
| `ATELIER_BRIDGE_TRUSTED_ORIGINS` | (なし) | 自前ホスティング等で許可する接続先をカンマ区切りで追加 |
| `ATELIER_BRIDGE_AUDIT` | (ON) | `0` でローカル監査ログを止める |

**正直に書いておくこと**: auto モードは「確認なしで bash を動かす」という約束なので、
auto そのものの危険性は変わらない。ここで固めたのは**誰がそれを決めるか**（＝
サーバーではなく、このパソコンの持ち主）。接続トークンは今も平文 JSON (mode 0600) で、
OS キーチェーンへの移行は未実施。

## 社内開発フロー (flow/tmux) との違い

`docs/agents/README.md` の tmux ベース開発フローは **開発者向け**で、tmux の都合で
Windows は WSL2 を使う。**ユーザー向け Bridge アプリはこれとは別物で、
Windows ネイティブで動く** (WSL 不要)。混同しないこと。
