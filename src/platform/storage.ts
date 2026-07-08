// src/platform/storage.ts — async storage seam (#234 PR1).
//
// The save API historically called the `localStorage` global directly. This
// module interposes an async `StorageDriver` so the whole save path can move to
// async, evict-resistant backends (Capacitor Preferences, Tauri fs, IndexedDB,
// OPFS — all async, all on the Phase 6 path) by injecting a driver, without
// touching a single save.ts call site again.
//
// Platform layer — module-level mutable state is allowed here (the sim
// no-singleton rule applies only under src/sim/).

export interface StorageDriver {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * The default driver: a thin async wrapper over `localStorage`.
 *
 * The methods deliberately run the (synchronous) `localStorage` call inside
 * `Promise.resolve().then(...)` rather than being `async` bodies. Both give the
 * same important property — a synchronous throw (quota exceeded, storage
 * disabled/evicted) surfaces as a REJECTED promise, so every save.ts call site's
 * existing `try/catch` around an `await` keeps catching it unchanged. (A plain
 * `async` body would do the same, but its no-`await` shape trips the
 * type-aware `require-await` lint, whose disable directive the base auto-fixer
 * then strips — so the `.then` form is the stable equivalent.)
 */
export class LocalStorageDriver implements StorageDriver {
  get(key: string): Promise<string | null> {
    return Promise.resolve().then(() => localStorage.getItem(key));
  }

  set(key: string, value: string): Promise<void> {
    return Promise.resolve().then(() => {
      localStorage.setItem(key, value);
    });
  }

  remove(key: string): Promise<void> {
    return Promise.resolve().then(() => {
      localStorage.removeItem(key);
    });
  }
}

let active: StorageDriver = new LocalStorageDriver();

export function getStorageDriver(): StorageDriver {
  return active;
}

/** Inject a driver (tests, or a future Capacitor/Tauri/IndexedDB backend). */
export function setStorageDriver(d: StorageDriver): void {
  active = d;
}
