/**
 * GAP-199 実 e2e: クラウドが乗っ取られても PC 側で止まることを、実プロセスで確認する。
 *
 * ビルド済み dist を使い、**本物の ChatRelayWorker** を偽の claude 実行ファイル
 * (シェルスクリプト) に対して走らせる。検証するのは 3 点:
 *
 *   ① 悪意のある接続リンク (見知らぬ https) を受理しないこと
 *   ② サーバーが auto を指示しても、PC 側の上限 approve まで格下げされ、
 *      **実際に起動された claude の引数**が bypassPermissions ではないこと
 *   ③ 作業フォルダの外を指すシンボリックリンクをアップロードしないこと
 *
 * さらに、ローカル監査ログに「サーバー指定 auto / 実際 approve」が残ることを見る。
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dist = new URL('../../apps/bridge/dist/', import.meta.url);
const { parseConnectUrl } = await import(new URL('deep-link.js', dist));
const { ChatRelayWorker, collectNewArtifacts, snapshotArtifactFiles } = await import(
  new URL('chat-relay.js', dist)
);
const { auditFilePath } = await import(new URL('security.js', dist));

const failures = [];
const check = (ok, label) => {
  console.log(`  ${ok ? 'OK  ' : 'NG  '} ${label}`);
  if (!ok) failures.push(label);
};

/* ------------------------------------------------------------------ */
console.log('[1] 悪意のある接続リンクを受理しないこと');
check(
  parseConnectUrl('atelier-bridge://connect?api=https%3A%2F%2Fevil.example&token=t', {}) === null,
  '見知らぬ https の指示元は保存しない',
);
check(
  parseConnectUrl(
    'atelier-bridge://connect?api=https%3A%2F%2Fatelier-api-eb.fly.dev&token=t',
    {},
  )?.apiUrl === 'https://atelier-api-eb.fly.dev',
  '本番の指示元は今までどおり受理する',
);

/* ------------------------------------------------------------------ */
console.log('[2] サーバーが auto を指示しても PC 側の上限まで格下げされること');

const home = mkdtempSync(join(tmpdir(), 'g199-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'g199-ws-'));
// 起動された claude の引数をそのまま記録する偽 CLI
const argsLog = join(home, 'args.txt');
const fakeClaude = join(home, 'fake-claude.sh');
writeFileSync(
  fakeClaude,
  `#!/bin/sh\nprintf '%s\\n' "$@" > ${argsLog}\n` +
    // approve モードでは親が stdin へ 1 行書く。1 行だけ受けて先へ進む
    `read _line 2>/dev/null || true\n` +
    `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}'\n` +
    `echo '{"type":"result","subtype":"success","is_error":false,"result":"done"}'\n`,
  { mode: 0o755 },
);
chmodSync(fakeClaude, 0o755);

const uploads = [];
const sender = {
  picked: {
    jobId: 'job-g199',
    systemPrompt: 'SYS',
    prompt: 'こんにちは',
    // サーバー (= 乗っ取られた側) は最強のモードを指示してくる
    toolsMode: 'auto',
  },
  async chatRelayPick() {
    const p = this.picked;
    this.picked = null;
    return p;
  },
  async chatRelayChunks() {},
  async chatRelayCreateApproval() {
    return 'ap-1';
  },
  async chatRelayApprovalDecision() {
    return 'allow';
  },
  async chatRelayControl() {
    return false;
  },
  async chatRelayUploadArtifacts(_jobId, artifacts) {
    uploads.push(...artifacts);
  },
  async chatRelayWorkspaceSeed() {
    return [];
  },
  async chatRelayComplete() {},
};

const worker = new ChatRelayWorker(sender, {
  workerId: 'e2e',
  command: fakeClaude,
  timeoutMs: 20_000,
  env: {
    HOME: home,
    PATH: process.env.PATH,
    ATELIER_BRIDGE_CHAT_WORKSPACE: workspace,
    // ★ この PC の上限 (本人が決める設定)
    ATELIER_BRIDGE_MAX_TOOLS_MODE: 'approve',
  },
  flushIntervalMs: 0,
  approvalPollMs: 10,
  approvalTimeoutMs: 1_000,
  cancelPollMs: 10_000,
  apiOrigin: 'https://atelier-api-eb.fly.dev',
  auditHome: home,
});

const outcome = await worker.runOnce();
console.log(`  runOnce -> ${outcome}`);
const spawnedArgs = readFileSync(argsLog, 'utf8').split('\n');
console.log(`  実際に起動された引数: ${spawnedArgs.filter((a) => a.startsWith('--')).join(' ')}`);
check(
  !spawnedArgs.includes('bypassPermissions'),
  'サーバーが auto と言っても bypassPermissions では起動しない',
);
check(
  spawnedArgs.includes('--permission-prompt-tool'),
  '格下げ先の approve (承認プロンプト) で起動している',
);

const auditLines = readFileSync(auditFilePath(home), 'utf8').trim().split('\n');
const audit = JSON.parse(auditLines[auditLines.length - 1]);
console.log(`  監査ログ: ${JSON.stringify(audit)}`);
check(
  audit.requestedMode === 'auto' && audit.effectiveMode === 'approve',
  '監査ログに「サーバー指定 auto / 実際 approve」が残る',
);
check(audit.apiOrigin === 'https://atelier-api-eb.fly.dev', '監査ログに指示元が残る');

/* ------------------------------------------------------------------ */
console.log('[3] 作業フォルダの外を指すリンクを持ち出さないこと');
const secretDir = mkdtempSync(join(tmpdir(), 'g199-secret-'));
const secret = join(secretDir, 'id_rsa');
writeFileSync(secret, '-----BEGIN PRIVATE KEY-----\nTOP SECRET\n');
const artDir = mkdtempSync(join(tmpdir(), 'g199-art-'));
mkdirSync(join(artDir, 'sub'), { recursive: true });
const before = snapshotArtifactFiles(artDir);
writeFileSync(join(artDir, 'ok.html'), '<p>正当な成果物</p>');
symlinkSync(secret, join(artDir, 'stolen.html'));
const collected = collectNewArtifacts(artDir, before);
const names = collected.map((a) => a.fileName);
console.log(`  集めた成果物: ${JSON.stringify(names)}`);
check(names.includes('ok.html'), '正当な成果物は今までどおり集める');
check(!names.includes('stolen.html'), '外を指すリンクは集めない');
check(
  !collected.some((a) => (a.html ?? '').includes('TOP SECRET')),
  '秘密鍵の中身が送信対象に入っていない',
);

/* ------------------------------------------------------------------ */
if (failures.length > 0) {
  console.log('\nFAIL:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nPASS: 接続先の固定 / モード上限の格下げ / 持ち出し防止 を実プロセスで確認');
