import { afterEach, expect, it, vi } from "vitest";
import { loadStartWithFreshDocument, saveStartWithFreshDocument } from "./startupSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

afterEach(() => vi.unstubAllGlobals());

it("defaults off and persists explicit opt-in", () => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  expect(loadStartWithFreshDocument()).toBe(false);
  saveStartWithFreshDocument(true);
  expect(loadStartWithFreshDocument()).toBe(true);
  saveStartWithFreshDocument(false);
  expect(loadStartWithFreshDocument()).toBe(false);
});

it.each(["false", "TRUE", "null", "{}"])("defaults off for invalid stored preference %s", (raw) => {
  const storage = new MemoryStorage();
  storage.setItem("chemdraft.startup.start-fresh.v1", raw);
  vi.stubGlobal("localStorage", storage);
  expect(loadStartWithFreshDocument()).toBe(false);
});

it("defaults off when storage access fails", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked storage"); } });
  expect(loadStartWithFreshDocument()).toBe(false);
});
