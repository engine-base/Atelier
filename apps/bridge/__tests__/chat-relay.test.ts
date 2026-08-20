/**
 * GAP-114: チャットのローカル実行リレー (chat-relay.ts) のテスト。
 *
 * API は fake (呼び出し記録)、child は node の fake-claude スクリプトで
 * stream-json の delta / assistant / result 経路を検証する。
 */

import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type {
  ChatRelayApprovalDecision,
  ChatRelayChunkKind,
  ChatRelayPicked,
  ChatRelayRateLimitObservation,
} from '../src/api-client.js';
import {
  ChatRelayWorker,
  ERROR_TAG_CLAUDE_NOT_FOUND,
  ERROR_TAG_CLAUDE_NOT_LOGGED_IN,
  MAX_ARTIFACT_BYTES,
  buildChatArgs,
  buildControlResponse,
  canResumeSession,
  chatRelayEnabled,
  chatWorkspaceDir,
  classifyRunFailure,
  collectNewArtifacts,
  extractToolDetails,
  parseStreamLine,
  planSession,
  sanitizedChildEnv,
  sessionTranscriptPath,
  snapshotArtifactFiles,
  summarizeToolInput,
  type ChatRelaySender,
} from '../src/chat-relay.js';

class FakeSender implements ChatRelaySender {
  picked: ChatRelayPicked | null = null;
  readonly chunks: Array<{
    seqStart: number;
    texts: readonly string[];
    kinds?: readonly ChatRelayChunkKind[];
  }> = [];
  /** GAP-134: 承認要求の記録 + 返す決定 (テストが設定) */
  readonly approvals: Array<{ tool: string; summary: string }> = [];
  approvalDecision: ChatRelayApprovalDecision = 'allow';
  readonly completes: Array<{
    ok: boolean;
    error?: string;
    rateLimits?: readonly ChatRelayRateLimitObservation[];
    /** GAP-190: 実際に使ったセッションの実測値 */
    session?: { readonly sessionId: string; readonly resumed: boolean };
  }> = [];
  /** GAP-137: 成果物送信の記録 (complete との順序検証用に順序も記録) */
  readonly artifactUploads: Array<
    readonly { readonly fileName: string; readonly html: string }[]
  > = [];
  readonly callOrder: string[] = [];

  async chatRelayPick(): Promise<ChatRelayPicked | null> {
    return this.picked;
  }
  async chatRelayChunks(
    _jobId: string,
    seqStart: number,
    texts: readonly string[],
    kinds?: readonly ChatRelayChunkKind[],
  ): Promise<void> {
    this.chunks.push({ seqStart, texts, ...(kinds ? { kinds } : {}) });
    // GAP-189: 「本文が出てきたのを見てから停止を押した」を決定的に再現する
    if (this.cancelAfterChunks !== null && this.chunks.length >= this.cancelAfterChunks) {
      this.cancel = true;
    }
  }
  async chatRelayCreateApproval(_jobId: string, tool: string, summary: string): Promise<string> {
    this.approvals.push({ tool, summary });
    return `ap-${this.approvals.length}`;
  }
  async chatRelayApprovalDecision(): Promise<ChatRelayApprovalDecision> {
    return this.approvalDecision;
  }
  /** GAP-189: 中断の見張り。テストが cancel を立てると PC 上の子が kill される。 */
  cancel = false;
  /** N 回目の chunk 受信で cancel を立てる (人が本文を見てから止める再現)。 */
  cancelAfterChunks: number | null = null;
  /** true にすると control ポーリング自体が失敗する (通信不良の再現)。 */
  controlFails = false;
  controlCalls = 0;
  async chatRelayControl(): Promise<boolean> {
    this.controlCalls += 1;
    if (this.controlFails) throw new Error('network down');
    return this.cancel;
  }
  async chatRelayUploadArtifacts(
    _jobId: string,
    artifacts: readonly { readonly fileName: string; readonly html: string }[],
  ): Promise<void> {
    this.callOrder.push('artifacts');
    this.artifactUploads.push(artifacts);
  }
  /** GAP-141/161/166: 作業場シード (テストが設定)。HTML と base64 が混ざる。 */
  seed: readonly {
    readonly fileName: string;
    readonly html?: string;
    readonly contentB64?: string;
  }[] = [];
  async chatRelayWorkspaceSeed(): Promise<
    readonly {
      readonly fileName: string;
      readonly html?: string;
      readonly contentB64?: string;
    }[]
  > {
    this.callOrder.push('seed');
    return this.seed;
  }
  async chatRelayComplete(
    _jobId: string,
    ok: boolean,
    error?: string,
    rateLimits?: readonly ChatRelayRateLimitObservation[],
    session?: { readonly sessionId: string; readonly resumed: boolean },
  ): Promise<void> {
    this.callOrder.push('complete');
    this.completes.push({ ok, error, rateLimits, session });
  }
}

