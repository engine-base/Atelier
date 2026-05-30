/**
 * Atelier i18n 配管 — T-US-12 (v1: 日本語のみ)
 *
 * 設計:
 *   - 辞書は JSON (apps/web/i18n/ja.json) に一元管理。dot 区切り key で参照
 *   - `t('common.save')` → 「保存」、未登録 key は key 自身を返し dev console に warn
 *   - `tp(key, count)` は単純複数形 (日本語は単数複数同形なので基本同じ文字列)
 *   - `formatDate / formatNumber / formatCurrency` は Intl.* を ja-JP 固定で wrap
 *   - 将来の locale 拡張時は messages を `Record<string, Dictionary>` 化する想定
 *
 * 信頼源: apps/web/i18n/ja.json
 */

import jaMessages from '../i18n/ja.json';

export type Locale = 'ja';
export const DEFAULT_LOCALE: Locale = 'ja';

type Dictionary = Record<string, unknown>;
const dictionaries: Record<Locale, Dictionary> = { ja: jaMessages as Dictionary };

/** ネストされた辞書から dot 区切り key で値を引く */
function lookup(dict: Dictionary, key: string): string | undefined {
  const parts = key.split('.');
  let cur: unknown = dict;
  for (const p of parts) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[p];
    if (cur === undefined) return undefined;
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** {var} placeholder を `vars` の値で置換 */
function interpolate(template: string, vars: Record<string, string | number> | undefined): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => {
    const v = vars[k];
    return v === undefined ? m : String(v);
  });
}

/** 翻訳: key で日本語文字列を取得。未登録は key を返し dev で warn */
export function t(
  key: string,
  vars?: Record<string, string | number>,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const raw = lookup(dictionaries[locale], key);
  if (raw === undefined) {
    if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(`[i18n] missing key: "${key}" (locale=${locale})`);
    }
    return key;
  }
  return interpolate(raw, vars);
}

/** 単純複数形 (日本語は通常同形。count を表示したい場合は `{count}件` 等を辞書側で記述) */
export function tp(
  key: string,
  count: number,
  vars?: Record<string, string | number>,
  locale: Locale = DEFAULT_LOCALE,
): string {
  return t(key, { ...vars, count }, locale);
}

/** Intl.DateTimeFormat ラッパー (ja-JP 固定、日付/時刻/相対) */
export function formatDate(
  value: Date | string | number,
  style: 'date' | 'time' | 'datetime' | 'short-date' = 'datetime',
): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions = (
    {
      date: { year: 'numeric', month: 'long', day: 'numeric' },
      time: { hour: '2-digit', minute: '2-digit' },
      datetime: { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' },
      'short-date': { year: 'numeric', month: '2-digit', day: '2-digit' },
    } as Record<string, Intl.DateTimeFormatOptions>
  )[style] as Intl.DateTimeFormatOptions;
  return new Intl.DateTimeFormat('ja-JP', opts).format(d);
}

/** Intl.NumberFormat ラッパー (ja-JP、千区切り) */
export function formatNumber(value: number, fractionDigits = 0): string {
  return new Intl.NumberFormat('ja-JP', {
    maximumFractionDigits: fractionDigits,
    minimumFractionDigits: fractionDigits,
  }).format(value);
}

/** JPY 通貨表記 (¥1,234) */
export function formatCurrency(value: number, currency: 'JPY' | 'USD' = 'JPY'): string {
  return new Intl.NumberFormat('ja-JP', { style: 'currency', currency }).format(value);
}

/** 公開: テスト用に lookup / interpolate を expose */
export const _internal = { lookup, interpolate };
