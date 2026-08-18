/**
 * GAP-135: claude CLI のクロスプラットフォーム解決。
 *
 * 素の `spawn('claude')` は 2 つの実環境で壊れる:
 *   1. Windows ネイティブ: npm 版 claude は `claude.cmd` シム — Node の spawn は
 *      shell なしで .cmd を起動できない (CVE-2024-27980 以降は EINVAL)。
 *      shell:true は systemPrompt (任意文字列) が cmd.exe に再解釈されるため
 *      インジェクション経路になり採用しない。
 *   2. macOS の GUI 起動: Dock / Finder から起動した Electron は login shell の
 *      PATH を継承せず `/usr/bin:/bin:/usr/sbin:/sbin` のみ — brew や
 *      ~/.local/bin の claude が「未インストール」扱いになる。
 *
 * 解決方針 (推測せず実体ファイルを確認する):
 *   - PATH + 既知ディレクトリを走査して claude の実体を特定する。
 *   - Windows: `claude.exe` (ネイティブインストーラ) を最優先。`claude.cmd`
 *     (npm) はシムを踏まず同 prefix の `node_modules/@anthropic-ai/claude-code/cli.js`
 *     を自プロセスの Node (Electron は ELECTRON_RUN_AS_NODE=1) で直接実行する
 *     — shell を経由しないので引数は配列のまま安全に渡る。
 *   - 見つからない場合は元のコマンドをそのまま返す (spawn の ENOENT が
 *     GAP-127 の [claude-not-found] 分類に落ち、オンボーディング UI が
 *     OS 別の導入手順を出す)。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

/** npm グローバルインストール時のパッケージ相対 entry。 */
const NPM_CLI_RELATIVE = ['node_modules', '@anthropic-ai', 'claude-code', 'cli.js'];

export type ClaudeResolution =
  | 'explicit' // ユーザーが ATELIER_BRIDGE_CMD 等で明示指定 — 触らない
  | 'path' // PATH / 既知ディレクトリで実体を発見
  | 'npm-shim' // npm シムを検知し cli.js の直接実行に置換
  | 'unresolved'; // 見つからず — 元コマンドで spawn (ENOENT → 導入案内)

export interface ClaudeSpawnSpec {
  /** spawn に渡すコマンド。 */
  readonly command: string;
  /** claude 引数の前に挿入する引数 (npm-shim のとき cli.js のパス)。 */
  readonly prependArgs: readonly string[];
  /** 子プロセス env への追加 (npm-shim を Electron で実行するときの RUN_AS_NODE)。 */
  readonly extraEnv: Readonly<Record<string, string>>;
  readonly resolution: ClaudeResolution;
  /** 発見した実体 (診断/オンボーディング表示用。unresolved は null)。 */
  readonly claudePath: string | null;
}

export interface ResolveClaudeOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** テスト注入用。既定 fs.existsSync。 */
  readonly exists?: (p: string) => boolean;
  /** npm-shim 実行に使う Node/Electron 実体。既定 process.execPath。 */
  readonly execPath?: string;
  readonly homeDir?: string;
}

/** PATH に既知の設置先を足した探索ディレクトリ列 (順序 = 優先度)。 */
export function searchDirs(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): string[] {
  const sep = platform === 'win32' ? ';' : ':';
  const fromPath = (env.PATH ?? env.Path ?? '').split(sep).filter((d) => d !== '');
  const wellKnown: string[] =
    platform === 'win32'
      ? [
          // ネイティブインストーラ (irm https://claude.ai/install.ps1)
          path.win32.join(env.USERPROFILE ?? homeDir, '.local', 'bin'),
          // npm グローバル既定 prefix
          path.win32.join(env.APPDATA ?? '', 'npm'),
        ]
      : [
          path.posix.join(homeDir, '.local', 'bin'), // ネイティブインストーラ
          '/opt/homebrew/bin', // Apple Silicon brew
          '/usr/local/bin', // Intel mac brew / 手動配置
          path.posix.join(homeDir, '.claude', 'local'), // claude migrate-installer
          path.posix.join(homeDir, '.npm-global', 'bin'),
          env.NVM_BIN ?? '', // nvm 利用者 (GUI 起動では PATH に乗らない)
          '/usr/bin',
        ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...fromPath, ...wellKnown]) {
    if (d !== '' && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

/** npm シム (claude.cmd / bin/claude) と同 prefix の cli.js を探す。 */
function npmCliFromShim(
  shimDir: string,
  platform: NodeJS.Platform,
  exists: (p: string) => boolean,
): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  // npm の global 配置は 2 形: <prefix>/node_modules (Windows) /
  // <prefix>/lib/node_modules (POSIX)。シムのあるディレクトリ基準で両方見る。
  const candidates = [
    p.join(shimDir, ...NPM_CLI_RELATIVE),
    p.join(shimDir, '..', 'lib', ...NPM_CLI_RELATIVE),
  ];
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return null;
}

const passthrough = (command: string, resolution: ClaudeResolution): ClaudeSpawnSpec => ({
  command,
  prependArgs: [],
  extraEnv: {},
  resolution,
  claudePath: resolution === 'unresolved' ? null : command,
});

/**
 * claude の spawn 仕様を解決する。
 *
 * `command` が 'claude' 以外 (パス指定や差し替え) の場合は一切触らない —
 * ユーザー/テストの明示指定を黙って上書きしない。
 */
export function resolveClaudeSpawn(
  command: string,
  opts: ResolveClaudeOptions = {},
): ClaudeSpawnSpec {
  if (command !== 'claude') return passthrough(command, 'explicit');
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? existsSync;
  const execPath = opts.execPath ?? process.execPath;
  const homeDir = opts.homeDir ?? env.HOME ?? env.USERPROFILE ?? '';
  const p = platform === 'win32' ? path.win32 : path.posix;

  for (const dir of searchDirs(platform, env, homeDir)) {
    if (platform === 'win32') {
      const exe = p.join(dir, 'claude.exe');
      if (exists(exe)) {
        return { command: exe, prependArgs: [], extraEnv: {}, resolution: 'path', claudePath: exe };
      }
      const cmdShim = p.join(dir, 'claude.cmd');
      if (exists(cmdShim)) {
        const cli = npmCliFromShim(dir, platform, exists);
        if (cli !== null) {
          return {
            command: execPath,
            prependArgs: [cli],
            extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
            resolution: 'npm-shim',
            claudePath: cli,
          };
        }
        // シムはあるが cli.js が見つからない — shell 経由は採らず探索続行
      }
    } else {
      const bin = p.join(dir, 'claude');
      if (exists(bin)) {
        return { command: bin, prependArgs: [], extraEnv: {}, resolution: 'path', claudePath: bin };
      }
    }
  }
  return passthrough(command, 'unresolved');
}
