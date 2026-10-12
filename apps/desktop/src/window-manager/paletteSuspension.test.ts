import { describe, expect, it, vi } from "vitest";
import { createPaletteSuspensionCoordinator } from "./paletteSuspension";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("palette dialog suspension", () => {
  it("suspends before native open and releases only after the last native/HTML dialog", async () => {
    const native = vi.fn(async (_suspended: boolean) => undefined);
    const coordinator = createPaletteSuspensionCoordinator(native);
    let closeFirst!: () => void, closeSecond!: () => void;
    const first = coordinator.run(async () => { expect(native.mock.calls).toEqual([[true]]); await new Promise<void>((resolve) => { closeFirst = resolve; }); });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    coordinator.setHtmlModal(true);
    const second = coordinator.run(() => new Promise<void>((resolve) => { closeSecond = resolve; }));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    closeFirst(); await first;
    closeSecond(); await second;
    expect(native.mock.calls).toEqual([[true]]);
    coordinator.setHtmlModal(false);
    await coordinator.settled();
    expect(native.mock.calls).toEqual([[true], [false]]);
  });
  it("restores in finally on native cancellation/failure", async () => {
    const native = vi.fn(async (_suspended: boolean) => undefined);
    const coordinator = createPaletteSuspensionCoordinator(native);
    await expect(coordinator.run(async () => { throw new Error("dialog failed"); })).rejects.toThrow("dialog failed");
    expect(native.mock.calls).toEqual([[true], [false]]);
  });
  it("restores a partially completed suspension if native suspension fails", async () => {
    const native = vi.fn(async (active: boolean) => { if (active) throw new Error("hide failed"); });
    const coordinator = createPaletteSuspensionCoordinator(native);
    const open = vi.fn(async () => undefined);
    await expect(coordinator.run(open)).rejects.toThrow("hide failed");
    expect(open).not.toHaveBeenCalled();
    expect(native.mock.calls).toEqual([[true], [false]]);
  });
  it("does not reopen between a finishing native dialog and its HTML replacement", async () => {
    const native = vi.fn(async (_suspended: boolean) => undefined);
    const coordinator = createPaletteSuspensionCoordinator(native);
    await coordinator.run(async () => { coordinator.setHtmlModal(true); });
    expect(native.mock.calls).toEqual([[true]]);
    coordinator.setHtmlModal(false); await coordinator.settled();
    expect(native.mock.calls).toEqual([[true], [false]]);
  });
  it("wraps native Open/Save As, Preferences lifetime, and About using the shared coordinator", () => {
    const main = readFileSync(join(process.cwd(), "apps/desktop/src/MainWindow.tsx"), "utf8");
    for (const name of ["pickNativeOpenPath", "pickNativeSavePath"]) {
      const start = main.indexOf(`async function ${name}`);
      const body = main.slice(start, main.indexOf("\n}", start) + 2);
      expect(body).toContain("withToolsetWindowsSuspended");
    }
    expect(main).toContain("setHtmlModal(suspended)");
    expect(main).toContain("withToolsetWindowsSuspended(() => togglePreferencesWindow())");
    expect(main).toContain("withToolsetWindowsSuspended(() => showAboutDialog())");
  });
});