/** stream-json 行を出力する fake-claude 実行ファイルを作る。 */
function makeFakeClaude(lines: readonly string[], exitCode = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const path = join(dir, 'fake-claude.mjs');
  const script = [
    '#!/usr/bin/env node',
    '// stdin (prompt) を読み切ってから出力する (実 CLI と同じ順序)',
    'process.stdin.resume();',
    "process.stdin.on('data', () => {});",
    "process.stdin.on('end', () => {",
    ...lines.map((l) => `  console.log(${JSON.stringify(l)});`),
    `  process.exit(${exitCode});`,
    '});',
  ].join('\n');
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

const DELTA_A = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'やあ、' } },
});
const DELTA_B = JSON.stringify({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'こんにちは' } },
});
const ASSISTANT = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: '完成応答' }] },
});
const RESULT_OK = JSON.stringify({ type: 'result', subtype: 'success', result: 'done' });
const RESULT_ERR = JSON.stringify({ type: 'result', subtype: 'error_during_execution' });

function makeWorker(sender: FakeSender, command: string): ChatRelayWorker {
  return new ChatRelayWorker(sender, {
    workerId: 'test#1',
    command,
    timeoutMs: 10_000,
    env: { PATH: process.env.PATH },
    flushIntervalMs: 10,
  });
}

describe('parseStreamLine', () => {
  it('text_delta を delta として取り出す', () => {
    expect(parseStreamLine(DELTA_A)).toEqual({ kind: 'delta', text: 'やあ、' });
  });
  it('assistant 完成 message から text を取り出す', () => {
    expect(parseStreamLine(ASSISTANT)).toEqual({ kind: 'assistant_text', text: '完成応答' });
  });
  it('result の成否を判定する (GAP-127: 本文 detail も保持)', () => {
    expect(parseStreamLine(RESULT_OK)).toEqual({ kind: 'result', ok: true, detail: 'done' });
    expect(parseStreamLine(RESULT_ERR)).toEqual({ kind: 'result', ok: false });
    expect(
      parseStreamLine(
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          result: 'Invalid API key · Please run /login',
        }),
      ),
    ).toEqual({
      kind: 'result',
      ok: false,
      detail: 'Invalid API key · Please run /login',
    });
  });
  it('rate_limit_event は実 CLI の camelCase フィールドを読む (GAP-128 実測)', () => {
    // 実 CLI 出力の実測値そのまま: rateLimitType / resetsAt が camelCase で、
    // utilization は含まれない
    const line = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        resetsAt: 1786980000,
        rateLimitType: 'five_hour',
        overageStatus: 'rejected',
      },
      uuid: 'u',
      session_id: 's',
    });
    expect(parseStreamLine(line)).toEqual({
      kind: 'rate_limit',
      observation: {
        status: 'allowed',
        rate_limit_type: 'five_hour',
        utilization: null,
        resets_at: 1786980000,
      },
    });
  });
  it('rate_limit_event を観測値として取り出す (GAP-119)', () => {
    const line = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rate_limit_type: 'five_hour',
        utilization: 0.42,
        resets_at: 1_800_000_000,
      },
      uuid: 'u',
      session_id: 's',
    });
    expect(parseStreamLine(line)).toEqual({
      kind: 'rate_limit',
      observation: {
        status: 'allowed_warning',
        rate_limit_type: 'five_hour',
        utilization: 0.42,
        resets_at: 1_800_000_000,
      },
    });
  });
  it('rate_limit_event の不正 status は null (実値以外を転送しない)', () => {
    expect(
      parseStreamLine(
        JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'bogus' } }),
      ),
    ).toBeNull();
    expect(parseStreamLine(JSON.stringify({ type: 'rate_limit_event' }))).toBeNull();
  });
  it('対象外の行 (init/非JSON/thinking delta) は null', () => {
    expect(parseStreamLine('{"type":"system","subtype":"init"}')).toBeNull();
    expect(parseStreamLine('not json')).toBeNull();
    expect(
      parseStreamLine(
        JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'x' } },
        }),
      ),
    ).toBeNull();
  });
});

describe('sanitizedChildEnv', () => {
  it('API キー系 3 変数を除去し他は保持する (サブスク課金の保証)', () => {
    const env = sanitizedChildEnv({
      ANTHROPIC_API_KEY: 'sk-ant',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      CLAUDE_CODE_API_KEY: 'key',
      PATH: '/usr/bin',
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });

  it('GAP-143: CLAUDE_* / CLAUDECODE 系を除去する (親セッションの取り合い防止)', () => {
    const env = sanitizedChildEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_SESSION_ID: 'sess-1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_PID: '123',
      PATH: '/usr/bin',
      IS_SANDBOX: '1',
    });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_PID).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
    expect(env.IS_SANDBOX).toBe('1');
  });
});

describe('buildChatArgs / chatRelayEnabled', () => {
  it('stream-json + partial + 1 turn 固定の引数を組む', () => {
    const args = buildChatArgs('SYS');
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('SYS');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--max-turns');
    // GAP-143: off はツール完全無効 (気まぐれ tool_use での間欠 exit 1 防止)
    expect(args[args.indexOf('--tools') + 1]).toBe('');
  });
  it("既定 ON、'0' で明示 OFF", () => {
    expect(chatRelayEnabled({})).toBe(true);
    expect(chatRelayEnabled({ ATELIER_BRIDGE_CHAT_RELAY: '0' })).toBe(false);
  });
});

