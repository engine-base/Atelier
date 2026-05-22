import { describe, expect, it } from 'vitest';

import { spawnPty, type PtySpawnOptions } from '../src/pty.js';

describe('PTY layer (Vibeyard fork pending)', () => {
  const options: PtySpawnOptions = {
    command: 'claude',
    args: ['--help'],
    cwd: '/tmp',
    env: { ATELIER: '1' },
    cols: 80,
    rows: 24,
  };

  it('spawnPty throws not-implemented until Vibeyard import lands', () => {
    expect(() => spawnPty(options)).toThrow(/Vibeyard/);
  });

  it('PtySpawnOptions is structurally typed', () => {
    // Compile-time check that all expected fields exist
    expect(options.command).toBe('claude');
    expect(options.args).toEqual(['--help']);
    expect(options.cwd).toBe('/tmp');
    expect(options.env.ATELIER).toBe('1');
    expect(options.cols).toBe(80);
    expect(options.rows).toBe(24);
  });
});
