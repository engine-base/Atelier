/**
 * グローバル toast ストア（フレームワーク非依存・useSyncExternalStore 互換）。
 *
 * React 外（query-client の onError 等）からも pushToast でき、ToastViewport が購読して
 * 描画する。AC「4xx/5xx で inline error + toast を出す」を全画面横断で満たすための土台。
 */

export type ToastTone = "info" | "success" | "error";

export interface ToastItem {
  readonly id: string;
  readonly message: string;
  readonly tone: ToastTone;
}

const EMPTY: readonly ToastItem[] = [];

let toasts: readonly ToastItem[] = EMPTY;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** toast を追加し id を返す。 */
export function pushToast(message: string, tone: ToastTone = "info"): string {
  seq += 1;
  const id = `toast-${seq}`;
  toasts = [...toasts, { id, message, tone }];
  emit();
  return id;
}

/** id の toast を消す。 */
export function dismissToast(id: string): void {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

/** テスト用: 全消去。 */
export function clearToasts(): void {
  if (toasts.length > 0) {
    toasts = EMPTY;
    emit();
  }
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToastsSnapshot(): readonly ToastItem[] {
  return toasts;
}

/** SSR 用スナップショット（常に空）。 */
export function getToastsServerSnapshot(): readonly ToastItem[] {
  return EMPTY;
}
