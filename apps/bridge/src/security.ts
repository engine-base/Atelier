/**
 * Atelier Bridge — セキュリティ境界 (GAP-199)
 *
 * この Bridge は **クラウドから来た指示で、利用者の PC 上の Claude Code を動かす**。
 * 経営者判断 (2026-08-19)「承認モードや bash は Claude もやってるしそのままでいい /
 * 今後強化はしていく」を踏まえ、**体験は変えずに構造的な穴だけを塞ぐ**。
 *
 * ここで守るのは 4 点。いずれも「クラウドが乗っ取られても PC 側で止まる」ようにする:
 *
 *   ① 接続先の固定 — `atelier-bridge://connect?api=...` は **どんな http URL でも
 *      無条件に保存されていた**。悪意のあるページがリンクを開かせるだけで、
 *      Bridge の指示元を攻撃者のサーバーへ差し替えられる状態だった。
 *      → 許可した接続先だけを受理し、接続先が変わるときは本人の確認を要る形にする。
 *
 *   ② サーバー由来の実行モードは既知の 3 値に正規化する — 想定外の文字列で
 *      強い権限に倒れないようにする。**PC 側で上限は掛けない**
 *      (経営者判断: Claude Code もやっていないので勝手に制限を足さない)。
 *
 *   ③ サーバー由来の値の検証 — セッション ID はコマンド引数とファイルパスの
 *      両方に使われる。UUID 以外を弾く。
 *
 *   ④ 成果物の持ち出し防止 — 作業フォルダの外を指すシンボリックリンクは
 *      アップロードしない (`~/.ssh/id_rsa` へのリンクを置かれても外に出ない)。
 *
 * さらに、**何をさせられたかが本人に見えるように**ローカル監査ログを残す。
 */

import { appendFileSync, chmodSync, existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/* ------------------------------------------------------------------ */
/* ① 接続先の固定                                                       */
/* ------------------------------------------------------------------ */

/** 追加で許可する接続先 (カンマ区切り)。自前ホスティング / 検証環境向け。 */
export const TRUSTED_ORIGINS_ENV = 'ATELIER_BRIDGE_TRUSTED_ORIGINS';

/** 既定で許可する本番の接続先。 */
export const DEFAULT_TRUSTED_ORIGINS = ['https://atelier-api-eb.fly.dev'] as const;

/** ローカル開発 (自分の PC の API) は http でも許可する。 */
function isLoopback(url: URL): boolean {
  return (
    url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost'
  );
}

function parseOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return new URL(s).origin;
      } catch {
        return '';
      }
    })
    .filter((s) => s !== '');
}

/** この PC が受け入れる接続先の一覧。 */
export function trustedOrigins(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  return [...DEFAULT_TRUSTED_ORIGINS, ...parseOrigins(env[TRUSTED_ORIGINS_ENV] ?? '')];
}

/**
 * その API URL を指示元として受け入れてよいか。
 *
 * - loopback (自分の PC) は http でも可 — 開発時の体験を壊さない
 * - それ以外は **https のみ**、かつ許可一覧にある origin だけ
 */
export function isTrustedApiUrl(
  rawUrl: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (isLoopback(url)) return url.protocol === 'http:' || url.protocol === 'https:';
  if (url.protocol !== 'https:') return false;
  return trustedOrigins(env).includes(url.origin);
}

/**
 * 接続先が「今と違う」ので本人の確認が要るか。
 *
 * 初回接続 (現在の設定が無い) は確認不要 — 本人がボタンを押した直後なので。
 * 既に接続済みの Bridge を別の指示元へ**黙って**付け替えさせないための判定。
 */
