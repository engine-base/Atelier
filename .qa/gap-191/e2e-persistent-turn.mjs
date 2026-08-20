/**
 * GAP-191 実 e2e: **本物の claude CLI** に対して、
 *   ① 1 プロセス・同一 session_id のまま複数ターンを処理できるか
 *   ② **実行中のターンの最中**に送った指示が受け取られるか
 *   ③ Bridge の PersistentSession (ビルド済み dist) で同じことができるか
 * を実測する。スタブは 0。
 *
 * 実行には claude CLI へのログインが要る。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dist = new URL('../../apps/bridge/dist/', import.meta.url);
const { PersistentSession } = await import(new URL('persistent-session.js', dist));

const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? 'OK  ' : 'NG  '} ${label}`);
  if (!ok) failures.push(label);
};

const cwd = mkdtempSync(join(tmpdir(), 'g191-e2e-'));
console.log(`[0] 作業フォルダ: ${cwd}`);

const session = new PersistentSession({
  command: 'claude',
  args: [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--max-turns', '10',
  ],
  cwd,
  env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
  idleMs: 120_000,
});

const results = [];
const sessionIds = new Set();
let firstOutput = 0;
const t0 = Date.now();
session.onLine((line) => {
  let ev;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev.session_id) sessionIds.add(ev.session_id);
  if (firstOutput === 0 && (ev.type === 'assistant' || ev.type === 'stream_event')) {
    firstOutput = Date.now() - t0;
  }
  if (ev.type === 'result') {
    results.push({ at: Date.now() - t0, text: String(ev.result ?? ''), session: ev.session_id });
    console.log(`  <<< result #${results.length} (t=${Date.now() - t0}ms): ${String(ev.result ?? '').replace(/\n/g, ' ').slice(0, 80)}`);
  }
});

const waitFor = async (fn, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

console.log('\n[1] 常駐プロセスを起動して 1 通目を送る');
session.start();
const pid = session.pid;
console.log(`  pid=${pid}`);
check(
  session.send(
    '1 から 12 までを 1 つずつ、順番に日本語で数えて。各数字を別の行に書いて。' +
      '最後に「COUNT-DONE」と書いて。',
  ),
  '1 通目を送れた (時間のかかる指示)',
);

console.log('\n[2] 1 通目の**実行中**に 2 通目を送る（終わるのを待たない）');
// 1 通目の出力が始まった = まだ走っている、その瞬間に割り込む
await waitFor(() => firstOutput > 0, 60_000);
const beforeInject = results.length;
const injectedAt = Date.now() - t0;
check(
  session.send('追加: 最後に「ADDED-OK」とだけ書いて短く答えて。', { asFollowUp: true }),
  `2 通目を送れた (t=${injectedAt}ms / 1 通目の出力開始 t=${firstOutput}ms)`,
);
check(
  beforeInject === 0,
  `送った時点で 1 通目はまだ実行中だった (完了 result 数=${beforeInject})`,
);

console.log('\n[3] 2 つの result が返るのを待つ');
const got2 = await waitFor(() => results.length >= 2, 90_000);
check(got2, '2 ターンぶんの result が返った');
if (got2) {
  check(results[1].text.includes('ADDED-OK'), '2 通目の指示が反映されている (ADDED-OK)');
  check(session.pid === pid, `同じプロセスのまま (pid=${session.pid})`);
  check(sessionIds.size === 1, `同じ session_id のまま (${[...sessionIds].join(', ')})`);
  check(session.alive, 'result のあともプロセスが生きている (次のターンで使い回せる)');
  check(session.injected.length === 1, '実行中に流し込んだ指示が記録されている');
}

console.log('\n[4] 中断すると実際に止まる');
session.kill();
const stopped = await waitFor(() => !session.alive, 8000);
check(stopped, 'kill でプロセスが止まった');

console.log('');
if (failures.length > 0) {
  console.log('FAIL:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('PASS: 1 プロセス・同一セッションで複数ターン / 実行中の割り込み / 中断 を実 CLI で確認');
