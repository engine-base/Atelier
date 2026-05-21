import { describe, expect, it } from 'vitest';

import { ATELIER_VERSION } from '@atelier/shared';

describe('@atelier/shared', () => {
  it('exports ATELIER_VERSION as a non-empty string', () => {
    expect(typeof ATELIER_VERSION).toBe('string');
    expect(ATELIER_VERSION.length).toBeGreaterThan(0);
  });
});
