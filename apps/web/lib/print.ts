/**
 * 印刷 / PDF 出力ヘルパ — T-US-14
 *
 * - `printPage()`: ブラウザの print dialog を開く (SSR では noop)
 * - `printableClass(...)`: 印刷対象 / 非対象を CSS クラスで識別
 *   (print.css の `.print-only` / `.no-print` と連動)
 */

export const PRINT_ONLY_CLASS = 'print-only';
export const NO_PRINT_CLASS = 'no-print';

/** ブラウザの print dialog を開く。SSR / test 環境では noop。 */
export function printPage(): void {
  if (typeof window === 'undefined' || typeof window.print !== 'function') return;
  window.print();
}

/** printable な class を組み立てる (印刷時のみ表示なら print-only) */
export function printableClass(opts: {
  readonly printOnly?: boolean;
  readonly noPrint?: boolean;
}): string {
  const out: string[] = [];
  if (opts.printOnly) out.push(PRINT_ONLY_CLASS);
  if (opts.noPrint) out.push(NO_PRINT_CLASS);
  return out.join(' ');
}
