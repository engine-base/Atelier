/**
 * Realtime 購読 — T-US-07 (通知ベル / SSE 経由)
 *
 * Atelier の Realtime は Supabase Realtime (Postgres CDC) 経由が本命だが、
 * 本ファイルは UI 層からの抽象 (subscribe / unsubscribe) を提供する。
 * 内部実装は SSE / WebSocket を差し替え可能 (factory pattern)。
 *
 * - subscribe(topic, handler) → { close() }
 * - factory は globalThis.EventSource を使う (SSE)、テスト時に差し替え
 */

export type NotificationLevel = 'info' | 'success' | 'error';

export interface Notification {
  readonly id: string;
  readonly level: NotificationLevel;
  readonly message: string;
  readonly createdAt: string;
}

export interface RealtimeSubscription {
  readonly close: () => void;
}

export interface RealtimeFactoryOptions {
  /** SSE endpoint base (例: /api/realtime) */
  readonly endpoint: string;
  /** EventSource 差し替え (テスト用) */
  readonly eventSourceClass?: typeof EventSource;
}

/** topic 名から SSE URL を構築 */
function buildUrl(endpoint: string, topic: string): string {
  const e = endpoint.replace(/\/$/, '');
  const sep = e.includes('?') ? '&' : '?';
  return `${e}${sep}topic=${encodeURIComponent(topic)}`;
}

/** Realtime subscription factory (一般化) */
export function createRealtimeClient(opts: RealtimeFactoryOptions) {
  const ES = opts.eventSourceClass ?? globalThis.EventSource;
  if (!ES) {
    throw new Error('EventSource is not available in this environment');
  }
  return {
    subscribe(topic: string, handler: (n: Notification) => void): RealtimeSubscription {
      const es = new ES(buildUrl(opts.endpoint, topic));
      const onMessage = (e: MessageEvent<string>) => {
        try {
          const parsed = JSON.parse(e.data) as Notification;
          handler(parsed);
        } catch {
          // 無視 (handler 側でログ取る想定)
        }
      };
      es.addEventListener('message', onMessage as EventListener);
      return {
        close: () => {
          es.removeEventListener('message', onMessage as EventListener);
          es.close();
        },
      };
    },
  };
}

export type RealtimeClient = ReturnType<typeof createRealtimeClient>;

export const _internal = { buildUrl };
