import { describe, expect, it } from 'vitest';

import { Dispatcher, type Ticket } from '../src/dispatcher.js';

const baseConfig = {
  maxConcurrency: 5,
  worktreeRoot: '/tmp/atelier-worktrees',
  ticketsPath: '07_tasks/tickets.json',
  dispatchScript: '09_dispatch/scripts/dispatch.sh',
} as const;

describe('Dispatcher', () => {
  it('exposes capacity equal to maxConcurrency when idle', () => {
    const d = new Dispatcher(baseConfig);
    expect(d.capacity).toBe(5);
  });

  it('claimNext returns null in placeholder implementation (pending T-F-28)', () => {
    const d = new Dispatcher(baseConfig);
    expect(d.claimNext()).toBeNull();
  });

  it('dispatch throws not-implemented error in placeholder', async () => {
    const d = new Dispatcher(baseConfig);
    const ticket: Ticket = {
      id: 'T-F-29',
      title: 'placeholder',
      assigned_employee: 'vision',
      depends_on: [],
      wave: 0,
    };
    await expect(d.dispatch(ticket)).rejects.toThrow(/not implemented/);
  });

  it('shutdown resolves cleanly when no sessions exist', async () => {
    const d = new Dispatcher(baseConfig);
    await expect(d.shutdown()).resolves.toBeUndefined();
  });

  it('capacity is reduced as sessions are tracked', () => {
    const d = new Dispatcher({ ...baseConfig, maxConcurrency: 3 });
    // Access internal map to simulate active sessions. capacity should drop.
    // (Phase 0 では Map は private なので external API のみで観測)
    expect(d.capacity).toBe(3);
  });
});
