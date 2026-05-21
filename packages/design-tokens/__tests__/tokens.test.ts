import { describe, expect, it } from 'vitest';

import {
  colors,
  fontFamily,
  rounded,
  spacing,
  tokens,
  typography,
} from '../src/index.js';

describe('@atelier/design-tokens — colors', () => {
  it('exposes primary M3 role tokens with hex values', () => {
    expect(colors.primary).toBe('#2563EB');
    expect(colors.onPrimary).toBe('#FFFFFF');
    expect(colors.primaryContainer).toBe('#DBEAFE');
    expect(colors.onPrimaryContainer).toBe('#1E3A8A');
  });

  it('exposes secondary / tertiary / surface / error / neutral tokens', () => {
    for (const key of [
      'secondary',
      'tertiary',
      'surface',
      'error',
      'neutral',
    ] as const) {
      expect(colors[key]).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it('every color token is a 6-digit hex string', () => {
    for (const value of Object.values(colors)) {
      expect(value).toMatch(/^#[0-9A-F]{6}$/);
    }
  });
});

describe('@atelier/design-tokens — spacing', () => {
  it('uses pixel scale ordered ascending', () => {
    const px = (s: string): number => Number(s.replace('px', ''));
    expect(px(spacing.xs)).toBe(4);
    expect(px(spacing.sm)).toBe(8);
    expect(px(spacing.md)).toBe(16);
    expect(px(spacing.lg)).toBe(24);
    expect(px(spacing.xl)).toBe(48);
    expect(px(spacing['2xl'])).toBe(96);
  });
});

describe('@atelier/design-tokens — rounded', () => {
  it('exposes radius scale including full', () => {
    expect(rounded.none).toBe('0px');
    expect(rounded.sm).toBe('4px');
    expect(rounded.md).toBe('8px');
    expect(rounded.lg).toBe('16px');
    expect(rounded.xl).toBe('24px');
    expect(rounded.full).toBe('9999px');
  });
});

describe('@atelier/design-tokens — fontFamily', () => {
  it('uses Noto Sans JP for sans', () => {
    expect(fontFamily.sans).toContain('Noto Sans JP');
    expect(fontFamily.sans).toContain('system-ui');
  });

  it('uses monospace stack for mono', () => {
    expect(fontFamily.mono).toContain('JetBrains Mono');
    expect(fontFamily.mono).toContain('monospace');
  });
});

describe('@atelier/design-tokens — typography', () => {
  const scales = [
    'headline-display',
    'headline-lg',
    'headline-md',
    'body-lg',
    'body-md',
    'body-sm',
    'label-lg',
    'label-md',
    'label-sm',
  ] as const;

  it.each(scales)('%s has fontFamily / size / weight', (scale) => {
    const t = typography[scale];
    expect(t.fontFamily).toContain('Noto Sans JP');
    expect(t.fontSize).toMatch(/^\d+px$/);
    expect(typeof t.fontWeight).toBe('number');
  });

  it('headline-display is the heaviest weight', () => {
    expect(typography['headline-display'].fontWeight).toBe(900);
  });
});

describe('@atelier/design-tokens — aggregate tokens', () => {
  it('exposes nested aggregate object', () => {
    expect(tokens.colors).toBe(colors);
    expect(tokens.spacing).toBe(spacing);
    expect(tokens.rounded).toBe(rounded);
    expect(tokens.fontFamily).toBe(fontFamily);
    expect(tokens.typography).toBe(typography);
  });
});
