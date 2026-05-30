/**
 * T-US-07 realtime tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _internal, createRealtimeClient, type Notification } from '../../lib/realtime';

describe('_internal.buildUrl', () => {
  it('appends ?topic=', () => {
    expect(_internal.buildUrl('/api/realtime', 'noti')).toBe('/api/realtime?topic=noti');
  });
  it('appends &topic= when ? already exists', () => {
    expect(_internal.buildUrl('/api/realtime?user=u1', 'noti')).toBe(
      '/api/realtime?user=u1&topic=noti',
    );
  });
  it('strips trailing slash from endpoint', () => {
    expect(_internal.buildUrl('/api/realtime/', 'x')).toBe('/api/realtime?topic=x');
  });
});

class FakeES {
  static instances: FakeES[] = [];
  url: string;
  listeners: Record<string, EventListener[]> = {};
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeES.instances.push(this);
  }
  addEventListener(type: string, l: EventListener) {
    (this.listeners[type] ??= []).push(l);
  }
  removeEventListener(type: string, l: EventListener) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((x) => x !== l);
  }
  emit(data: string) {
    const ev = new MessageEvent('message', { data });
    for (const l of this.listeners['message'] ?? []) l(ev);
  }
  close() {
    this.closed = true;
  }
}

describe('createRealtimeClient (T-US-07)', () => {
  beforeEach(() => {
    FakeES.instances = [];
  });
  afterEach(() => vi.useRealTimers());

  it('subscribes to a topic, decodes JSON messages, and invokes handler', () => {
    const handler = vi.fn<(n: Notification) => void>();
    const client = createRealtimeClient({
      endpoint: '/api/realtime',
      eventSourceClass: FakeES as unknown as typeof EventSource,
    });
    const sub = client.subscribe('noti', handler);
    expect(FakeES.instances.length).toBe(1);
    const noti: Notification = { id: 'n1', level: 'info', message: 'hi', createdAt: 't' };
    FakeES.instances[0]!.emit(JSON.stringify(noti));
    expect(handler).toHaveBeenCalledWith(noti);
    sub.close();
    expect(FakeES.instances[0]!.closed).toBe(true);
  });

  it('ignores malformed JSON without throwing', () => {
    const handler = vi.fn();
    const client = createRealtimeClient({
      endpoint: '/api/realtime',
      eventSourceClass: FakeES as unknown as typeof EventSource,
    });
    client.subscribe('noti', handler);
    FakeES.instances[0]!.emit('not-json');
    expect(handler).not.toHaveBeenCalled();
  });

  it('throws when EventSource is not available', () => {
    expect(() =>
      createRealtimeClient({
        endpoint: '/x',
        eventSourceClass: undefined as unknown as typeof EventSource,
      }).subscribe('t', () => undefined),
    ).toThrow(/EventSource/);
  });
});
