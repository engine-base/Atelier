/**
 * Better Stack ログ送信 (T-F-39) — ブラウザ側。
 *
 * selected-stack.json#observability = "... + Better Stack (logs)"
 *
 * 設計方針:
 * - `fetch` ベース。SDK 依存を増やさず、確定技術 (Better Stack) の HTTP ingest
 *   API を直接叩く。
 * - トークン未設定なら送信せず `console` へフォールバックする (ローカル出力は残る)。
 * - 送信失敗・タイムアウトは握り潰す。**ログ送信の失敗で UI の処理を落とさない。**
 * - 秘匿値 (API キー / トークン / パスワード) は送出前に必ずマスクする。
 *   ログ集約の導入自体が新しい漏洩経路にならないようにする。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  /** 付随する構造化コンテキスト。秘匿キーは送出前にマスクされる。 */
  readonly context?: Readonly<Record<string, unknown>>;
}

export const REDACTED = '[REDACTED]';

const DEFAULT_INGEST_URL = 'https://in.logs.betterstack.com';
const TIMEOUT_MS = 3000;

/**
 * 秘匿値マスクの語彙・規則・適用順。
 *
 * **`apps/api/src/observability/redaction.py` と同一の規則・同一の順序**を保つこと。
 * TS/Python 間で実装を 1 本化できない以上、**両側の期待値表を同期させる**ことで
 * パリティを担保する (tests/logger.test.ts と
 * apps/api/tests/test_observability_redaction.py に同じ表を置く)。
 *
 * 片側だけ語彙を増やすと、そちらだけ塞がれた形が生まれる。実際 T-F-48 で API 側だけ
 * 4 形式 (Basic / redis ユーザ名省略 / JSON 引用符 / Set-Cookie) を足した結果、
 * **ブラウザから Basic 資格情報・redis パスワード・JSON トークン・セッション Cookie が
 * 平文で Better Stack に届く**状態になっていた (QA_FAIL D-FAIL-2)。
 */
const SECRET_WORDS = [
  'api[_-]?key',
  'token',
  'password',
  'passwd',
  'secret',
  'authorization',
  'cookie',
  'session',
  'credential',
].join('|');

/** `Authorization` に付く認証スキーム。値の一部として明示的に食う必要がある。 */
const AUTH_SCHEMES = 'Bearer|Basic|Token|Digest';

const SENSITIVE_KEY_RE = new RegExp(`(${SECRET_WORDS}|dsn)`, 'i');

/**
 * 適用順つきのマスク規則 (API 側の `REDACTION_RULES` と 1 対 1)。
 *
 * 順序が重要:
 * - key-value より先に JSON 引用符形を処理しないと `"token": "abc"` の引用符が壊れる
 * - key-value 規則が `Bearer ` を任意接頭辞として明示的に食わないと、
 *   "Authorization: Bearer <JWT>" で `\S+` が "Bearer" で止まり JWT 本体が素通りする
 */
/**
 * 英字のみの不透明トークンを資格情報とみなす下限。
 * **apps/api/src/observability/redaction.py の MIN_OPAQUE_CREDENTIAL_LENGTH と同値。**
 */
const MIN_OPAQUE_CREDENTIAL_LENGTH = 16;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const CREDENTIAL_SYMBOLS = /[0-9._\-=+/]/;

/** base64 として復号でき、中身が印字可能 ASCII なら true。 */
function decodesAsPrintableBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !BASE64_RE.test(value)) return false;
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    return false;
  }
  if (decoded.length === 0) return false;
  for (const ch of decoded) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code >= 127) return false;
  }
  return true;
}

/**
 * 後続トークンが「資格情報の形」かどうか。**API 側 _is_credential_shaped と同一判定。**
 *
 * 1. 数字か記号 (._-=+/) を含む — JWT / hex / パディング付き base64
 * 2. base64 として復号でき中身が印字可能 ASCII — 英字のみの base64 資格情報
 * 3. 16 文字以上 — 不透明トークン
 *
 * `authentication` (14) / `expired` (7) / `mismatch` (8) はいずれも満たさない。
 */
function isCredentialShaped(value: string): boolean {
  if (CREDENTIAL_SYMBOLS.test(value)) return true;
  if (decodesAsPrintableBase64(value)) return true;
  return value.length >= MIN_OPAQUE_CREDENTIAL_LENGTH;
}

type Replacement = string | ((...args: string[]) => string);

