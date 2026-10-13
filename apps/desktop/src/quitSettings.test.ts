import { afterEach, expect, it, vi } from "vitest";
import { handleQuitRequest, loadAskToSaveBeforeQuit, saveAskToSaveBeforeQuit } from "./quitSettings";
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

it.each([false, true])("preference off preserves flush then quit, dirty=%s", async (dirty) => {
  const show = vi.fn();
  const flush = vi.fn().mockResolvedValue(undefined);
  await handleQuitRequest(false, dirty, show, flush);
  expect(show).not.toHaveBeenCalled();
  expect(flush).toHaveBeenCalledTimes(1);
});

it("preference on with no changes quits without prompting", async () => {
  const show = vi.fn();
  const flush = vi.fn().mockResolvedValue(undefined);
  await handleQuitRequest(true, false, show, flush);
  expect(show).not.toHaveBeenCalled();
  expect(flush).toHaveBeenCalledTimes(1);
});

it("preference on with changes shows a prompt without deciding the quit", async () => {
  const show = vi.fn();
  const flush = vi.fn();
  await handleQuitRequest(true, true, show, flush);
  expect(show).toHaveBeenCalledTimes(1);
  expect(flush).not.toHaveBeenCalled();
});
