/**
 * In-memory `Storage` stub for tests. jsdom in this project doesn't expose `localStorage`
 * and the code under test reads `globalThis.localStorage`, so tests stub this via
 * `vi.stubGlobal("localStorage", new MemoryStorage())`. Shared so the settings/preferences
 * tests (and any future ones) don't each carry their own copy.
 */
export class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
}