const REDACTION_RULES: readonly (readonly [RegExp, Replacement])[] = [
  // 接続文字列の資格情報。`redis://:pass@host` のユーザ名省略形も拾う。
  // scheme と host は残す (障害調査で接続先を失わない)。
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[A-Za-z0-9_\-.%]*:[A-Za-z0-9_\-.%]+@/g, `$1${REDACTED}@`],
  // JSON の引用符形 `"token": "abc123"`。キーだけ残して値を伏せる。
  [new RegExp(`("(?:${SECRET_WORDS})")\\s*:\\s*"[^"]*"`, 'gi'), `$1: "${REDACTED}"`],
  // `api_key=xxx` / `token: xxx` / `Authorization: Bearer xxx` / `Set-Cookie: session=…`
  [
    new RegExp(
      `\\b(${SECRET_WORDS})\\b\\s*([=:])\\s*(?:(?:${AUTH_SCHEMES})\\s+)?\\S+`,
      'gi',
    ),
    `$1$2${REDACTED}`,
  ],
  // 単体で現れる認証スキーム。**スキームによって条件を分ける** (API 側と同一)。
  //
  // `Bearer` は T-F-39 から無条件でマスクしてきた。ここに後付けの条件を課すと
  // `Bearer abcdefghijklmnop` (英字のみ) が素通しになり **退行**する。
  // `bearer` は実在のログ本文にまず現れない語なので、無条件で問題ない。
  [/\bBearer\s+[A-Za-z0-9._\-=+/]+/gi, (m: string) => `${m.split(/\s+/)[0]} ${REDACTED}`],
  // 一方 `Token` / `Digest` / `Basic` は T-F-48 で新規に足したもので、**英単語として
  // 頻出する**ため無条件にすると通常のログ本文を壊す ("invalid token signature" 等)。
  // 後続が「資格情報の形」のときだけ発火させる (判定は isCredentialShaped)。
  [
    /\b(Token|Digest|Basic)\s+([A-Za-z0-9._\-=+/]+)/gi,
    (match: string, scheme: string, value: string) =>
      isCredentialShaped(value) ? `${scheme} ${REDACTED}` : match,
  ],
  // プロバイダ発行鍵の代表形 (Anthropic / OpenAI / Stripe)
  [/\bsk-[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{12,}/g, REDACTED],
];

/** 本文から秘匿値らしき部分を伏せる。API 側 `redact_text` と同一挙動。 */
export function redactText(text: string): string {
  return REDACTION_RULES.reduce<string>(
    (acc, [pattern, replacement]) =>
      typeof replacement === 'string'
        ? acc.replace(pattern, replacement)
        : acc.replace(pattern, (...args: unknown[]) =>
            replacement(...(args.filter((a) => typeof a === 'string') as string[])),
          ),
    text,
  );
}

/** キー名が秘匿候補なら値を伏せ、文字列値には本文マスクも適用する。 */
export function redactContext(
  context: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      result[key] = REDACTED;
    } else if (typeof value === 'string') {
      result[key] = redactText(value);
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactContext(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** 送出する構造化 payload を組み立てる (マスク適用済)。 */
export function buildLogPayload(entry: LogEntry, now: Date = new Date()): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    dt: now.toISOString(),
    level: entry.level,
    message: redactText(entry.message),
    service: 'atelier-web',
  };
  if (entry.context) payload.context = redactContext(entry.context);
  return payload;
}

function ingestUrl(): string {
  return process.env.NEXT_PUBLIC_BETTERSTACK_INGEST_URL || DEFAULT_INGEST_URL;
}

function sourceToken(): string | undefined {
  return process.env.NEXT_PUBLIC_BETTERSTACK_SOURCE_TOKEN || undefined;
}

/**
 * トークン未設定 / 送信失敗時のフォールバック。ローカル (devtools) には必ず残す。
 *
 * eslint の `no-console` は `warn` / `error` のみ許可しているため、
 * error 以外は `console.warn` に寄せる (集約に載らなかったログを黙って捨てない)。
 */
function logLocally(entry: LogEntry): void {
  if (typeof console === 'undefined') return;
  const message = redactText(entry.message);
  const context = entry.context ? redactContext(entry.context) : undefined;
  const method = entry.level === 'error' ? console.error : console.warn;
  method(`[${entry.level}] ${message}`, context ?? '');
}

/**
 * 1 件のログを Better Stack へ送る。
 *
 * **決して throw しない。** 送信できなかった場合も `false` を返すだけで、
 * 呼び出し元の処理は継続する。
 *
 * @returns 送信できたら `true`、未設定 / 送信失敗なら `false`。
 */
export async function sendLog(entry: LogEntry): Promise<boolean> {
  const token = sourceToken();
  if (!token) {
    logLocally(entry);
    return false;
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : undefined;
  try {
    const response = await fetch(ingestUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(buildLogPayload(entry)),
      signal: controller?.signal,
    });
    return response.ok;
  } catch {
    // 集約基盤の障害を UI の障害に昇格させない。ローカルには残す。
    logLocally(entry);
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
