/**
 * Atelier Bridge — チャットのローカル実行リレー (GAP-114)
 *
 * サーバー (chat_relay_jobs) から queued job を pick し、この PC の
 * Claude ログイン (= 本人の月額プラン) で `claude -p` を実行、text delta を
 * chunks として逐次返送する。S-E01 チャットの SSE がそれを中継する。
 *
 * 課金安全: 子プロセス env から ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN /
 * CLAUDE_CODE_API_KEY を必ず除去する (残っていると OAuth より優先されて
 * 黙って API 従量課金に流れる — scripts/ccstart.sh:113 と同じ理由)。
 */

import { spawn } from 'node:child_process';

import type { ChatRelayPicked, ChatRelayRateLimitObservation } from './api-client.js';

export const CHAT_RELAY_ENABLED_ENV = 'ATELIER_BRIDGE_CHAT_RELAY';

/** chat relay が有効か (既定 ON。'0' で明示 OFF)。 */
export function chatRelayEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[CHAT_RELAY_ENABLED_ENV] !== '0';
}

/** 子プロセスへ渡す env (API キー系 3 変数を除去 — サブスク課金を保証)。 */
export function sanitizedChildEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const drop = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_API_KEY']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !drop.has(k)) out[k] = v;
  }
  return out;
}

/**
 * claude -p の引数を組み立てる。prompt は argv 長制限を避けて stdin で渡す。
 * --include-partial-messages で text delta (stream_event) を逐次受ける。
 */
export function buildChatArgs(systemPrompt: string): string[] {
  return [
    '-p',
    '--append-system-prompt',
    systemPrompt,
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--max-turns',
    '1',
  ];
}

export type ChatStreamItem =
  | { readonly kind: 'delta'; readonly text: string }
  | { readonly kind: 'assistant_text'; readonly text: string }
  | { readonly kind: 'result'; readonly ok: boolean; readonly detail?: string }
  | { readonly kind: 'rate_limit'; readonly observation: ChatRelayRateLimitObservation };

/**
 * stream-json の 1 行を解釈する。対象外の行 (init/その他) は null。
 * - stream_event / content_block_delta / text_delta → delta
 * - assistant (完成 message) → assistant_text (partial 不達時の代替)
 * - result → ok (subtype === 'success')
 * - rate_limit_event → rate_limit (GAP-119: 本人プラン枠の実観測値)
 */
export function parseStreamLine(line: string): ChatStreamItem | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (obj.type === 'stream_event') {
    const event = obj.event as Record<string, unknown> | undefined;
    if (event?.type !== 'content_block_delta') return null;
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type !== 'text_delta' || typeof delta.text !== 'string' || delta.text === '')
      return null;
    return { kind: 'delta', text: delta.text };
  }
  if (obj.type === 'assistant') {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    const texts: string[] = [];
    for (const block of content) {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string' && b.text !== '') texts.push(b.text);
    }
    if (texts.length === 0) return null;
    return { kind: 'assistant_text', text: texts.join('') };
  }
  if (obj.type === 'result') {
    return {
      kind: 'result',
      ok: obj.subtype === 'success',
      // GAP-127: 失敗原因の分類材料 (例: "Invalid API key · Please run /login")
      ...(typeof obj.result === 'string' && obj.result !== ''
        ? { detail: obj.result }
        : {}),
    };
  }
  if (obj.type === 'rate_limit_event') {
    // claude CLI がプラン枠の状態変化時に発行する実値 (推測なし)。
    // GAP-128: 実 CLI の実測でフィールドは camelCase (rateLimitType/resetsAt)
    // だった。snake_case のみ読んでいて全 null になっていた実バグの是正 —
    // 将来の表記揺れに備えて両方受ける。
    const info = obj.rate_limit_info as Record<string, unknown> | undefined;
    const status = info?.status;
    if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected')
      return null;
    const rateLimitType = info?.rate_limit_type ?? info?.rateLimitType;
    const resetsAt = info?.resets_at ?? info?.resetsAt;
    return {
      kind: 'rate_limit',
      observation: {
        status,
        rate_limit_type: typeof rateLimitType === 'string' ? rateLimitType : null,
        utilization: typeof info?.utilization === 'number' ? info.utilization : null,
        resets_at: typeof resetsAt === 'number' ? resetsAt : null,
      },
    };
  }
  return null;
}

