import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DRAWING_SETTINGS_STORAGE_KEY, isDrawingSettings, loadDrawingSettings, saveDrawingSettings } from "./drawingSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

beforeEach(() => vi.stubGlobal("localStorage", new MemoryStorage()));
afterEach(() => vi.unstubAllGlobals());

it("defaults to Offset and persists/reloads both choices", () => {
  expect(loadDrawingSettings()).toEqual({ defaultDoubleBond: "offset" });
  for (const defaultDoubleBond of ["centred", "offset"] as const) {
    saveDrawingSettings({ defaultDoubleBond });
    expect(JSON.parse(localStorage.getItem(DRAWING_SETTINGS_STORAGE_KEY)!)).toEqual({ defaultDoubleBond });
    expect(loadDrawingSettings()).toEqual({ defaultDoubleBond });
  }
});

it.each(["broken", "null", "{}", "[]", '"centred"', '{"defaultDoubleBond":true}', '{"defaultDoubleBond":"center"}'])(
  "falls back to Offset for invalid stored value %s", raw => {
    localStorage.setItem(DRAWING_SETTINGS_STORAGE_KEY, raw);
    expect(loadDrawingSettings()).toEqual({ defaultDoubleBond: "offset" });
    expect(isDrawingSettings(JSON.parse(raw === "broken" ? "null" : raw))).toBe(false);
  }
);

it("handles blocked storage using the same best-effort policy as other preferences", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); }
  });
  expect(loadDrawingSettings()).toEqual({ defaultDoubleBond: "offset" });
  expect(() => saveDrawingSettings({ defaultDoubleBond: "centred" })).not.toThrow();
});
