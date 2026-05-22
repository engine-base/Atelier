import { describe, expect, it } from 'vitest';

import { ATELIER_VERSION } from '../src/index.js';

describe('@atelier/shared', () => {
  it('ATELIER_VERSION is a non-empty semver-like string', () => {
    expect(typeof ATELIER_VERSION).toBe('string');
    expect(ATELIER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('ATELIER_VERSION is the literal "0.1.0" at Phase 0', () => {
    expect(ATELIER_VERSION).toBe('0.1.0');
  });
});
