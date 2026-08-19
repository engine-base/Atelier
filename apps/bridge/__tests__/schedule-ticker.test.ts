/**
 * GAP-183: 自動実行の「時計」を利用者の PC が務める。
 *
 * クラウドに毎分の cron を置くと Fly.io のアイドル停止が効かず、誰も使っていなくても
 * 運営に固定費が出る。PC が動いている間はこちらが叩く (運営コスト 0 円)。
 */

import { describe, expect, it, vi } from 'vitest';

import { runHeadless } from '../src/headless.js';
import {
  DEFAULT_TICK_INTERVAL_MS,
  scheduleTickerEnabled,
  tickIntervalMs,
  tickOnce,
  type ScheduleTickerApi,
} from '../src/schedule-ticker.js';

const EMPTY = { due: 0, ran: 0, deferred: 0, failed: 0, scheduled: 0 };

describe('scheduleTickerEnabled', () => {
  it('既定は ON (何も設定しなくても時計が動く)', () => {
    expect(scheduleTickerEnabled({})).toBe(true);
  });

  it("'0' で明示的に OFF", () => {
    expect(scheduleTickerEnabled({ ATELIER_BRIDGE_SCHEDULE_TICKER: '0' })).toBe(false);
  });
});

describe('tickIntervalMs', () => {
  it('未設定は既定 60 秒', () => {
    expect(tickIntervalMs({})).toBe(DEFAULT_TICK_INTERVAL_MS);
  });

  it('明示指定を尊重する', () => {
    expect(tickIntervalMs({ ATELIER_BRIDGE_SCHEDULE_INTERVAL_MS: '5000' })).toBe(5000);
  });

  it('不正値・短すぎる値は既定に落とす (API を叩き潰さない)', () => {
    expect(tickIntervalMs({ ATELIER_BRIDGE_SCHEDULE_INTERVAL_MS: 'abc' })).toBe(
      DEFAULT_TICK_INTERVAL_MS,
    );
    expect(tickIntervalMs({ ATELIER_BRIDGE_SCHEDULE_INTERVAL_MS: '10' })).toBe(
      DEFAULT_TICK_INTERVAL_MS,
    );
  });
});

describe('tickOnce', () => {
  it('発火が無ければ静か (ログを汚さない)', async () => {
    const log = vi.fn();
    const api: ScheduleTickerApi = { runDueSchedules: async () => EMPTY };
    expect(await tickOnce(api, log)).toBe('idle');
    expect(log).not.toHaveBeenCalled();
  });

  it('発火したら内訳を報告する', async () => {
    const log = vi.fn();
    const api: ScheduleTickerApi = {
      runDueSchedules: async () => ({ due: 2, ran: 1, deferred: 1, failed: 0, scheduled: 0 }),
    };
    expect(await tickOnce(api, log)).toBe('ran');
    expect(String(log.mock.calls[0]?.[0])).toContain('発火 2 件');
  });

  it('API 失敗で例外を投げない (時計が止まっても他機能を巻き込まない)', async () => {
    const log = vi.fn();
    const api: ScheduleTickerApi = {
      runDueSchedules: async () => {
        throw new Error('network down');
      },
    };
    expect(await tickOnce(api, log)).toBe('error');
    expect(String(log.mock.calls[0]?.[0])).toContain('再試行');
  });
});

describe('runHeadless との配線', () => {
  it('起動直後に 1 回動く (スリープ中に過ぎた分をその場で拾う)', async () => {
    const runDueSchedules = vi.fn(async () => EMPTY);
    const code = await runHeadless({
      env: { ATELIER_BRIDGE_TOKEN: 'tk', ATELIER_BRIDGE_CHAT_RELAY: '0' },
      argv: [],
      makeRunner: () => ({ runOnce: async () => 'no-task' as const }),
      makeScheduleTicker: () => ({ runDueSchedules }),
    });
    expect(code).toBe(0);
    expect(runDueSchedules).toHaveBeenCalledTimes(1);
  });

  it("ATELIER_BRIDGE_SCHEDULE_TICKER='0' なら一切叩かない", async () => {
    const runDueSchedules = vi.fn(async () => EMPTY);
    await runHeadless({
      env: {
        ATELIER_BRIDGE_TOKEN: 'tk',
        ATELIER_BRIDGE_CHAT_RELAY: '0',
        ATELIER_BRIDGE_SCHEDULE_TICKER: '0',
      },
      argv: [],
      makeRunner: () => ({ runOnce: async () => 'no-task' as const }),
      makeScheduleTicker: () => ({ runDueSchedules }),
    });
    expect(runDueSchedules).not.toHaveBeenCalled();
  });
});
