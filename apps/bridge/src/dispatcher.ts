/**
 * Atelier Bridge — Task Dispatcher（基盤雛形）
 *
 * Hermes Agent kanban port をベースに、tickets.json から claimable な
 * タスクを取り、git worktree を作成して PtySession を起動する。
 *
 * T-F-27 では型と空骨格のみ。実体は T-F-28 (Hermes 互換 kanban_tools 移植)
 * と Vibeyard fork 取込後に実装する。
 */

import type { BridgeConfig } from './main.js';
import type { PtySession } from './pty.js';

export type TaskStatus =
  | '準備中'
  | '着手可'
  | '実装中'
  | '要対応'
  | '承認待ち'
  | '完了';

export interface Ticket {
  readonly id: string;
  readonly title: string;
  readonly assigned_employee: string;
  readonly depends_on: readonly string[];
  readonly wave: number;
}

export interface DispatchResult {
  readonly ticketId: string;
  readonly worktreePath: string;
  readonly status: TaskStatus;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export class Dispatcher {
  private readonly sessions = new Map<string, PtySession>();

  constructor(private readonly config: BridgeConfig) {}

  /** 同時実行数の上限。Claude プラン枠を超えないよう制御。 */
  get capacity(): number {
    return this.config.maxConcurrency - this.sessions.size;
  }

  /** 次に着手可能なチケットを 1 件 claim する（実装は T-F-28 で）。 */
  claimNext(): Ticket | null {
    // TODO(T-F-28): tickets.json 読み込み + depends_on 解決 + status=着手可 を返す
    return null;
  }

  /** worktree を作成し PtySession を起動（実装は Vibeyard 取込後）。 */
  async dispatch(_ticket: Ticket): Promise<DispatchResult> {
    throw new Error('not implemented — pending T-F-28 + Vibeyard fork');
  }

  /** 全セッションを graceful shutdown。 */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.kill();
    }
    this.sessions.clear();
  }
}