export interface ChatRelayConfig {
  readonly workerId: string;
  readonly command: string; // 既定 'claude'
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** chunk 送信のバッチ間隔 (ms)。テストでは 0 にできる。 */
  readonly flushIntervalMs: number;
}

export interface ChatRelaySender {
  chatRelayPick(workerId: string): Promise<ChatRelayPicked | null>;
  chatRelayChunks(jobId: string, seqStart: number, texts: readonly string[]): Promise<void>;
  chatRelayComplete(
    jobId: string,
    ok: boolean,
    error?: string,
    rateLimits?: readonly ChatRelayRateLimitObservation[],
  ): Promise<void>;
}

export type ChatRelayOutcome = 'no-job' | 'completed' | 'failed';

/* ------------------------------------------------------------------ */
/* GAP-127: claude CLI 失敗の原因分類                                   */
/* ------------------------------------------------------------------ */

/** UI (接続パネル) が復旧手順を出すための安定タグ。error 文字列の先頭に付く。 */
export const ERROR_TAG_CLAUDE_NOT_FOUND = '[claude-not-found]';
export const ERROR_TAG_CLAUDE_NOT_LOGGED_IN = '[claude-not-logged-in]';

/** 未ログイン/認証切れを示す既知の CLI 出力パターン。 */
const NOT_LOGGED_IN_PATTERN =
  /please run \/login|invalid api key|not logged in|authentication[_ ]error|oauth token|invalid bearer token|credential/i;

/**
 * claude 実行失敗を分類してタグ付き error 文字列にする。
 * 判定材料は result 行の本文 + stderr 末尾 (推測はせず、根拠断片を残す)。
 */
export function classifyRunFailure(run: {
  readonly exitCode: number | null;
  readonly spawnFailed: boolean;
  readonly stderrTail: string;
  readonly resultDetail: string;
}): string {
  if (run.spawnFailed) {
    return `${ERROR_TAG_CLAUDE_NOT_FOUND} claude コマンドを起動できません (未インストールか PATH 不通)`;
  }
  const evidence = `${run.resultDetail}\n${run.stderrTail}`.trim();
  if (NOT_LOGGED_IN_PATTERN.test(evidence)) {
    return `${ERROR_TAG_CLAUDE_NOT_LOGGED_IN} Claude が未ログインです: ${evidence.slice(0, 300)}`;
  }
  return evidence !== ''
    ? `claude 実行失敗 (exit=${run.exitCode}): ${evidence.slice(0, 300)}`
    : `claude 実行失敗 (exit=${run.exitCode})`;
}

/**
 * 1 job を pick → 実行 → 返送する。job が無ければ 'no-job'。
 *
 * chunks 送信は flushIntervalMs ごとのバッチ (delta 1 個ずつ POST すると
 * 応答長に比例して往復が増えるため)。送信失敗はリトライせず job を error で
 * 確定する (SSE 側はタイムアウトかエラーで誠実に終わる)。
 */
export class ChatRelayWorker {
  constructor(
    private readonly api: ChatRelaySender,
    private readonly config: ChatRelayConfig,
  ) {}

