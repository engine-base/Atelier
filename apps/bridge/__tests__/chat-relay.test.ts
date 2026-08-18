/**
 * GAP-114: チャットのローカル実行リレー (chat-relay.ts) のテスト。
 *
 * API は fake (呼び出し記録)、child は node の fake-claude スクリプトで
 * stream-json の delta / assistant / result 経路を検証する。
 */

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
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
  buildChatArgs,
  buildControlResponse,
  chatRelayEnabled,
  chatWorkspaceDir,
  classifyRunFailure,
  parseStreamLine,
  sanitizedChildEnv,
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
  }> = [];

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
  }
  async chatRelayCreateApproval(_jobId: string, tool: string, summary: string): Promise<string> {
    this.approvals.push({ tool, summary });
    return `ap-${this.approvals.length}`;
  }
  async chatRelayApprovalDecision(): Promise<ChatRelayApprovalDecision> {
    return this.approvalDecision;
  }
  async chatRelayComplete(
    _jobId: string,
    ok: boolean,
    error?: string,
    rateLimits?: readonly ChatRelayRateLimitObservation[],
  ): Promise<void> {
    this.completes.push({ ok, error, rateLimits });
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
});

describe('buildChatArgs / chatRelayEnabled', () => {
  it('stream-json + partial + 1 turn 固定の引数を組む', () => {
    const args = buildChatArgs('SYS');
    expect(args).toContain('--append-system-prompt');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe('SYS');
    expect(args).toContain('--include-partial-messages');
    expect(args).toContain('--max-turns');
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

