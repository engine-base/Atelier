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

import type { ChatRelayPicked, ChatRelayRateLimitObservation } from '../src/api-client.js';
import {
  ChatRelayWorker,
  ERROR_TAG_CLAUDE_NOT_FOUND,
  ERROR_TAG_CLAUDE_NOT_LOGGED_IN,
  buildChatArgs,
  chatRelayEnabled,
  classifyRunFailure,
  parseStreamLine,
  sanitizedChildEnv,
  type ChatRelaySender,
} from '../src/chat-relay.js';

class FakeSender implements ChatRelaySender {
  picked: ChatRelayPicked | null = null;
  readonly chunks: Array<{ seqStart: number; texts: readonly string[] }> = [];
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
  ): Promise<void> {
    this.chunks.push({ seqStart, texts });
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
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'PROMPT' };
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
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'PROMPT' };
    const worker = makeWorker(sender, makeFakeClaude([ASSISTANT, RESULT_OK]));
    expect(await worker.runOnce()).toBe('completed');
    expect(sender.chunks.flatMap((c) => [...c.texts])).toEqual(['完成応答']);
  });

  it('exit 非 0 は complete(ok=false) + error 文字列', async () => {
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'PROMPT' };
    const worker = makeWorker(sender, makeFakeClaude([], 3));
    expect(await worker.runOnce()).toBe('failed');
    expect(sender.completes[0]?.ok).toBe(false);
    expect(sender.completes[0]?.error).toContain('exit=3');
  });

  it('result が error subtype なら exit 0 でも failed', async () => {
    const sender = new FakeSender();
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'PROMPT' };
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
    sender.picked = { jobId: 'j1', systemPrompt: 'SYS', prompt: 'PROMPT' };
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
