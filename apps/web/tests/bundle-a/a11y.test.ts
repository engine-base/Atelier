/**
 * T-US-13: a11y 基盤 (テスト)
 */

// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import {
  announce,
  contrastRatio,
  createFocusTrap,
  getFocusableElements,
  meetsContrastAA,
  parseHex,
  relativeLuminance,
  visuallyHidden,
} from '../../lib/a11y';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('parseHex', () => {
  it('parses 6-digit hex', () => {
    expect(parseHex('#2563EB')).toEqual({ r: 0x25, g: 0x63, b: 0xeb });
  });
  it('parses 3-digit shorthand', () => {
    expect(parseHex('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
  });
  it('returns null for invalid hex', () => {
    expect(parseHex('not-a-color')).toBeNull();
  });
});

describe('relativeLuminance / contrastRatio (WCAG 2.x)', () => {
  it('white luminance is 1', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeCloseTo(1, 4);
  });
  it('black luminance is 0', () => {
    expect(relativeLuminance({ r: 0, g: 0, b: 0 })).toBeCloseTo(0, 4);
  });
  it('white on black contrast is 21:1', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 1);
  });
  it('Atelier on-surface on surface meets AA (>= 4.5)', () => {
    expect(meetsContrastAA('#0F172A', '#FEFCF8')).toBe(true);
  });
  it('Atelier on-primary on primary meets AA (>= 4.5)', () => {
    expect(meetsContrastAA('#FFFFFF', '#2563EB')).toBe(true);
  });
  it('returns 0 for invalid colors', () => {
    // 'invalid' は 7 文字 — 3/6 桁 hex のいずれにも合わない
    expect(contrastRatio('invalid', '#000')).toBe(0);
  });
  it('large-text threshold uses 3.0 cutoff', () => {
    // pick a pair near 3:1
    const pair = contrastRatio('#777777', '#FFFFFF');
    expect(meetsContrastAA('#777777', '#FFFFFF', true)).toBe(pair >= 3.0);
  });
});

describe('getFocusableElements / createFocusTrap', () => {
  it('lists focusable children in tab order', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <a href="#a">a</a>
      <button>b</button>
      <input type="hidden" />
      <button disabled>c</button>
      <input type="text" />
      <span tabindex="0">d</span>
      <span tabindex="-1">e</span>
    `;
    document.body.appendChild(root);
    const list = getFocusableElements(root);
    const tags = list.map((el) => el.tagName + (el.textContent?.trim() || ''));
    expect(tags).toEqual(['Aa', 'BUTTONb', 'INPUT', 'SPANd']);
  });

  it('focus trap cycles Tab back to first and Shift+Tab to last', () => {
    const root = document.createElement('div');
    root.innerHTML = `<button id="b1">b1</button><button id="b2">b2</button>`;
    document.body.appendChild(root);
    const trap = createFocusTrap(root);
    const b1 = document.getElementById('b1')! as HTMLButtonElement;
    const b2 = document.getElementById('b2')! as HTMLButtonElement;
    b2.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
    root.dispatchEvent(ev);
    expect(document.activeElement).toBe(b1);
    b1.focus();
    const evShift = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true });
    root.dispatchEvent(evShift);
    expect(document.activeElement).toBe(b2);
    trap.release();
  });

  it('release() removes the keydown listener', () => {
    const root = document.createElement('div');
    root.innerHTML = `<button>x</button>`;
    document.body.appendChild(root);
    const trap = createFocusTrap(root);
    trap.release();
    // After release, dispatching Tab should not throw and should not alter focus
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true });
    expect(() => root.dispatchEvent(ev)).not.toThrow();
  });
});

describe('announce()', () => {
  it('creates an aria-live region and announces the message', async () => {
    announce('hello', 'polite');
    // microtask で更新するため flush
    await Promise.resolve();
    const region = document.getElementById('a11y-live');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.textContent).toBe('hello');
  });
  it('reuses the same region on subsequent calls', async () => {
    announce('first');
    await Promise.resolve();
    announce('second', 'assertive');
    await Promise.resolve();
    const regions = document.querySelectorAll('#a11y-live');
    expect(regions.length).toBe(1);
    expect(regions[0]?.getAttribute('aria-live')).toBe('assertive');
    expect(regions[0]?.textContent).toBe('second');
  });
});

describe('visuallyHidden style object', () => {
  it('defines clip rectangle (0,0,0,0) for SR-only', () => {
    expect(visuallyHidden.clip).toBe('rect(0,0,0,0)');
  });
});
