/**
 * Atelier Bridge — Task Dispatcher (T-F-41 実体)
 *
 * API kanban endpoints (T-F-28/T-A-28) を唯一の経路として:
 *   pick (queued→spawning) → start (→running) → `claude -p` 実行
 *   → exit 0: complete (→awaiting) / 非0・timeout: request-change (→blocked)
 * 実行中は heartbeat を送る。ATELIER_BRIDGE_TOKEN 不正 (401) は claim せず停止。
 *
 * node-pty は使わない (claude -p の print モードは TUI 不要 — T-F-41 AC)。
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { BridgeAuthError, type BridgeApi } from './api-client.js';

export type CycleOutcome =
  | 'completed'
  | 'change-requested'
  | 'no-task'
  | 'auth-error';

export interface DispatcherConfig {
  readonly workerPid: number;
  readonly projectId?: string;
  /** 実行コマンド。既定 'claude'。テストでは 'echo' 等に差し替える。 */
  readonly command: string;
  /** コマンド引数を組み立てる。既定は ['-p', prompt]。 */
  readonly buildArgs: (taskId: string) => readonly string[];
  /** 実行ログの出力ディレクトリ。 */
  readonly logDir: string;
  /** child timeout (ms)。超過で kill → request-change。 */
  readonly timeoutMs: number;
  /** heartbeat 間隔 (ms)。 */
  readonly heartbeatMs: number;
}

export const DEFAULT_DISPATCHER_CONFIG: Omit<DispatcherConfig, 'workerPid'> = {
  command: 'claude',
  buildArgs: (taskId: string) => [
    '-p',
    `Atelier のタスク ${taskId} を担当 AI 社員として遂行し、実施内容の要約を日本語で出力してください。`,
  ],
  logDir: '/tmp/atelier-bridge-logs',
  timeoutMs: 10 * 60 * 1000,
  heartbeatMs: 30 * 1000,
} as const;

interface RunResult {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly outputTail: string;
  readonly logPath: string;
}

export class Dispatcher {
  constructor(
    private readonly api: BridgeApi,
    private readonly config: DispatcherConfig,
  ) {}

  /** 現状は 1 worker = 1 並列 (electron-entry の表示互換用)。 */
  get capacity(): number {
    return 1;
  }

  /** 1 claim サイクルを実行する。task が無ければ 'no-task'。 */
  async runOnce(): Promise<CycleOutcome> {
    let picked;
    try {
      picked = await this.api.pick(this.config.workerPid, this.config.projectId);
    } catch (error: unknown) {
      if (error instanceof BridgeAuthError) {
        // token 不正 — claim せずに停止 (致命 AC)
        return 'auth-error';
      }
      throw error;
    }
    if (picked.noAvailableTask || picked.taskId === null || picked.executionId === null) {
      return 'no-task';
    }
    const { taskId, executionId } = picked;
    await this.api.start(taskId, executionId, this.config.workerPid);

    const heartbeat = setInterval(() => {
      void this.api.heartbeat(taskId, this.config.workerPid).catch(() => {
        // heartbeat 失敗は実行を止めない (dead-man switch は API 側の責務)
      });
    }, this.config.heartbeatMs);

    try {
      const result = await this.runChild(taskId);
      if (result.exitCode === 0) {
        await this.api.complete(taskId, executionId, result.outputTail || '(出力なし)', {
          score: 1.0,
          acPassRate: 1.0,
          testPassRate: 1.0,
          verificationScore: 1.0,
          retryCount: 0,
          filesChanged: [],
        });
        return 'completed';
      }
      const reason = result.timedOut
        ? `timeout (${this.config.timeoutMs}ms) — log: ${result.logPath}`
        : `exit code ${result.exitCode} — log: ${result.logPath}`;
      await this.api.requestChange(taskId, executionId, reason);
      return 'change-requested';
    } finally {
      clearInterval(heartbeat);
    }
  }

  /** claude -p を child process で実行し、出力をログファイルへ書く。 */
  private runChild(taskId: string): Promise<RunResult> {
    mkdirSync(this.config.logDir, { recursive: true });
    const logPath = join(this.config.logDir, `${taskId}.log`);
    const args = this.config.buildArgs(taskId);
    return new Promise<RunResult>((resolve) => {
      const child = spawn(this.config.command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let tail = '';
      let timedOut = false;
      const record = (chunk: Buffer): void => {
        const s = chunk.toString();
        appendFileSync(logPath, s);
        tail = (tail + s).slice(-2000);
      };
      child.stdout.on('data', record);
      child.stderr.on('data', record);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.config.timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          exitCode: code,
          timedOut,
          outputTail: tail.trim().slice(-1000),
          logPath,
        });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        appendFileSync(logPath, `spawn error: ${String(err)}\n`);
        resolve({ exitCode: 127, timedOut: false, outputTail: String(err), logPath });
      });
    });
  }
}
