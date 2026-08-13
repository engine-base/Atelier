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

const SENSITIVE_KEY_RE = /(api[_-]?key|token|password|passwd|secret|authorization|credential|dsn)/i;

/**
 * 適用順つきのマスク規則。**apps/api/src/observability/betterstack.py の
 * `_REDACTION_RULES` と同一の規則・同一の順序**を保つこと。
 *
 * 順序が重要: key-value 規則が `Bearer ` を任意接頭辞として明示的に食わないと、
 * "Authorization: Bearer <JWT>" で `\S+` が "Bearer" で止まり JWT 本体が
 * 素通しになる (QA_FAIL-2 の原因)。
 */
const REDACTION_RULES: readonly (readonly [RegExp, string])[] = [
  // 接続文字列の資格情報。scheme と host は残す。
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[A-Za-z0-9_\-.%]+:[A-Za-z0-9_\-.%]+@/g, `$1${REDACTED}@`],
  // key=value / key: value (Authorization: Bearer <token> を含む)
  [
    /\b(api[_-]?key|token|password|passwd|secret|authorization)\b\s*([=:])\s*(?:Bearer\s+)?\S+/gi,
    `$1$2${REDACTED}`,
  ],
  // 単体で現れる Bearer <token>
  [/\bBearer\s+[A-Za-z0-9._-]+/gi, `Bearer ${REDACTED}`],
  // プロバイダ発行キーの代表形
  [/\bsk-[A-Za-z0-9_-]{12,}/g, REDACTED],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{12,}/g, REDACTED],
];

/** メッセージ本文から秘匿値らしき部分を伏せる。 */
export function redactText(text: string): string {
  return REDACTION_RULES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
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
