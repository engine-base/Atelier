/**
 * T-US-18: design tokens の Tailwind 反映 (テスト)
 *
 * tailwind.config.ts は packages/design-tokens の token を取り込んでいるはず。
 * ここでは「design-tokens の主要値が tailwind.config.ts 文中に出現する」ことと、
 * 「apps/web/styles/tokens.css が必要な custom property を全て宣言している」
 * ことを構造的に検証する。tailwind.config.ts を直接 import すると
 * `tailwindcss` module 型に依存するため、文字列読み出しでスナップショット検証する。
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { colors, rounded, spacing } from '../../../../packages/design-tokens/src/index';

const ROOT = path.join(__dirname, '../../../..');
const TAILWIND_CONFIG = fs.readFileSync(path.join(ROOT, 'tailwind.config.ts'), 'utf-8');
const TOKENS_CSS = fs.readFileSync(path.join(__dirname, '../../styles/tokens.css'), 'utf-8');

describe('tailwind.config.ts (T-US-18 design tokens 反映)', () => {
  it('imports from packages/design-tokens', () => {
    expect(TAILWIND_CONFIG).toMatch(/from ['"]\.\/packages\/design-tokens\/src\/index/);
  });

  it('uses the primary color token by reference (not hard-coded hex)', () => {
    expect(TAILWIND_CONFIG).toMatch(/colors\.primary/);
  });

  it.each(['spacing.xs', 'spacing.md', 'spacing.xl'])(
    'references identifier %s in tailwind config',
    (name) => {
      expect(TAILWIND_CONFIG).toContain(name);
    },
  );

  it.each(['rounded.sm', 'rounded.lg', 'rounded.full'])(
    'references identifier %s in tailwind config',
    (name) => {
      expect(TAILWIND_CONFIG).toContain(name);
    },
  );

  it('design-tokens spacing/rounded values are non-empty strings', () => {
    expect(spacing.md.length).toBeGreaterThan(0);
    expect(rounded.lg.length).toBeGreaterThan(0);
  });

  it('defines headline / body / label font size groups', () => {
    expect(TAILWIND_CONFIG).toMatch(/headline-display/);
    expect(TAILWIND_CONFIG).toMatch(/body-md/);
    expect(TAILWIND_CONFIG).toMatch(/label-sm/);
  });
});

describe('packages/design-tokens — token values (T-US-18 source of truth)', () => {
  it('primary color hex format', () => {
    expect(colors.primary).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
  it('spacing values are px strings', () => {
    expect(spacing.md).toMatch(/^\d+px$/);
  });
});

describe('apps/web/styles/tokens.css (T-US-18 補助トークン)', () => {
  it.each([
    '--focus-ring-color',
    '--focus-ring-width',
    '--shadow-e1',
    '--shadow-e2',
    '--motion-duration-default',
    '--motion-easing-standard',
    '--z-modal',
    '--z-toast',
  ])('declares %s custom property', (name) => {
    expect(TOKENS_CSS).toContain(name);
  });

  it('respects prefers-reduced-motion via media query', () => {
    expect(TOKENS_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });
});
