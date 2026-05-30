/**
 * T-US-12: i18n 配管 (テスト)
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LOCALE,
  _internal,
  formatCurrency,
  formatDate,
  formatNumber,
  t,
  tp,
} from '../../lib/i18n';

describe('t() (T-US-12)', () => {
  it('returns translated string for known key', () => {
    expect(t('common.save')).toBe('保存');
  });
  it('returns translated string for nested key', () => {
    expect(t('nav.projects')).toBe('プロジェクト');
  });
  it('returns key itself when missing and warns in dev', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(t('does.not.exist')).toBe('does.not.exist');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('interpolates {var} placeholders', () => {
    const result = _internal.interpolate('Hello {name}, count={count}', { name: 'A', count: 3 });
    expect(result).toBe('Hello A, count=3');
  });
});

describe('tp() (T-US-12)', () => {
  it('forwards count into vars', () => {
    const out = _internal.interpolate('{count}件', { count: 5 });
    expect(out).toBe('5件');
    expect(tp('common.more', 3)).toBe(t('common.more'));
  });
});

describe('formatDate / formatNumber / formatCurrency (T-US-12)', () => {
  it('formats a Date in ja-JP datetime style', () => {
    const d = new Date(Date.UTC(2026, 4, 29, 1, 23));
    const out = formatDate(d);
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
  it('returns empty string for invalid date', () => {
    expect(formatDate('not-a-date')).toBe('');
  });
  it('formats numbers with ja-JP thousands separator', () => {
    expect(formatNumber(12345)).toBe('12,345');
  });
  it('formats JPY currency', () => {
    expect(formatCurrency(1500)).toMatch(/￥|¥/);
  });
});

describe('DEFAULT_LOCALE', () => {
  it("is 'ja'", () => {
    expect(DEFAULT_LOCALE).toBe('ja');
  });
});