describe('ChatRelayWorker.runOnce', () => {
  it('job が無ければ no-job で child を起動しない', async () => {
    const sender = new FakeSender();
    const worker = makeWorker(sender, '/nonexistent-command');
    expect(await worker.runOnce()).toBe('no-job');
    expect(sender.chunks).toHaveLength(0);
    expect(sender.completes).toHaveLength(0);
  });

  it('delta を chunks として返送し complete(ok) する', async () => {
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'PROMPT', toolsMode: 'off' };
    const worker = makeWorker(sender, makeFakeClaude([DELTA_A, DELTA_B, RESULT_OK]));
    expect(await worker.runOnce()).toBe('completed');
    const sent = sender.chunks.flatMap((c) => [...c.texts]);
    expect(sent.join('')).toBe('やあ、こんにちは');
    // seq は 0 起点の連番
    expect(sender.chunks[0]?.seqStart).toBe(0);
    expect(sender.completes).toEqual([{ ok: true, error: undefined, rateLimits: [] }]);
  });

  it('GAP-135: prependArgs (npm-shim 解決の cli.js) が実 spawn に配線される', async () => {
    // Windows npm 版の解決結果 (node <cli.js> <claude引数...>) と同じ形を
    // 実プロセスで検証する: command=Node 実体 / prependArgs=fake CLI スクリプト
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'PROMPT', toolsMode: 'off' };
    const worker = new ChatRelayWorker(sender, {
      workerId: 'test#1',
      command: process.execPath,
      prependArgs: [makeFakeClaude([DELTA_A, RESULT_OK])],
      timeoutMs: 10_000,
      env: { PATH: process.env.PATH },
      flushIntervalMs: 10,
    });
    expect(await worker.runOnce()).toBe('completed');
    expect(sender.chunks.flatMap((c) => [...c.texts]).join('')).toBe('やあ、');
    expect(sender.completes).toEqual([{ ok: true, error: undefined, rateLimits: [] }]);
  });

  it('partial 不達時は assistant 完成 text で代替する', async () => {
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'PROMPT', toolsMode: 'off' };
    const worker = makeWorker(sender, makeFakeClaude([ASSISTANT, RESULT_OK]));
    expect(await worker.runOnce()).toBe('completed');
    expect(sender.chunks.flatMap((c) => [...c.texts])).toEqual(['完成応答']);
  });

  it('exit 非 0 は complete(ok=false) + error 文字列', async () => {
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'PROMPT', toolsMode: 'off' };
    const worker = makeWorker(sender, makeFakeClaude([], 3));
    expect(await worker.runOnce()).toBe('failed');
    expect(sender.completes[0]?.ok).toBe(false);
    expect(sender.completes[0]?.error).toContain('exit=3');
  });

  it('result が error subtype なら exit 0 でも failed', async () => {
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'PROMPT', toolsMode: 'off' };
    const worker = makeWorker(sender, makeFakeClaude([DELTA_A, RESULT_ERR], 0));
    expect(await worker.runOnce()).toBe('failed');
    expect(sender.completes[0]?.ok).toBe(false);
  });

  it('rate_limit_event を window 別の最新値で complete に同送する (GAP-119)', async () => {
    const rl = (type: string, utilization: number) =>
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          rate_limit_type: type,
          utilization,
          resets_at: 1_800_000_000,
        },
      });
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'PROMPT', toolsMode: 'off' };
    const worker = makeWorker(
      sender,
      // five_hour は 2 回出る → 最新値 (0.5) だけが送られる
      makeFakeClaude([rl('five_hour', 0.4), DELTA_A, rl('seven_day', 0.1), rl('five_hour', 0.5), RESULT_OK]),
    );
    expect(await worker.runOnce()).toBe('completed');
    const sent = sender.completes[0]?.rateLimits ?? [];
    expect(sent).toHaveLength(2);
    expect(sent.find((o) => o.rate_limit_type === 'five_hour')?.utilization).toBe(0.5);
    expect(sent.find((o) => o.rate_limit_type === 'seven_day')?.utilization).toBe(0.1);
  });
});

