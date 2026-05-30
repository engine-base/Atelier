/**
 * T-US-14 print helpers tests
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  NO_PRINT_CLASS,
  PRINT_ONLY_CLASS,
  printPage,
  printableClass,
} from '../../lib/print';

describe('printableClass / constants', () => {
  it('exports class constants', () => {
    expect(PRINT_ONLY_CLASS).toBe('print-only');
    expect(NO_PRINT_CLASS).toBe('no-print');
  });
  it('builds combined class names', () => {
    expect(printableClass({ printOnly: true })).toBe('print-only');
    expect(printableClass({ noPrint: true })).toBe('no-print');
    expect(printableClass({ printOnly: true, noPrint: true })).toBe('print-only no-print');
    expect(printableClass({})).toBe('');
  });
});

describe('printPage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls window.print when available', () => {
    const spy = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    printPage();
    expect(spy).toHaveBeenCalled();
  });

  it('is a noop when window.print is undefined', () => {
    const original = window.print;
    // @ts-expect-error — test the fallback path
    window.print = undefined;
    expect(() => printPage()).not.toThrow();
    window.print = original;
  });
});

describe('apps/web/styles/print.css', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../styles/print.css'), 'utf-8');

  it('hides nav and banner in @media print', () => {
    expect(css).toMatch(/@media print/);
    expect(css).toMatch(/nav\[aria-label\]/);
    expect(css).toMatch(/header\[role="banner"\]/);
  });

  it('defines print-only / no-print utilities', () => {
    expect(css).toContain('.print-only');
    expect(css).toContain('.no-print');
  });

  it('shows href after <a> in print', () => {
    expect(css).toMatch(/a\[href\]::after/);
  });
});
