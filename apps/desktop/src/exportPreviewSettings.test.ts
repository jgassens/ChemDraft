import { afterEach, expect, it, vi } from "vitest";
import { loadExportPreviewEnabled, saveExportPreviewEnabled } from "./exportPreviewSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

afterEach(() => vi.unstubAllGlobals());

it("defaults off and persists explicit opt-in", () => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  expect(loadExportPreviewEnabled()).toBe(false);
  saveExportPreviewEnabled(true);
  expect(loadExportPreviewEnabled()).toBe(true);
  saveExportPreviewEnabled(false);
  expect(loadExportPreviewEnabled()).toBe(false);
});

it.each(["false", "TRUE", "null", "{}"])("defaults off for invalid stored preference %s", (raw) => {
  const storage = new MemoryStorage();
  storage.setItem("chemdraft.export.preview-and-presets.v1", raw);
  vi.stubGlobal("localStorage", storage);
  expect(loadExportPreviewEnabled()).toBe(false);
});

it("defaults off when storage access fails", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked storage"); } });
  expect(loadExportPreviewEnabled()).toBe(false);
});

it("ignores unavailable storage and failed writes", () => {
  vi.stubGlobal("localStorage", undefined);
  expect(loadExportPreviewEnabled()).toBe(false);
  expect(() => saveExportPreviewEnabled(true)).not.toThrow();
  vi.stubGlobal("localStorage", { setItem() { throw new Error("blocked"); } });
  expect(() => saveExportPreviewEnabled(true)).not.toThrow();
});
