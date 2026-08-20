/**
 * GAP-191 — スレッドごとの常駐 Claude プロセス。
 *
 * 直前の実態: GAP-190 で会話は続くようになったが **ターンごとに新プロセス**
 * だったので、実行中のターンへ指示を差し込めなかった（終わるまで待って
 * 次のジョブとして流す = GAP-189 の方式）。
 *
 * 実 CLI で確認した事実 (2026-08-20):
 *   `--input-format stream-json` のプロセスは 1 pid・同一 session_id で
 *   複数ターンを処理し、**1 ターン目の実行中に送った 2 通目も受け取る**。
 *
 * ここでは偽の CLI（行を出す node スクリプト）を相手に、
 *   - プロセスが使い回されること
 *   - 実行中でも送れること
 *   - 使われなければ自分で畳むこと
 *   - 中断で本当に止まること
 * を実プロセスで固定する。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_IDLE_TIMEOUT_MS,
  IDLE_TIMEOUT_ENV,
  PERSISTENT_ENV,
  PersistentSession,
  PersistentSessionPool,
  idleTimeoutMs,
  persistentEnabled,
  sessionKey,
} from '../src/persistent-session.js';

const opened: PersistentSession[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

/** stdin の 1 行ごとに result を返す偽 CLI（本物と同じ stream-json 形）。 */
function fakeCli(dir: string): string {
  const file = join(dir, 'fake-claude.mjs');
  writeFileSync(
    file,
    [
      "let buf = '';",
      'let n = 0;',
      "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S1' }) + '\\n');",
      "process.stdin.on('data', (d) => {",
      '  buf += d.toString();',
      "  const lines = buf.split('\\n');",
      "  buf = lines.pop() ?? '';",
      '  for (const line of lines) {',
      '    if (!line.trim()) continue;',
      '    const msg = JSON.parse(line);',
      '    n += 1;',
      "    const content = msg.message?.content ?? '';",
      "    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'echo:' + content }] } }) + '\\n');",
      "    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'turn' + n + ':' + content, session_id: 'S1' }) + '\\n');",
      '  }',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
  return file;
}

function makeSession(idleMs = 60_000): { session: PersistentSession; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'g191-'));
  const script = fakeCli(dir);
  const session = new PersistentSession({
    command: process.execPath,
    args: [script],
    cwd: dir,
    env: { PATH: process.env.PATH ?? '' },
    idleMs,
  });
  opened.push(session);
  return { session, dir };
}

const waitFor = async (check: () => boolean, ms = 3000): Promise<void> => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout');
};

describe('設定', () => {
  it('既定は常駐 ON、明示 0 で従来動作に戻せる', () => {
    expect(persistentEnabled({})).toBe(true);
    expect(persistentEnabled({ [PERSISTENT_ENV]: '0' })).toBe(false);
    expect(persistentEnabled({ [PERSISTENT_ENV]: '1' })).toBe(true);
  });

  it('アイドル時間は env で変えられ、壊れた値は既定に戻る', () => {
    expect(idleTimeoutMs({})).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(idleTimeoutMs({ [IDLE_TIMEOUT_ENV]: '5000' })).toBe(5000);
    expect(idleTimeoutMs({ [IDLE_TIMEOUT_ENV]: 'ずっと' })).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    expect(idleTimeoutMs({ [IDLE_TIMEOUT_ENV]: '-1' })).toBe(DEFAULT_IDLE_TIMEOUT_MS);
  });

  it('セッションキーは作業フォルダも含める（別スレッドの会話が混ざらない）', () => {
    expect(sessionKey('/a', 'sid')).not.toBe(sessionKey('/b', 'sid'));
    expect(sessionKey('/a', null)).toContain('no-session');
  });
});

describe('常駐プロセス', () => {
  it('1 プロセスのまま複数ターンを処理する（毎回起動し直さない）', async () => {
    const { session } = makeSession();
    const results: string[] = [];
    session.onLine((line) => {
      const ev = JSON.parse(line) as { type?: string; result?: string };
      if (ev.type === 'result') results.push(String(ev.result));
    });
    session.start();
    const pid = session.pid;

    expect(session.send('一つ目')).toBe(true);
    await waitFor(() => results.length === 1);
    expect(session.send('二つ目')).toBe(true);
    await waitFor(() => results.length === 2);

    expect(results).toEqual(['turn1:一つ目', 'turn2:二つ目']);
    expect(session.pid).toBe(pid);
    expect(session.alive).toBe(true);
  });

  it('実行中でも次の指示を送れる（追い足しが待たされない）', async () => {
    const { session } = makeSession();
    const results: string[] = [];
    session.onLine((line) => {
      const ev = JSON.parse(line) as { type?: string; result?: string };
      if (ev.type === 'result') results.push(String(ev.result));
    });
    session.start();
    session.send('作業中');
    session.send('追い足し', { asFollowUp: true });
    await waitFor(() => results.length === 2);
    expect(results).toEqual(['turn1:作業中', 'turn2:追い足し']);
    expect(session.injected).toEqual(['追い足し']);
  });

  it('死んでいるプロセスへは送らず false を返す（送ったつもりを作らない）', () => {
    const { session } = makeSession();
    expect(session.alive).toBe(false);
    expect(session.send('まだ起動していない')).toBe(false);
  });

  it('使われなければ自分で畳む（利用者の PC に居座らない）', async () => {
    const { session } = makeSession(150);
    session.start();
    expect(session.alive).toBe(true);
    await waitFor(() => !session.alive, 5000);
    expect(session.alive).toBe(false);
  });

  it('中断すると実際にプロセスが止まる', async () => {
    const { session } = makeSession();
    session.start();
    expect(session.alive).toBe(true);
    session.kill();
    await waitFor(() => !session.alive, 5000);
    expect(session.alive).toBe(false);
  });

  it('start() は生きているプロセスを作り直さない', () => {
    const { session } = makeSession();
    session.start();
    const pid = session.pid;
    session.start();
    expect(session.pid).toBe(pid);
  });
});

describe('セッション台帳', () => {
  it('同じキーなら使い回し、違うキーなら別プロセス', () => {
    const pool = new PersistentSessionPool();
    const a = makeSession();
    const b = makeSession();
    a.session.start();
    b.session.start();
    const got1 = pool.acquire('k1', () => a.session);
    const got2 = pool.acquire('k1', () => b.session);
    const got3 = pool.acquire('k2', () => b.session);
    expect(got2).toBe(got1);
    expect(got3).not.toBe(got1);
    expect(pool.size).toBe(2);
    pool.closeAll();
  });

  it('死んだプロセスは作り直す', () => {
    const pool = new PersistentSessionPool();
    const dead = makeSession();
    const alive = makeSession();
    alive.session.start();
    const got = pool.acquire('k', () => dead.session);
    expect(got).toBe(dead.session);
    const again = pool.acquire('k', () => alive.session);
    expect(again).toBe(alive.session);
    pool.closeAll();
  });
});
