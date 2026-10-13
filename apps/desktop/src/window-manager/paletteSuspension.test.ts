// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { acquireNativeUtilitySuspension, withNativeUtilitySuspension, observeNativeUtilityModals } from "../nativeUtilitySuspension";
const native = vi.hoisted(() => ({ invoke: vi.fn(), depth: 0, visibility: [] as string[] }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: native.invoke }));
let observer: ReturnType<typeof observeNativeUtilityModals> | undefined;
beforeEach(() => {
  native.depth = 0; native.visibility = [];
  native.invoke.mockReset().mockImplementation(async (_command, { suspended }) => {
    if (suspended) { if (native.depth++ === 0) native.visibility.push("hide"); }
    else { expect(native.depth).toBeGreaterThan(0); if (--native.depth === 0) native.visibility.push("restore"); }
  });
});
afterEach(async () => {
  observer?.stop(); await observer?.settled(); observer = undefined;
  document.body.innerHTML = ""; vi.restoreAllMocks();
});
const modal = () => {
  const element = document.createElement("div"); element.setAttribute("role", "dialog"); element.setAttribute("aria-modal", "true");
  document.body.append(element); return element;
};
async function flush() { await Promise.resolve(); await observer?.settled(); }

describe("palette dialogs share main's utility suspension", () => {
  it("native and nested HTML dialogs share the Rust counter until the last closes", async () => {
    observer = observeNativeUtilityModals(document);
    let closeFirst!: () => void, closeSecond!: () => void;
    const first = withNativeUtilitySuspension(() => new Promise<void>((resolve) => { closeFirst = resolve; }));
    await vi.waitFor(() => expect(native.depth).toBe(1));
    const html = modal(); const nested = modal(); await flush();
    expect(native.depth).toBe(2);
    const second = withNativeUtilitySuspension(() => new Promise<void>((resolve) => { closeSecond = resolve; }));
    await vi.waitFor(() => expect(native.depth).toBe(3));
    closeFirst(); await first; nested.remove(); await flush();
    closeSecond(); await second;
    expect(native.visibility).toEqual(["hide"]);
    html.remove(); await flush();
    expect(native.visibility).toEqual(["hide", "restore"]); expect(native.depth).toBe(0);
  });
  it("releases exactly once on native failure and repeated release calls", async () => {
    await expect(withNativeUtilitySuspension(async () => { throw new Error("dialog failed"); })).rejects.toThrow("dialog failed");
    const release = await acquireNativeUtilitySuspension(); await release(); await release();
    expect(native.invoke.mock.calls.map((call) => call[1].suspended)).toEqual([true, false, true, false]);
    expect(native.depth).toBe(0);
  });
  it("failed acquisition opens no native dialog and creates no release obligation", async () => {
    native.invoke.mockRejectedValue(new Error("hide failed"));
    const open = vi.fn(async () => undefined);
    await expect(withNativeUtilitySuspension(open)).rejects.toThrow("hide failed");
    expect(open).not.toHaveBeenCalled(); expect(native.invoke).toHaveBeenCalledTimes(1);
  });
  it("cleanup during an in-flight HTML acquisition releases it exactly once", async () => {
    let finishAcquire!: () => void;
    native.invoke.mockImplementation((_command, { suspended }) => suspended
      ? new Promise<void>((resolve) => { finishAcquire = resolve; }) : Promise.resolve());
    modal(); observer = observeNativeUtilityModals(document);
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledTimes(1));
    observer.stop(); observer.stop(); finishAcquire(); await observer.settled();
    expect(native.invoke.mock.calls.map((call) => call[1].suspended)).toEqual([true, false]);
  });
  it("keeps HTML suspension when a native dialog hands over to an HTML modal", async () => {
    observer = observeNativeUtilityModals(document);
    await withNativeUtilitySuspension(async () => { modal(); });
    await flush();
    expect(native.visibility).toEqual(["hide"]); observer.stop(); await observer.settled();
    expect(native.visibility).toEqual(["hide", "restore"]);
  });
  it("preserves the operation error if quit refuses a release", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    native.invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("quitting"));
    await expect(withNativeUtilitySuspension(async () => { throw new Error("dialog failed"); })).rejects.toThrow("dialog failed");
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });
  it("uses main's helpers for About, Preferences and HTML; file pickers suspend only once", () => {
    const main = readFileSync(join(process.cwd(), "apps/desktop/src/MainWindow.tsx"), "utf8");
    expect(main).toContain("observeNativeUtilityModals(window.document)");
    expect(main).toContain("withNativeUtilitySuspension(() => togglePreferencesWindow())");
    expect(main).toContain("withNativeUtilitySuspension(() => showAboutDialog())");
    expect(main).not.toContain("paletteSuspension");
    for (const name of ["pickNativeOpenPath", "pickNativeSavePath", "pickNativeExportPath", "pickNativeMoleculeTemplateOpenPath", "pickNativeMoleculeTemplateSavePath"]) {
      const start = main.indexOf(`async function ${name}`);
      const body = main.slice(start, main.indexOf("\n}", start) + 2);
      expect(body).not.toContain("withNativeUtilitySuspension");
    }
    expect(main).toContain('import("./nativeFileDialog")');
  });
});
