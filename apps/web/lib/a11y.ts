/**
 * a11y 基盤 ヘルパ — T-US-13 (WCAG 2.2 AA)
 *
 * 提供する関数:
 *   - relativeLuminance / contrastRatio / meetsContrastAA: 配色チェック
 *   - getFocusableElements: フォーカス可能な子要素列挙
 *   - createFocusTrap: モーダル/ドロワー用のフォーカストラップ (return 値で解除)
 *   - srOnlyClass / visuallyHidden: スクリーンリーダー専用 CSS class 名
 *   - announce: aria-live 領域経由のアナウンス (テストでは noop に差し替え可)
 *
 * 信頼源: docs/a11y.md
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type RGB = { r: number; g: number; b: number };

/** #RRGGBB を RGB object に変換 (#RGB の短縮形も許容) */
export function parseHex(hex: string): RGB | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  let s = m[1]!;
  if (s.length === 3) {
    s = s
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

/** sRGB 線形化 (WCAG 2.x 公式) */
function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** 相対輝度 (WCAG 2.x) */
export function relativeLuminance(rgb: RGB): number {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 2 色のコントラスト比 (1〜21) */
export function contrastRatio(fg: string, bg: string): number {
  const a = parseHex(fg);
  const b = parseHex(bg);
  if (!a || !b) return 0;
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** WCAG 2.2 AA: 通常テキスト 4.5:1、大テキスト 3.0:1 */
export function meetsContrastAA(fg: string, bg: string, large = false): boolean {
  const ratio = contrastRatio(fg, bg);
  return large ? ratio >= 3.0 : ratio >= 4.5;
}

/** フォーカス可能要素のセレクタ */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** container 内のフォーカス可能 element を tab order で列挙 */
export function getFocusableElements(container: Element): HTMLElement[] {
  const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  return nodes.filter((el) => {
    if (el.hasAttribute('hidden')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const style = (el.ownerDocument?.defaultView ?? globalThis).getComputedStyle?.(el);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return true;
  });
}

/** モーダル/ドロワー用のフォーカストラップ。返り値の release() で解除 */
export function createFocusTrap(container: HTMLElement): { release: () => void } {
  const handler = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const focusables = getFocusableElements(container);
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = container.ownerDocument.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', handler);
  return {
    release: () => container.removeEventListener('keydown', handler),
  };
}

/** WCAG 用 sr-only クラス名 (Tailwind の sr-only と互換) */
export const srOnlyClass = 'sr-only';

/** 視覚的に非表示・SR には伝達されるスタイル (style 属性で適用する場合用) */
export const visuallyHidden: Record<string, string> = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: '0',
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: '0',
};

/**
 * aria-live=polite 領域経由でアナウンス。SSR 環境 (document 不在) では noop。
 * 既存の領域が無ければ初回呼び出し時に <div id="a11y-live"> を append する。
 */
export function announce(message: string, priority: 'polite' | 'assertive' = 'polite'): void {
  if (typeof document === 'undefined') return;
  let region = document.getElementById('a11y-live');
  if (!region) {
    region = document.createElement('div');
    region.id = 'a11y-live';
    region.setAttribute('aria-live', priority);
    region.setAttribute('aria-atomic', 'true');
    Object.assign(region.style, visuallyHidden);
    document.body.appendChild(region);
  } else {
    region.setAttribute('aria-live', priority);
  }
  // 連続アナウンスのため一旦 clear → set
  region.textContent = '';
  // microtask で更新して SR が変更を検知できるよう保証
  Promise.resolve().then(() => {
    region!.textContent = message;
  });
}
