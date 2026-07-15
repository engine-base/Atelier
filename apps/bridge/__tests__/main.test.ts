import { describe, expect, it } from 'vitest';

import { Dispatcher } from '../src/dispatcher.js';
import { createBridge, DEFAULT_CONFIG } from '../src/main.js';

describe('createBridge (T-F-41)', () => {
  it('returns a Dispatcher (API 経由の claim ループ実体)', () => {
    const bridge = createBridge();
    expect(bridge).toBeInstanceOf(Dispatcher);
  });

  it('capacity は現状 1 worker = 1 (electron-entry 表示互換)', () => {
    const bridge = createBridge();
    expect(bridge.capacity).toBe(1);
  });

  it('DEFAULT_CONFIG は従来の既定値を保持する (回帰)', () => {
    expect(DEFAULT_CONFIG.maxConcurrency).toBe(5);
    expect(DEFAULT_CONFIG.worktreeRoot).toBe('/tmp/atelier-worktrees');
  });
});