  async runOnce(): Promise<ChatRelayOutcome> {
    const picked = await this.api.chatRelayPick(this.config.workerId);
    if (picked === null) return 'no-job';
    const { jobId, systemPrompt, prompt } = picked;

    let seq = 0;
    let pending: string[] = [];
    let sendError: unknown = null;
    let sendChain: Promise<void> = Promise.resolve();

    const flush = (): void => {
      if (pending.length === 0 || sendError !== null) return;
      const batch = pending;
      const seqStart = seq;
      seq += batch.length;
      pending = [];
      // 順序保証のため直列チェーンで送る (並行 POST は seq 順を壊しうる)
      sendChain = sendChain.then(async () => {
        if (sendError !== null) return;
        try {
          await this.api.chatRelayChunks(jobId, seqStart, batch);
        } catch (err: unknown) {
          sendError = err;
        }
      });
    };

    // GAP-119: 実行中に観測した rate_limit_event を window 別に最新値で保持
    const rateLimits = new Map<string, ChatRelayRateLimitObservation>();

    // 実行中に flush を回す — delta は claude の実行と並行して逐次返送される
    const timer = setInterval(flush, Math.max(this.config.flushIntervalMs, 1));
    let run;
    try {
      run = await this.runChild(systemPrompt, prompt, (item) => {
        if (item.kind === 'delta') pending.push(item.text);
        else if (item.kind === 'rate_limit')
          rateLimits.set(item.observation.rate_limit_type ?? 'overall', item.observation);
      });
    } finally {
      clearInterval(timer);
    }
    // partial が 1 つも取れなかった場合は完成 assistant text で代替
    if (seq === 0 && pending.length === 0 && run.assistantText !== '') {
      pending.push(run.assistantText);
    }
    flush();
    await sendChain;

    const ok = run.ok && sendError === null;
    const error = ok
      ? undefined
      : (sendError !== null
          ? `chunk 送信失敗: ${String(sendError)}`
          : run.timedOut
            ? `claude 実行タイムアウト (${this.config.timeoutMs}ms)`
            : classifyRunFailure(run) // GAP-127: 未ログイン/未インストールをタグ付け
        ).slice(0, 2000);
    try {
      await this.api.chatRelayComplete(jobId, ok, error, [...rateLimits.values()]);
    } catch (err: unknown) {
      console.error('[bridge:chat-relay] complete 送信失敗:', err);
      return 'failed';
    }
    return ok ? 'completed' : 'failed';
  }

  private runChild(
    systemPrompt: string,
    prompt: string,
    onItem: (item: ChatStreamItem) => void,
  ): Promise<{
    ok: boolean;
    exitCode: number | null;
    timedOut: boolean;
    assistantText: string;
    spawnFailed: boolean;
    stderrTail: string;
    resultDetail: string;
  }> {
    return new Promise((resolve) => {
      const child = spawn(this.config.command, buildChatArgs(systemPrompt), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: sanitizedChildEnv(this.config.env),
      });
      child.stdin.write(prompt);
      child.stdin.end();

      let timedOut = false;
      let sawDelta = false;
      let assistantText = '';
      let resultOk: boolean | null = null;
      let resultDetail = '';
      let stderrTail = '';
      let buffer = '';
      const handleLine = (line: string): void => {
        const item = parseStreamLine(line);
        if (item === null) return;
        if (item.kind === 'delta') {
          sawDelta = true;
          onItem(item);
        } else if (item.kind === 'rate_limit') {
          onItem(item);
        } else if (item.kind === 'assistant_text') {
          assistantText += item.text;
        } else {
          resultOk = item.ok;
          // GAP-127: 失敗時の result 本文は原因分類の材料 (成功時は不要)
          if (!item.ok && item.detail) resultDetail = item.detail;
        }
      };
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        for (;;) {
          const nl = buffer.indexOf('\n');
          if (nl < 0) break;
          handleLine(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        // GAP-127: 失敗原因の分類材料として末尾だけ保持 (成功時は捨てる)
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.config.timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (buffer !== '') handleLine(buffer);
        resolve({
          ok: !timedOut && code === 0 && resultOk !== false,
          exitCode: code,
          timedOut,
          // partial を受けた場合は assistantText を使わない (二重返送防止)
          assistantText: sawDelta ? '' : assistantText,
          spawnFailed: false,
          stderrTail,
          resultDetail,
        });
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve({
          ok: false,
          exitCode: 127,
          timedOut: false,
          assistantText: '',
          // GAP-127: spawn 自体の失敗 = claude コマンド不在 (ENOENT 等)
          spawnFailed: true,
          stderrTail,
          resultDetail,
        });
      });
    });
  }
}
