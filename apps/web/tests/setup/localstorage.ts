/**
 * jsdom テスト用 localStorage 保証。
 *
 * Node 22+（v25 で既定有効）の実験的 WebStorage は `--localstorage-file` 未指定だと
 * `clear` 等が undefined の不完全なグローバル localStorage を生やし、jsdom の実装を
 * shadow する。その環境では `window.localStorage.clear()` が TypeError になり
 * テストが Node バージョン依存で落ちる。機能する Storage をここで必ず立てる。
 */

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

function ensureStorage(name: "localStorage" | "sessionStorage"): void {
  const current = (
    globalThis as unknown as Record<string, Storage | undefined>
  )[name];
  if (typeof current?.clear === "function") return;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, name, {
    value: storage,
    configurable: true,
  });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, name, { value: storage, configurable: true });
  }
}

ensureStorage("localStorage");
ensureStorage("sessionStorage");