describe('classifyRunFailure (GAP-127 — 失敗原因の分類タグ)', () => {
  const base = { exitCode: 1, spawnFailed: false, stderrTail: '', resultDetail: '' };

  it('spawn 失敗 (claude コマンド不在) は not-found タグ', () => {
    const msg = classifyRunFailure({ ...base, spawnFailed: true, exitCode: 127 });
    expect(msg.startsWith(ERROR_TAG_CLAUDE_NOT_FOUND)).toBe(true);
  });

  it('result 本文の "Please run /login" は not-logged-in タグ + 根拠を残す', () => {
    const msg = classifyRunFailure({
      ...base,
      resultDetail: 'Invalid API key · Please run /login',
    });
    expect(msg.startsWith(ERROR_TAG_CLAUDE_NOT_LOGGED_IN)).toBe(true);
    expect(msg).toContain('Please run /login');
  });

  it('stderr の認証エラーでも not-logged-in と判定する', () => {
    const msg = classifyRunFailure({ ...base, stderrTail: 'authentication_error: token expired' });
    expect(msg.startsWith(ERROR_TAG_CLAUDE_NOT_LOGGED_IN)).toBe(true);
  });

  it('分類できない失敗はタグ無しで exit code と根拠を返す (推測で決めつけない)', () => {
    const msg = classifyRunFailure({ ...base, stderrTail: 'segfault' });
    expect(msg).toContain('exit=1');
    expect(msg).toContain('segfault');
    expect(msg.includes('[claude-')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* GAP-134: PC 操作 (tools_mode) — 引数 / 解釈 / 承認往復              */
/* ------------------------------------------------------------------ */

describe('buildChatArgs — tools_mode (GAP-134)', () => {
  it('off は従来どおり 1 往復・ツールなし', () => {
    const args = buildChatArgs('SYS', 'off');
    expect(args).toContain('--max-turns');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('1');
    expect(args).not.toContain('--permission-prompt-tool');
  });
  it('auto は Claude Code 同等ツール + bypassPermissions + 25 turns', () => {
    const args = buildChatArgs('SYS', 'auto');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Write,Edit,Bash,Glob,Grep');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('25');
  });
  it('approve は stdio 承認プロトコル + stream-json 入力', () => {
    const args = buildChatArgs('SYS', 'approve');
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('stdio');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
    expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(args).not.toContain('--allowedTools'); // 載せると聞かずに自動許可される
  });
});

describe('extractToolDetails (GAP-148 — Claude Code 風の実値行)', () => {
  it('assistant 完成メッセージの tool_use から {tool, summary} を取り出す', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '実行します' },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/index.html' } },
        ],
      },
    });
    expect(extractToolDetails(line)).toEqual([
      { tool: 'Bash', summary: 'npm test' },
      { tool: 'Edit', summary: 'src/index.html' },
    ]);
  });

  it('assistant 以外・tool_use 無しは空配列', () => {
    expect(extractToolDetails('{"type":"result","subtype":"success"}')).toEqual([]);
    expect(
      extractToolDetails(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'x' }] },
        }),
      ),
    ).toEqual([]);
    expect(extractToolDetails('not json')).toEqual([]);
  });
});

describe('parseStreamLine — GAP-134 追加分', () => {
  it('content_block_start の tool_use を tool_start として取り出す', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } },
    });
    expect(parseStreamLine(line)).toEqual({ kind: 'tool_start', tool: 'Bash' });
  });
  it('control_request can_use_tool を permission_request として取り出す', () => {
    const line = JSON.stringify({
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/tmp/a' } },
    });
    expect(parseStreamLine(line)).toEqual({
      kind: 'permission_request',
      requestId: 'req-1',
      tool: 'Write',
      input: { file_path: '/tmp/a' },
    });
  });
  it('can_use_tool 以外の control_request は無視する', () => {
    const line = JSON.stringify({
      type: 'control_request',
      request_id: 'req-2',
      request: { subtype: 'initialize' },
    });
    expect(parseStreamLine(line)).toBeNull();
  });
});

describe('buildControlResponse / summarizeToolInput (GAP-134)', () => {
  it('allow は updatedInput を返す実プロトコル形式', () => {
    const line = buildControlResponse('req-1', 'allow', { command: 'ls' });
    const obj = JSON.parse(line);
    expect(obj.response.request_id).toBe('req-1');
    expect(obj.response.response).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });
  it('deny は拒否メッセージを返す', () => {
    const obj = JSON.parse(buildControlResponse('req-1', 'deny', {}));
    expect(obj.response.response.behavior).toBe('deny');
  });
  it('要約は Bash=command / Write=file_path / 長文は切り詰め', () => {
    expect(summarizeToolInput('Bash', { command: 'echo hi' })).toBe('echo hi');
    expect(summarizeToolInput('Write', { file_path: '/tmp/x', content: '秘密' })).toBe('/tmp/x');
    expect(summarizeToolInput('Bash', { command: 'x'.repeat(300) })).toHaveLength(200);
  });
  it('作業フォルダは env 優先・既定 ~/AtelierChatWork', () => {
    expect(chatWorkspaceDir({ ATELIER_BRIDGE_CHAT_WORKSPACE: '/tmp/ws' })).toBe('/tmp/ws');
    expect(chatWorkspaceDir({})).toContain('AtelierChatWork');
  });
});

