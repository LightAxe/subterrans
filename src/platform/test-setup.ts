// test-setup.ts — Platform test setup for jsdom environment.
// Node 25 injects a native localStorage onto globalThis that lacks .clear().
// This setup file replaces it with a proper in-memory Storage implementation
// so that save.test.ts (and any future platform tests) can call localStorage.clear().

class InMemoryStorage implements Storage {
  private _store: Map<string, string> = new Map();

  get length(): number {
    return this._store.size;
  }

  clear(): void {
    this._store.clear();
  }

  getItem(key: string): string | null {
    return this._store.has(key) ? this._store.get(key)! : null;
  }

  key(index: number): string | null {
    const keys = [...this._store.keys()];
    return index < keys.length ? keys[index]! : null;
  }

  removeItem(key: string): void {
    this._store.delete(key);
  }

  setItem(key: string, value: string): void {
    this._store.set(key, value);
  }
}

const store = new InMemoryStorage();
// Override both global localStorage and window.localStorage so jsdom tests
// see a consistent, full-featured Storage implementation regardless of Node 25's
// native localStorage injection.
Object.defineProperty(globalThis, 'localStorage', {
  value: store,
  writable: true,
  configurable: true,
});
if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'localStorage', {
    value: store,
    writable: true,
    configurable: true,
  });
}
