/**
 * GAP-135: Bridge 環境診断 (オンボーディング UI のデータ源)。
 *
 * 「今この PC で何が足りないか」を実体確認だけで判定する (推測しない):
 *   1. claude CLI — resolveClaudeSpawn の実体解決 + `claude --version`
 *   2. Claude ログイン — `claude auth status` (JSON を返す) の loggedIn
 *   3. Atelier 接続 — env ATELIER_BRIDGE_TOKEN or ~/.atelier-bridge.json
 *
 * どのチェックも失敗＝ユーザー向けの次アクション (guidanceKey) に対応する。
 * 文言は renderer 側が OS を見て出し分ける。
 */

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';

import { chatWorkspaceDir } from './chat-relay.js';
import { resolveClaudeSpawn, type ClaudeSpawnSpec } from './command.js';
import { configFilePath, loadConnectConfig } from './deep-link.js';

export type CheckStatus = 'ok' | 'fail' | 'unknown';

export interface DoctorReport {
  readonly platform: NodeJS.Platform;
  readonly cli: {
    readonly status: CheckStatus;
    /** 発見した claude 実体 (未発見は null)。 */
    readonly path: string | null;
    readonly version: string | null;
    readonly resolution: ClaudeSpawnSpec['resolution'];
  };
  readonly auth: {
    readonly status: CheckStatus;
    readonly loggedIn: boolean | null;
    readonly method: string | null;
  };
  readonly connection: {
    readonly status: CheckStatus;
    readonly apiUrl: string | null;
    readonly source: 'env' | 'config' | null;
  };
  /** PC 操作の作業フォルダ (承認カードの文脈説明用)。 */
  readonly workspace: string;
}

export interface CommandResult {
  readonly ok: boolean;
  readonly stdout: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>>,
) => Promise<CommandResult>;

/** 既定 runner: execFile (shell なし) + 10 秒タイムアウト。 */
export const defaultCommandRunner: CommandRunner = (command, args, extraEnv) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: 10_000, env: { ...process.env, ...extraEnv } },
      (err, stdout) => {
        resolve({ ok: err === null, stdout: String(stdout ?? '') });
      },
    );
  });

/** `claude auth status` の出力 (JSON) を解釈する。壊れていたら null。 */
export function parseAuthStatus(stdout: string): { loggedIn: boolean; method: string | null } | null {
  // 前後に人間向け行が混ざっても最初の { ... } を拾う
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof parsed.loggedIn !== 'boolean') return null;
    return {
      loggedIn: parsed.loggedIn,
      method: typeof parsed.authMethod === 'string' ? parsed.authMethod : null,
    };
  } catch {
    return null;
  }
}

export interface DoctorOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly run?: CommandRunner;
  readonly configPath?: string;
  readonly platform?: NodeJS.Platform;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const run = opts.run ?? defaultCommandRunner;
  const platform = opts.platform ?? process.platform;
  const spec = resolveClaudeSpawn(env.ATELIER_BRIDGE_CMD ?? 'claude', { env, platform });

  let cliStatus: CheckStatus = 'fail';
  let version: string | null = null;
  let auth: DoctorReport['auth'] = { status: 'unknown', loggedIn: null, method: null };
  if (spec.resolution !== 'unresolved') {
    const ver = await run(spec.command, [...spec.prependArgs, '--version'], spec.extraEnv);
    if (ver.ok && ver.stdout.trim() !== '') {
      cliStatus = 'ok';
      version = ver.stdout.trim().split('\n')[0] ?? null;
    }
    // ログイン確認は CLI が起動できたときだけ意味を持つ
    if (cliStatus === 'ok') {
      const st = await run(spec.command, [...spec.prependArgs, 'auth', 'status'], spec.extraEnv);
      const parsed = st.ok ? parseAuthStatus(st.stdout) : null;
      auth =
        parsed !== null
          ? {
              status: parsed.loggedIn ? 'ok' : 'fail',
              loggedIn: parsed.loggedIn,
              method: parsed.method,
            }
          : // 旧 CLI (auth サブコマンド無し) 等 — 実行時の GAP-127 分類に委ねる
            { status: 'unknown', loggedIn: null, method: null };
    }
  }

  let connection: DoctorReport['connection'] = { status: 'fail', apiUrl: null, source: null };
  if (env.ATELIER_BRIDGE_TOKEN) {
    connection = { status: 'ok', apiUrl: env.ATELIER_API_URL ?? null, source: 'env' };
  } else {
    const stored = loadConnectConfig(opts.configPath ?? configFilePath(homedir()));
    if (stored !== null) {
      connection = { status: 'ok', apiUrl: stored.apiUrl, source: 'config' };
    }
  }

  return {
    platform,
    cli: { status: cliStatus, path: spec.claudePath, version, resolution: spec.resolution },
    auth,
    connection,
    workspace: chatWorkspaceDir(env),
  };
}
