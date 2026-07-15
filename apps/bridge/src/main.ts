/**
 * Atelier Bridge — Electron メインプロセス（基盤雛形）
 *
 * 完成形（後続タスク）:
 *   - Vibeyard fork を取り込み、Electron + xterm.js + node-pty で
 *     ローカル Claude Code を 5-10 並列起動する dispatcher を提供する
 *   - Hermes 互換 kanban_tools (T-F-28) と連動し、tickets.json から
 *     タスクを取り出し → git worktree 作成 → JIT CLAUDE.md 配置 →
 *     claude code 起動 → 完了/失敗を Atelier クラウドに SSE で報告
 *   - 9 工程 (hearing → release-planning) と連動した skill 注入
 *
 * このファイルは T-F-27 で雛形のみ作成。Vibeyard 取り込みは別タスク。
 */

import { ApiClient } from './api-client.js';
import { DEFAULT_DISPATCHER_CONFIG, Dispatcher } from './dispatcher.js';

export interface BridgeConfig {
  readonly maxConcurrency: number; // 5-10 並列
  readonly worktreeRoot: string; // git worktree のルート
  readonly ticketsPath: string; // 07_tasks/tickets.json
  readonly dispatchScript: string; // 09_dispatch/scripts/dispatch.sh
}

const DEFAULT_CONFIG: BridgeConfig = {
  maxConcurrency: 5,
  worktreeRoot: '/tmp/atelier-worktrees',
  ticketsPath: '07_tasks/tickets.json',
  dispatchScript: '09_dispatch/scripts/dispatch.sh',
} as const;

/** T-F-41: API 経由の claim ループ dispatcher を生成する (headless.ts と共用)。 */
export function createBridge(_config: Partial<BridgeConfig> = {}): Dispatcher {
  const token = process.env.ATELIER_BRIDGE_TOKEN ?? '';
  const api = new ApiClient({
    baseUrl: process.env.ATELIER_API_URL ?? 'http://127.0.0.1:8000',
    token,
  });
  return new Dispatcher(api, {
    ...DEFAULT_DISPATCHER_CONFIG,
    workerPid: process.pid,
  });
}

export { DEFAULT_CONFIG };

// Electron app.whenReady() / BrowserWindow 生成は Vibeyard 取り込み時に追加
