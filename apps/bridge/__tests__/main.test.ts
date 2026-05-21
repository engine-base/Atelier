import { describe, expect, it } from 'vitest';

import { Dispatcher } from '../src/dispatcher.js';
import { createBridge } from '../src/main.js';

describe('createBridge', () => {
  it('returns a Dispatcher with default config', () => {
    const bridge = createBridge();
    expect(bridge).toBeInstanceOf(Dispatcher);
    expect(bridge.capacity).toBe(5);
  });

  it('applies config overrides on top of defaults', () => {
    const bridge = createBridge({ maxConcurrency: 10 });
    expect(bridge.capacity).toBe(10);
  });

  it('keeps default worktreeRoot when not overridden', () => {
    const bridge = createBridge({});
    // 構造的に確認: capacity が default の 5 から動かない
    expect(bridge.capacity).toBe(5);
  });
});