export function needsOriginChangeApproval(
  currentApiUrl: string | null,
  nextApiUrl: string,
): boolean {
  if (currentApiUrl === null || currentApiUrl === '') return false;
  try {
    return new URL(currentApiUrl).origin !== new URL(nextApiUrl).origin;
  } catch {
    // 現在の設定が壊れている場合は「変わる」とみなして確認する (安全側)
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* ② 実行モードの値そのものの検証                                        */
/* ------------------------------------------------------------------ */

export type ToolsMode = 'off' | 'approve' | 'auto';

/**
 * サーバーが指定した実行モードを、既知の 3 値のどれかに正規化する。
 *
 * **PC 側で上限を掛けることはしない** — 経営者判断 (2026-08-20):
 * 「Claude Code もやっていないので、勝手に制限を足さない」。
 * auto を指示されたら auto で動く (これは GAP-134 で決めた仕様のまま)。
 *
 * ここでやるのは**値の検証だけ**。想定外の文字列は最も弱い 'off' に倒す
 * (推測して強い方に倒さない)。
 */
export function normalizeToolsMode(requested: string): ToolsMode {
  return requested === 'off' || requested === 'approve' || requested === 'auto'
    ? requested
    : 'off';
}

/* ------------------------------------------------------------------ */
/* ③ サーバー由来の値の検証                                             */
/* ------------------------------------------------------------------ */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * セッション ID として受け入れてよい形か。
 *
 * この値は `--session-id <値>` としてコマンド引数になり、さらに
 * `~/.claude/projects/<cwd>/<値>.jsonl` というファイルパスにも使われる。
 * UUID 以外を弾いておけば、`../` も `-` 始まりも入り込まない。
 */
export function isValidSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/* ------------------------------------------------------------------ */
/* ④ 成果物の持ち出し防止                                               */
/* ------------------------------------------------------------------ */

/**
 * そのパスが本当に作業フォルダの中にあるか (シンボリックリンクを解決して判定)。
 *
 * 作業フォルダに `report.html -> ~/.ssh/id_rsa` のようなリンクを置かれると、
 * 拡張子だけ見て集めていた従来の実装ではそのままサーバーへ送られてしまう。
 */
export function resolvesInsideWorkspace(root: string, filePath: string): boolean {
  try {
    if (lstatSync(filePath).isSymbolicLink()) {
      const realRoot = realpathSync(root);
      const realFile = realpathSync(filePath);
      return realFile === realRoot || realFile.startsWith(realRoot + sep);
    }
  } catch {
    // 解決できない (壊れたリンク等) なら送らない — 安全側
    return false;
  }
  const absRoot = resolve(root);
  const absFile = resolve(filePath);
  return absFile === absRoot || absFile.startsWith(absRoot + sep);
}

/* ------------------------------------------------------------------ */
/* ローカル監査ログ — 何をさせられたかが本人に見える                      */
/* ------------------------------------------------------------------ */

export const AUDIT_FILE_NAME = '.atelier-bridge-audit.log';
/** 監査ログを止めたいとき用 ('0' で OFF)。既定は ON。 */
export const AUDIT_ENABLED_ENV = 'ATELIER_BRIDGE_AUDIT';

export function auditFilePath(home: string = homedir()): string {
  return join(home, AUDIT_FILE_NAME);
}

export interface BridgeAuditEntry {
  /** ISO8601 (呼び出し側が渡す — 時刻を勝手に作らない)。 */
  readonly at: string;
  readonly jobId: string;
  /** サーバーが指定したモード。 */
  readonly requestedMode: string;
  /** この PC が実際に使ったモード (通常はサーバー指定と同じ)。 */
  readonly effectiveMode: ToolsMode;
  readonly cwd: string;
  readonly apiOrigin: string;
  /** 実行結果 (completed / failed / cancelled など)。 */
  readonly outcome: string;
}

/**
 * ローカル監査ログへ 1 行追記する (JSON Lines / mode 0600)。
 *
 * **書けなくても実行は止めない**。監査は目的ではなく、後から見返すための記録。
 */
export function appendAudit(
  entry: BridgeAuditEntry,
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): boolean {
  if (env[AUDIT_ENABLED_ENV] === '0') return false;
  const file = auditFilePath(home);
  try {
    const isNew = !existsSync(file);
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    if (isNew) chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}
