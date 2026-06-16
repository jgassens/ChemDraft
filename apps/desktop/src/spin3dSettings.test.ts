import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SPIN3D_SETTINGS,
  conformerOptionsForSpin3d,
  isSpin3dRefinementMode,
  loadSpin3dSettings,
  saveSpin3dSettings,
  type Spin3dSettings
} from "./spin3dSettings";
import { balancedRefineIterationsFor, qualityRefineIterationsFor } from "./spin3dRefineCaps";

const STORAGE_KEY = "chemdraft.spin3d.settings.v1";

// jsdom in this project doesn't expose localStorage, and the module reads
// globalThis.localStorage — so stub a minimal in-memory store for these tests.
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

describe("spin3dSettings", () => {
  it("defaults to quality (preserves historical Spin 3D behaviour)", () => {
    expect(DEFAULT_SPIN3D_SETTINGS.refinementMode).toBe("quality");
    expect(loadSpin3dSettings()).toEqual({ refinementMode: "quality" });
  });

  it("persists and reloads a chosen mode", () => {
    saveSpin3dSettings({ refinementMode: "fast" });
    expect(loadSpin3dSettings()).toEqual({ refinementMode: "fast" });
  });

  it("falls back to the default on corrupt or unknown stored values", () => {
    storage.setItem(STORAGE_KEY, "{not json");
    expect(loadSpin3dSettings()).toEqual(DEFAULT_SPIN3D_SETTINGS);
    storage.setItem(STORAGE_KEY, JSON.stringify({ refinementMode: "turbo" }));
    expect(loadSpin3dSettings()).toEqual(DEFAULT_SPIN3D_SETTINGS);
  });

  it("validates the mode discriminant", () => {
    expect(isSpin3dRefinementMode("fast")).toBe(true);
    expect(isSpin3dRefinementMode("balanced")).toBe(true);
    expect(isSpin3dRefinementMode("quality")).toBe(true);
    expect(isSpin3dRefinementMode("uff")).toBe(false);
    expect(isSpin3dRefinementMode(undefined)).toBe(false);
  });

  describe("conformerOptionsForSpin3d", () => {
    const opts = (mode: Spin3dSettings["refinementMode"], atomCount: number) =>
      conformerOptionsForSpin3d({ refinementMode: mode }, atomCount);

    it("fast disables refinement", () => {
      expect(opts("fast", 20)).toEqual({ optimize: "none" });
    });

    it("balanced uses MMFF94 with the low (balanced) cap", () => {
      for (const n of [10, 45, 90]) {
        expect(opts("balanced", n)).toEqual({
          optimize: "mmff94",
          maxMinimiseIterations: balancedRefineIterationsFor(n)
        });
      }
    });

    it("quality uses MMFF94 with the historical (full) cap", () => {
      for (const n of [10, 45, 90]) {
        expect(opts("quality", n)).toEqual({
          optimize: "mmff94",
          maxMinimiseIterations: qualityRefineIterationsFor(n)
        });
      }
    });

    it("balanced is strictly fewer iterations than quality at every size", () => {
      for (const n of [10, 45, 90]) {
        expect(balancedRefineIterationsFor(n)).toBeLessThan(qualityRefineIterationsFor(n));
      }
    });
  });
});
