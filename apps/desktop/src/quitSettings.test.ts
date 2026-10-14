import { afterEach, expect, it, vi } from "vitest";
import { loadAskToSaveBeforeQuit, saveAskToSaveBeforeQuit } from "./quitSettings";
import { MemoryStorage } from "./testSupport/memoryStorage";

afterEach(() => vi.unstubAllGlobals());

it("defaults off and persists explicit opt-in", () => {
  vi.stubGlobal("localStorage", new MemoryStorage());
  expect(loadAskToSaveBeforeQuit()).toBe(false);
  saveAskToSaveBeforeQuit(true);
  expect(loadAskToSaveBeforeQuit()).toBe(true);
  saveAskToSaveBeforeQuit(false);
  expect(loadAskToSaveBeforeQuit()).toBe(false);
});

it.each(["false", "TRUE", "null", "{}"])("defaults off for invalid stored preference %s", (raw) => {
  const storage = new MemoryStorage();
  storage.setItem("chemdraft.quit.ask-to-save.v1", raw);
  vi.stubGlobal("localStorage", storage);
  expect(loadAskToSaveBeforeQuit()).toBe(false);
});

it("defaults off when storage access fails", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked storage"); } });
  expect(loadAskToSaveBeforeQuit()).toBe(false);
});
