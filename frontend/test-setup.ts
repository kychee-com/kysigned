import '@testing-library/jest-dom/vitest';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length() {
    return this.store.size;
  }

  clear() {
    this.store.clear();
  }

  getItem(key: string) {
    return this.store.get(String(key)) ?? null;
  }

  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string) {
    this.store.delete(String(key));
  }

  setItem(key: string, value: string) {
    this.store.set(String(key), String(value));
  }
}

function ensureStorage(name: 'localStorage' | 'sessionStorage') {
  const current = globalThis.window?.[name];
  if (current && typeof current.clear === 'function') return;

  const storage = new MemoryStorage();
  Object.defineProperty(window, name, {
    configurable: true,
    value: storage,
  });
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: storage,
  });
}

ensureStorage('localStorage');
ensureStorage('sessionStorage');
