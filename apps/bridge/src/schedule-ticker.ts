/**
 * GAP-183 — 自動実行の「時計」を利用者の PC が務める。
 *
 * 経営者判断 (2026-08-19): クラウド (Fly.io) に毎分起きる cron を置くと
 * アイドル停止が効かなくなり、誰も使っていなくても運営に固定費 (実測 $2.02/月)
 * が発生する。Bridge が動いている間はこちらが「今チェックして」と API を
 * 叩けば運営負担はゼロになる。
 *
 * 役割分担:
 *   - PC (このファイル): 時計。HTTP を 1 本叩くだけ。重い処理はしない
 *   - API (Fly.io):      DB から発火時刻を過ぎた行を取り出して実行
 *   - PC の Claude:      AI が要る自動実行だけ API から投げ返される
 *
 * スリープ復帰: 起動して最初の 1 回で「時刻を過ぎていた分」がまとめて実行される
 * (API 側が next_run_at <= now() を拾う設計)。
 */

import type { ScheduleTickResult } from './api-client.js';

/** 既定の確認間隔。PC 上の HTTP 1 本なので短くても負荷にならない。 */
export const DEFAULT_TICK_INTERVAL_MS = 60_000;

export const SCHEDULE_TICKER_ENV = 'ATELIER_BRIDGE_SCHEDULE_TICKER';
export const SCHEDULE_INTERVAL_ENV = 'ATELIER_BRIDGE_SCHEDULE_INTERVAL_MS';

export interface ScheduleTickerApi {
  runDueSchedules(): Promise<ScheduleTickResult>;
}

/** 見張りを動かすか (既定 ON、'0' で明示 OFF)。 */
export function scheduleTickerEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env[SCHEDULE_TICKER_ENV] ?? '').trim() !== '0';
}

/** 確認間隔 (ms)。不正値は既定に落とす。 */
export function tickIntervalMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = Number(env[SCHEDULE_INTERVAL_ENV]);
  if (!Number.isFinite(raw) || raw < 1_000) return DEFAULT_TICK_INTERVAL_MS;
  return raw;
}

export type TickOutcome = 'idle' | 'ran' | 'error';

/** 1 回分の見張り。例外は投げない (時計が止まっても他の機能を巻き込まない)。 */
export async function tickOnce(
  api: ScheduleTickerApi,
  log: (message: string) => void = console.log,
): Promise<TickOutcome> {
  try {
    const r = await api.runDueSchedules();
    if (r.due === 0 && r.scheduled === 0) return 'idle';
    log(
      `[bridge:schedule] 発火 ${r.due} 件 (実行 ${r.ran} / 保留 ${r.deferred} / ` +
        `失敗 ${r.failed} / 次回時刻を確定 ${r.scheduled})`,
    );
    return 'ran';
  } catch (err: unknown) {
    // ユーザートークンで権限が無い / API 未到達 等。時計が止まってもクラウド側の
    // 滑り止め (15 分 cron) が拾うので、ここでは落とさずログのみ。
    log(`[bridge:schedule] 確認に失敗しました (次回再試行します): ${String(err)}`);
    return 'error';
  }
}
