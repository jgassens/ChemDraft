import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesWindow } from "./PreferencesWindow";

const STORAGE_KEY = "chemdraft.spin3d.settings.v1";

class MemoryStorage {
  private store = new Map<string, string>();
  get length() {
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

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PreferencesWindow", () => {
  it("renders the three 3D refinement modes with descriptions", () => {
    const markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(markup).toContain("3D refinement");
    for (const title of ["Fast", "Balanced", "Quality"]) {
      expect(markup).toContain(title);
    }
    expect(markup).toContain("Embedded conformer only");
    expect(markup).toContain("Quick MMFF94 cleanup");
    expect(markup).toContain("Longer MMFF94 cleanup");
  });

  it("reflects the persisted mode as the single selected option", () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ refinementMode: "balanced" }));
    const markup = renderToStaticMarkup(createElement(PreferencesWindow));
    // Exactly one option is selected, and it is the balanced one (attribute order-independent).
    expect(markup.match(/data-selected="true"/g)).toHaveLength(1);
    expect(markup).toMatch(/data-selected="true"><input[^>]*value="balanced"/);
  });

  it("defaults to quality when nothing is stored", () => {
    const markup = renderToStaticMarkup(createElement(PreferencesWindow));
    expect(markup.match(/data-selected="true"/g)).toHaveLength(1);
    expect(markup).toMatch(/data-selected="true"><input[^>]*value="quality"/);
  });
});