/** GAP-134: 承認往復する対話型 fake-claude (許可要求 → stdin の決定を待って続行)。 */
function makeApprovalFakeClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-approve-'));
  const path = join(dir, 'fake-claude-approve.mjs');
  const script = `#!/usr/bin/env node
// user メッセージ受信 → 許可要求を出す → control_response を待つ →
// allow なら tool_start + delta + result(success) / deny なら delta + result
let buf = '';
const out = (o) => console.log(JSON.stringify(o));
process.stdin.on('data', (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (obj.type === 'user') {
      out({ type: 'control_request', request_id: 'req-1',
            request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'touch out.txt' } } });
    } else if (obj.type === 'control_response') {
      const behavior = obj.response?.response?.behavior;
      if (behavior === 'allow') {
        out({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } } });
        out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '実行しました' } } });
      } else {
        out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '拒否を受けました' } } });
      }
      out({ type: 'result', subtype: 'success', result: 'done' });
      process.exit(0);
    }
  }
});
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

describe('ChatRelayWorker — approve 往復 (GAP-134)', () => {
  it('許可要求 → サーバー承認 allow → control_response → tool 実況 + 本文が返る', async () => {
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'ファイル作って', toolsMode: 'approve' };
    sender.approvalDecision = 'allow';
    const worker = new ChatRelayWorker(sender, {
      workerId: 'test#1',
      command: makeApprovalFakeClaude(),
      timeoutMs: 10_000,
      env: { PATH: process.env.PATH, ATELIER_BRIDGE_CHAT_WORKSPACE: tmpdir() },
      flushIntervalMs: 10,
      approvalPollMs: 10,
      approvalTimeoutMs: 5_000,
    });
    expect(await worker.runOnce()).toBe('completed');
    expect(sender.approvals).toEqual([{ tool: 'Bash', summary: 'touch out.txt' }]);
    const all = sender.chunks.flatMap((c) =>
      c.texts.map((t, i) => ({ text: t, kind: c.kinds?.[i] ?? 'delta' })),
    );
    expect(all).toContainEqual({ text: 'Bash', kind: 'tool' });
    expect(all.map((c) => c.text).join('')).toContain('実行しました');
  });

  it('サーバー承認 deny → CLI に deny が返り、本文で拒否を報告して完走する', async () => {
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'ファイル作って', toolsMode: 'approve' };
    sender.approvalDecision = 'deny';
    const worker = new ChatRelayWorker(sender, {
      workerId: 'test#1',
      command: makeApprovalFakeClaude(),
      timeoutMs: 10_000,
      env: { PATH: process.env.PATH, ATELIER_BRIDGE_CHAT_WORKSPACE: tmpdir() },
      flushIntervalMs: 10,
      approvalPollMs: 10,
      approvalTimeoutMs: 5_000,
    });
    expect(await worker.runOnce()).toBe('completed');
    const joined = sender.chunks.flatMap((c) => c.texts).join('');
    expect(joined).toContain('拒否を受けました');
  });
});


/* ------------------------------------------------------------------ */
/* GAP-137: PC 操作の成果物検出とモック反映送信                          */
/* ------------------------------------------------------------------ */

describe('snapshotArtifactFiles / collectNewArtifacts (GAP-137/145)', () => {
  it('新規/更新された HTML のみを新しい順に集める (スキップ dir・上限つき)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    writeFileSync(join(root, 'old.html'), '<html>old</html>');
    utimesSync(join(root, 'old.html'), new Date(1000000), new Date(1000000));
    const before = snapshotArtifactFiles(root);

    // 新規 2 件 + 既存の更新 1 件 + 対象外 (txt / node_modules)
    writeFileSync(join(root, 'a.html'), '<html><title>LP</title></html>');
    utimesSync(join(root, 'a.html'), new Date(3000000), new Date(3000000));
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'b.htm'), '<html>b</html>');
    utimesSync(join(root, 'sub', 'b.htm'), new Date(4000000), new Date(4000000));
    writeFileSync(join(root, 'old.html'), '<html>updated</html>');
    utimesSync(join(root, 'old.html'), new Date(2000000), new Date(2000000));
    writeFileSync(join(root, 'note.txt'), 'x');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'skip.html'), '<html>skip</html>');

    const artifacts = collectNewArtifacts(root, before);
    expect(artifacts.map((a) => a.fileName)).toEqual(['sub/b.htm', 'a.html', 'old.html']);
    expect(artifacts[0]?.html).toBe('<html>b</html>');
  });

  it('サイズ上限超の HTML は取り込まない', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const before = snapshotArtifactFiles(root);
    writeFileSync(join(root, 'big.html'), 'x'.repeat(MAX_ARTIFACT_BYTES + 1));
    writeFileSync(join(root, 'ok.html'), '<html>ok</html>');
    const names = collectNewArtifacts(root, before).map((a) => a.fileName);
    expect(names).toEqual(['ok.html']);
  });

  it('GAP-145: バイナリ成果物 (png/pptx 等) は base64 で拾い、対象外拡張子は拾わない', () => {
    const root = mkdtempSync(join(tmpdir(), 'ws-'));
    const before = snapshotArtifactFiles(root);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    writeFileSync(join(root, 'logo.png'), png);
    writeFileSync(join(root, 'deck.pptx'), Buffer.from('PK-fake-pptx'));
    writeFileSync(join(root, 'app.exe'), Buffer.from('MZ')); // 対象外
    const artifacts = collectNewArtifacts(root, before);
    const byName = new Map(artifacts.map((a) => [a.fileName, a]));
    expect(byName.has('app.exe')).toBe(false);
    expect(byName.get('logo.png')?.contentB64).toBe(png.toString('base64'));
    expect(byName.get('logo.png')?.html).toBeUndefined();
    expect(byName.get('deck.pptx')?.contentB64).toBe(
      Buffer.from('PK-fake-pptx').toString('base64'),
    );
  });
});

describe('ChatRelayWorker 成果物送信 (GAP-137)', () => {
  /** cwd に HTML を書いてから完走する fake CLI。 */
  function makeArtifactFakeClaude(): string {
    const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
    const path = join(dir, 'fake-claude.mjs');
    writeFileSync(
      path,
      [
        '#!/usr/bin/env node',
        "import { writeFileSync } from 'node:fs';",
        'process.stdin.resume();',
        "process.stdin.on('data', () => {});",
        "process.stdin.on('end', () => {",
        "  writeFileSync('lp.html', '<html><title>LP</title><body>done</body></html>');",
        `  console.log(${JSON.stringify(DELTA_A)});`,
        `  console.log(${JSON.stringify(RESULT_OK)});`,
        '  process.exit(0);',
        '});',
      ].join('\n'),
    );
    chmodSync(path, 0o755);
    return path;
  }

  it('tools job は新規 HTML を complete の前に送信する', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ws-'));
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'LP作って', toolsMode: 'auto' };
    const worker = new ChatRelayWorker(sender, {
      workerId: 'test#1',
      command: makeArtifactFakeClaude(),
      timeoutMs: 10_000,
      env: { PATH: process.env.PATH, ATELIER_BRIDGE_CHAT_WORKSPACE: workspace },
      flushIntervalMs: 10,
    });
    expect(await worker.runOnce()).toBe('completed');
    expect(sender.artifactUploads).toHaveLength(1);
    expect(sender.artifactUploads[0]?.map((a) => a.fileName)).toEqual(['lp.html']);
    expect(sender.artifactUploads[0]?.[0]?.html).toContain('<title>LP</title>');
    // seed → 実行 → artifacts → complete の順 (artifacts は complete より前)
    expect(sender.callOrder).toEqual(['seed', 'artifacts', 'complete']);
  });

  it('toolsMode=off はスナップショットも送信もしない', async () => {
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'こんにちは', toolsMode: 'off' };
    const worker = new ChatRelayWorker(sender, {
      workerId: 'test#1',
      command: makeFakeClaude([DELTA_A, RESULT_OK]),
      timeoutMs: 10_000,
      env: { PATH: process.env.PATH },
      flushIntervalMs: 10,
    });
    expect(await worker.runOnce()).toBe('completed');
    expect(sender.artifactUploads).toHaveLength(0);
    expect(sender.callOrder).toEqual(['complete']);
  });
});

describe('ChatRelayWorker 作業場シード (GAP-141)', () => {
  it('ツールジョブは開始前に正本を展開し、未編集の seed は再取り込みしない', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ws-'));
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: '確認して', toolsMode: 'auto' };
    sender.seed = [
      { fileName: '料金ページ.html', html: '<html><title>料金ページ</title>v2</html>' },
      { fileName: '../evil.html', html: 'x' }, // パス逸脱は無視される
    ];
    const worker = new ChatRelayWorker(sender, {
      workerId: 'test#1',
      command: makeFakeClaude([DELTA_A, RESULT_OK]),
      timeoutMs: 10_000,
      env: { PATH: process.env.PATH, ATELIER_BRIDGE_CHAT_WORKSPACE: workspace },
      flushIntervalMs: 10,
    });
    expect(await worker.runOnce()).toBe('completed');
    // 正本がローカルに展開されている
    const { readFileSync: rf, existsSync: ex } = await import('node:fs');
    expect(rf(join(workspace, '料金ページ.html'), 'utf8')).toContain('v2');
    // 逸脱ファイルは workspace 外に書かれていない (basename 化され上書きされる場合も
    // workspace 内に留まる)
    expect(ex(join(workspace, '..', 'evil.html'))).toBe(false);
    // 未編集の seed は成果物として送信されない (展開後スナップショット)
    expect(sender.artifactUploads).toHaveLength(0);
    // seed → (実行) → complete の順
    expect(sender.callOrder[0]).toBe('seed');
    expect(sender.callOrder[sender.callOrder.length - 1]).toBe('complete');
  });

  it('GAP-169: html が null の項目もバイナリとして展開される (Excel/PDF が PC に届く)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ws-b64-'));
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: '直して', toolsMode: 'auto' };
    // サーバーが未設定フィールドを null で返すケース (実 API で発生した形)。
    // 以前は `html !== undefined` で判定していたため null が「値あり」となり
    // writeFileSync(target, null) が投げ、ファイルが黙って落ちていた。
    const xlsx = Buffer.from('PK\u0003\u0004atelier-xlsx', 'utf8');
    sender.seed = [
      {
        fileName: '見積.xlsx',
        html: null as unknown as undefined,
        contentB64: xlsx.toString('base64'),
      },
    ];
    const worker = new ChatRelayWorker(sender, {
      workerId: 'test#1',
      command: makeFakeClaude([DELTA_A, RESULT_OK]),
      timeoutMs: 10_000,
      env: { PATH: process.env.PATH, ATELIER_BRIDGE_CHAT_WORKSPACE: workspace },
      flushIntervalMs: 10,
    });
    expect(await worker.runOnce()).toBe('completed');
    const { readFileSync: rf } = await import('node:fs');
    expect(rf(join(workspace, '見積.xlsx')).equals(xlsx)).toBe(true);
  });

  it('off ジョブは seed を取得しない', async () => {
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'こんにちは', toolsMode: 'off' };
    const worker = makeWorker(sender, makeFakeClaude([DELTA_A, RESULT_OK]));
    expect(await worker.runOnce()).toBe('completed');
    expect(sender.callOrder).toEqual(['complete']);
  });
});

/* ------------------------------------------------------------------ */
/* GAP-189: 中断 — PC 上の claude を実際に止める                        */
/* ------------------------------------------------------------------ */

/** 出力してから長く居座る fake CLI (中断されない限り終わらない)。 */
function makeSlowClaude(lines: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'slow-claude-'));
  const path = join(dir, 'slow-claude.mjs');
  writeFileSync(
    path,
    [
      '#!/usr/bin/env node',
      'process.stdin.resume();',
      "process.stdin.on('data', () => {});",
      ...lines.map((l) => `console.log(${JSON.stringify(l)});`),
      '// 中断されるまで終わらない (実行中の状態を作る)',
      'setInterval(() => {}, 1000);',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

function makeCancellableWorker(sender: FakeSender, command: string): ChatRelayWorker {
  return new ChatRelayWorker(sender, {
    workerId: 'test#cancel',
    command,
    timeoutMs: 30_000,
    env: { PATH: process.env.PATH },
    flushIntervalMs: 5,
    cancelPollMs: 10, // 見張りを速く回す
  });
}

describe('ChatRelayWorker — 中断 (GAP-189)', () => {
  it('サーバーが中断を告げたら PC 上の claude を実際に止め、そこまでの本文は送る', async () => {
    const sender = new FakeSender();
    // 本文が 1 度届いた後に「停止」を押された状態を作る (実際の使われ方)
    sender.cancelAfterChunks = 1;
    sender.picked = { jobId: 'j-cancel', systemPrompt: 'SYS', prompt: 'P', toolsMode: 'off' };

    const started = Date.now();
    const worker = makeCancellableWorker(sender, makeSlowClaude([DELTA_A]));
    const outcome = await worker.runOnce();
    const elapsed = Date.now() - started;

    // 居座る子プロセスなのに、タイムアウト (30 秒) を待たずに戻る = 実際に止めた
    expect(outcome).toBe('completed');
    expect(elapsed).toBeLessThan(10_000);
    expect(sender.controlCalls).toBeGreaterThan(0);
    // そこまでに出た本文は捨てない
    expect(sender.chunks.flatMap((c) => [...c.texts]).join('')).toContain('やあ、');
    // 中断であることが complete に残る (成功で塗り潰さない)
    expect(sender.completes).toHaveLength(1);
    expect(sender.completes[0]?.ok).toBe(false);
    expect(sender.completes[0]?.error).toContain('[cancelled]');
  }, 20_000);

  it('中断されたときは成果物をツールへ取り込まない (途中の状態を反映しない)', async () => {
    const sender = new FakeSender();
    sender.cancel = true;
    sender.picked = { jobId: 'j-cancel2', systemPrompt: 'SYS', prompt: 'P', toolsMode: 'auto' };
    const worker = makeCancellableWorker(sender, makeSlowClaude([DELTA_A]));
    await worker.runOnce();
    expect(sender.artifactUploads).toHaveLength(0);
    expect(sender.callOrder).not.toContain('artifacts');
  }, 20_000);

  it('見張りの通信が失敗しても中断扱いにしない (通信不良で仕事を殺さない)', async () => {
    const sender = new FakeSender();
    sender.controlFails = true;
    sender.picked = { jobId: 'j-net', systemPrompt: 'SYS', prompt: 'P', toolsMode: 'off' };
    const worker = makeCancellableWorker(sender, makeFakeClaude([DELTA_A, RESULT_OK]));
    expect(await worker.runOnce()).toBe('completed');
    expect(sender.completes[0]?.ok).toBe(true);
  }, 20_000);

  it('中断が告げられていなければ普通に完走する', async () => {
    const sender = new FakeSender();
    sender.cancel = false;
    sender.picked = { jobId: 'j-ok', systemPrompt: 'SYS', prompt: 'P', toolsMode: 'off' };
    const worker = makeCancellableWorker(sender, makeFakeClaude([DELTA_A, DELTA_B, RESULT_OK]));
    expect(await worker.runOnce()).toBe('completed');
    expect(sender.completes[0]?.ok).toBe(true);
    expect(sender.chunks.flatMap((c) => [...c.texts]).join('')).toBe('やあ、こんにちは');
  }, 20_000);
});

/* ------------------------------------------------------------------ */
/* GAP-190: スレッドごとに同じ Claude セッションで走らせる              */
/* ------------------------------------------------------------------ */

describe('sessionTranscriptPath / canResumeSession (GAP-190)', () => {
  it('cwd の / を - に置換した実パスを決定的に求める（実測に一致）', () => {
    const p = sessionTranscriptPath('/tmp/g190work', 'abc-123', { HOME: '/home/u' });
    expect(p).toBe('/home/u/.claude/projects/-tmp-g190work/abc-123.jsonl');
  });

  it('Windows の区切りも同じ規則へ寄せる', () => {
    const p = sessionTranscriptPath('C:\\Users\\me\\Work', 'sid', { HOME: '/h' });
    expect(p).toBe('/h/.claude/projects/C:-Users-me-Work/sid.jsonl');
  });

  it('実ファイルがあれば再開できる / 無ければできない（推測しない）', () => {
    const home = mkdtempSync(join(tmpdir(), 'g190-home-'));
    const cwd = '/tmp/g190-cwd';
    const dir = join(home, '.claude', 'projects', '-tmp-g190-cwd');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'exists.jsonl'), '{}\n');

    expect(canResumeSession(cwd, 'exists', { HOME: home })).toBe(true);
    expect(canResumeSession(cwd, 'missing', { HOME: home })).toBe(false);
    // ID 未指定はセッションを使わない
    expect(canResumeSession(cwd, undefined, { HOME: home })).toBe(false);
  });
});

describe('planSession (GAP-190)', () => {
  const home = mkdtempSync(join(tmpdir(), 'g190-plan-'));
  const cwd = '/tmp/g190-plan-cwd';
  const dir = join(home, '.claude', 'projects', '-tmp-g190-plan-cwd');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'known.jsonl'), '{}\n');

  it('この PC にセッションがあれば再開し、履歴は送らない（プラン枠の節約）', () => {
    const plan = planSession(
      { prompt: '新しい発言', sessionId: 'known', promptFull: '履歴ぜんぶ + 新しい発言' },
      cwd,
      { HOME: home },
    );
    expect(plan).toEqual({ sessionId: 'known', resume: true, prompt: '新しい発言' });
  });

  it('別の PC など実体が無ければ、その ID で新規に始めて履歴込みを送る（会話が飛ばない）', () => {
    const plan = planSession(
      { prompt: '新しい発言', sessionId: 'unknown', promptFull: '履歴ぜんぶ + 新しい発言' },
      cwd,
      { HOME: home },
    );
    expect(plan).toEqual({
      sessionId: 'unknown',
      resume: false,
      prompt: '履歴ぜんぶ + 新しい発言',
    });
  });

  it('履歴込みが渡されていなければ prompt をそのまま使う（落とさない）', () => {
    const plan = planSession({ prompt: '本文', sessionId: 'unknown' }, cwd, { HOME: home });
    expect(plan?.prompt).toBe('本文');
  });

  it('セッション指定が無いジョブ（モック生成等）はセッションを使わない', () => {
    expect(planSession({ prompt: '本文' }, cwd, { HOME: home })).toBeNull();
  });
});

describe('buildChatArgs — セッション引数 (GAP-190)', () => {
  it('再開時は --resume を付ける', () => {
    const args = buildChatArgs('SYS', 'off', { sessionId: 'sid-1', resume: true });
    expect(args[args.indexOf('--resume') + 1]).toBe('sid-1');
    expect(args).not.toContain('--session-id');
  });

  it('新規時は --session-id で ID を固定する（次回から再開できる）', () => {
    const args = buildChatArgs('SYS', 'off', { sessionId: 'sid-2', resume: false });
    expect(args[args.indexOf('--session-id') + 1]).toBe('sid-2');
    expect(args).not.toContain('--resume');
  });

  it('セッション未使用なら従来どおり付けない', () => {
    const args = buildChatArgs('SYS', 'off', null);
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--session-id');
  });

  it('再開時も --append-system-prompt は毎回渡す（案件状況・RAG を最新にする）', () => {
    const args = buildChatArgs('SYS-NOW', 'off', { sessionId: 'sid', resume: true });
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('SYS-NOW');
  });
});

describe('ChatRelayWorker — セッションの実測値を報告する (GAP-190)', () => {
  it('新規セッションで走ったら resumed=false を返す', async () => {
    const sender = new FakeSender();
    sender.picked = {
      jobId: 'j-sess',
      systemPrompt: 'SYS',
      prompt: '新しい発言',
      toolsMode: 'off',
      sessionId: '11111111-1111-4111-8111-111111111111',
      promptFull: '履歴込み',
    };
    const worker = makeWorker(sender, makeFakeClaude([DELTA_A, RESULT_OK]));
    expect(await worker.runOnce()).toBe('completed');
    expect(sender.completes[0]?.session).toEqual({
      sessionId: '11111111-1111-4111-8111-111111111111',
      resumed: false,
    });
  });

  it('セッション指定が無いジョブでは報告しない（無いものを送らない）', async () => {
    const sender = new FakeSender();
    sender.picked = { jobId: 'j-nos', systemPrompt: 'SYS', prompt: 'P', toolsMode: 'off' };
    const worker = makeWorker(sender, makeFakeClaude([DELTA_A, RESULT_OK]));
    await worker.runOnce();
    expect(sender.completes[0]?.session).toBeUndefined();
  });
});
