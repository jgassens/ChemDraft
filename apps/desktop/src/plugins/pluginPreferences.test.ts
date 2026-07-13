import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryStorage } from "../testSupport/memoryStorage";
import { loadDisabledPluginIds, saveDisabledPluginIds } from "./pluginPreferences";

const STORAGE_KEY = "chemdraft.plugins.disabled";

let storage: MemoryStorage;

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("window", { localStorage: storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("plugin preferences", () => {
  it("round-trips disabled plugin ids as a sorted, de-duplicated JSON array", () => {
    saveDisabledPluginIds(new Set(["org.chemdraft.nmr.predictor", "org.chemdraft.ocsr.molscribe"]));

    expect(storage.getItem(STORAGE_KEY)).toBe(
      '["org.chemdraft.nmr.predictor","org.chemdraft.ocsr.molscribe"]'
    );
    expect([...loadDisabledPluginIds()]).toEqual([
      "org.chemdraft.nmr.predictor",
      "org.chemdraft.ocsr.molscribe"
    ]);
  });

  it("keeps only non-empty string ids from persisted arrays", () => {
    storage.setItem(STORAGE_KEY, JSON.stringify(["org.test.a", 7, "", null, "org.test.a", "org.test.b"]));

    expect([...loadDisabledPluginIds()]).toEqual(["org.test.a", "org.test.b"]);
  });

  it("falls back to an empty set for missing, malformed, or wrongly shaped storage", () => {
    expect(loadDisabledPluginIds()).toEqual(new Set());

    storage.setItem(STORAGE_KEY, "{not json");
    expect(loadDisabledPluginIds()).toEqual(new Set());

    storage.setItem(STORAGE_KEY, JSON.stringify({ disabled: ["org.test.a"] }));
    expect(loadDisabledPluginIds()).toEqual(new Set());
  });

  it("is safe when storage is unavailable or blocked", () => {
    vi.stubGlobal("window", undefined);
    expect(loadDisabledPluginIds()).toEqual(new Set());
    expect(() => saveDisabledPluginIds(new Set(["org.test.a"]))).not.toThrow();

    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        }
      }
    });
    expect(loadDisabledPluginIds()).toEqual(new Set());
    expect(() => saveDisabledPluginIds(new Set(["org.test.a"]))).not.toThrow();
  });
});
