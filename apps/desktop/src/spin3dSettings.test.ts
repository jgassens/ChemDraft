import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SPIN3D_SETTINGS,
  conformerOptionsForSpin3d,
  isSpin3dEnginePreference,
  isSpin3dForceField,
  isSpin3dRefinementMode,
  isSpin3dSettings,
  loadSpin3dSettings,
  saveSpin3dSettings,
  type Spin3dSettings
} from "./spin3dSettings";
import { balancedRefineIterationsFor, qualityRefineIterationsFor } from "./spin3dRefineCaps";
// jsdom in this project doesn't expose localStorage, and the module reads
// globalThis.localStorage — so stub a minimal in-memory store for these tests.
import { MemoryStorage } from "./testSupport/memoryStorage";

const STORAGE_KEY = "chemdraft.spin3d.settings.v1";

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const settings = (patch: Partial<Spin3dSettings> = {}): Spin3dSettings => ({ ...DEFAULT_SPIN3D_SETTINGS, ...patch });

describe("spin3dSettings", () => {
  it("defaults to quality + auto engine + MMFF94 (preserves historical chemistry)", () => {
    expect(DEFAULT_SPIN3D_SETTINGS).toEqual({ refinementMode: "quality", enginePreference: "auto", forceField: "mmff94" });
    expect(loadSpin3dSettings()).toEqual(DEFAULT_SPIN3D_SETTINGS);
  });

  it("persists and reloads all three fields", () => {
    const chosen = settings({ refinementMode: "fast", enginePreference: "openchemlib", forceField: "uff" });
    saveSpin3dSettings(chosen);
    expect(loadSpin3dSettings()).toEqual(chosen);
  });

  it("loads older settings (mode only) forward-compatibly, defaulting new fields", () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ refinementMode: "balanced" }));
    expect(loadSpin3dSettings()).toEqual(settings({ refinementMode: "balanced" }));
  });

  it("defaults individual invalid fields without discarding valid ones", () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ refinementMode: "fast", enginePreference: "nope", forceField: "uff" }));
    expect(loadSpin3dSettings()).toEqual(settings({ refinementMode: "fast", forceField: "uff" }));
  });

  it("falls back to the default on corrupt JSON", () => {
    storage.setItem(STORAGE_KEY, "{not json");
    expect(loadSpin3dSettings()).toEqual(DEFAULT_SPIN3D_SETTINGS);
  });

  it("validates the discriminants", () => {
    expect(isSpin3dRefinementMode("fast")).toBe(true);
    expect(isSpin3dRefinementMode("uff")).toBe(false);
    expect(isSpin3dEnginePreference("auto")).toBe(true);
    expect(isSpin3dEnginePreference("rdkit")).toBe(true);
    expect(isSpin3dEnginePreference("openchemlib")).toBe(true);
    expect(isSpin3dEnginePreference("ocl")).toBe(false);
    expect(isSpin3dForceField("mmff94")).toBe(true);
    expect(isSpin3dForceField("uff")).toBe(true);
    expect(isSpin3dForceField("gaff")).toBe(false);
    expect(isSpin3dSettings(DEFAULT_SPIN3D_SETTINGS)).toBe(true);
    expect(isSpin3dSettings({ refinementMode: "fast" })).toBe(false); // missing fields
  });

  describe("conformerOptionsForSpin3d", () => {
    it("fast disables refinement (force field irrelevant)", () => {
      expect(conformerOptionsForSpin3d(settings({ refinementMode: "fast", forceField: "uff" }), 20)).toEqual({ optimize: "none" });
    });

    it("balanced/quality request the chosen force field with the size-scaled cap", () => {
      for (const n of [10, 45, 90]) {
        expect(conformerOptionsForSpin3d(settings({ refinementMode: "balanced" }), n)).toEqual({
          optimize: "mmff94",
          maxMinimiseIterations: balancedRefineIterationsFor(n)
        });
        expect(conformerOptionsForSpin3d(settings({ refinementMode: "quality", forceField: "uff" }), n)).toEqual({
          optimize: "uff",
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
