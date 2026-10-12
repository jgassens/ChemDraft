import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { open, save } from "./nativeFileDialog";
import { nativePrompt } from "./nativePrompt";

const native = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), save: vi.fn(), message: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: native.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: native.open, save: native.save, message: native.message }));
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });

describe("native file panels", () => {
  for (const [name, picker, panel] of [["open", open, native.open], ["save", save, native.save]] as const) {
    it.each(["selected", "cancelled", "throws"])(`${name} suspends until the panel ends: %s`, async (ending) => {
      const calls: string[] = [];
      native.invoke.mockImplementation(async (_command, { suspended }) => { calls.push(suspended ? "hide" : "restore"); });
      panel.mockImplementation(async () => {
        calls.push("panel");
        if (ending === "throws") throw new Error("panel unavailable");
        return ending === "cancelled" ? null : "drawing.chemdraft";
      });
      const result = picker({ title: "Choose file" });
      if (ending === "throws") await expect(result).rejects.toThrow("panel unavailable");
      else await expect(result).resolves.toBe(ending === "cancelled" ? null : "drawing.chemdraft");
      expect(calls).toEqual(["hide", "panel", "restore"]);
      expect(native.invoke.mock.calls).toEqual([
        ["suspend_toolset_windows", { suspended: true }], ["suspend_toolset_windows", { suspended: false }]
      ]);
    });
  }

  it("refuses a panel if suspension fails", async () => {
    native.invoke.mockRejectedValue(new Error("quitting"));
    await expect(open({})).rejects.toThrow("quitting");
    expect(native.open).not.toHaveBeenCalled();
    expect(native.invoke).toHaveBeenCalledTimes(1);
  });

  it("preserves the panel result if quit refuses restoration", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    native.invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("quitting"));
    native.save.mockResolvedValue("drawing.chemdraft");
    await expect(save({})).resolves.toBe("drawing.chemdraft");
  });

  it("an overlapping box and panel restore only after both close", async () => {
    let depth = 0;
    const visibility: string[] = [];
    native.invoke.mockImplementation(async (_command, { suspended }) => {
      if (suspended) { if (depth++ === 0) visibility.push("hide"); }
      else { if (--depth === 0) visibility.push("restore"); }
    });
    let finishPanel!: (value: string | null) => void;
    let finishBox!: (value: string) => void;
    native.open.mockImplementation(() => new Promise((resolve) => { finishPanel = resolve; }));
    native.message.mockImplementation(() => new Promise((resolve) => { finishBox = resolve; }));
    const panel = open({});
    const box = nativePrompt({ title: "Notice", message: "Notice", kind: "info", choices: [{ id: "close", label: "OK", cancel: true }] });
    await vi.waitFor(() => expect(depth).toBe(2));
    finishBox("OK"); await box;
    expect(visibility).toEqual(["hide"]);
    finishPanel(null); await panel;
    expect(visibility).toEqual(["hide", "restore"]);
    expect(depth).toBe(0);
  });

  it("all document and plugin picker callers go through the suspended wrappers", () => {
    const root = new URL("./", import.meta.url);
    const visit = (dir: URL): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
        if (entry.isDirectory()) visit(path);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.") && entry.name !== "nativeFileDialog.ts") {
          // Only nativePrompt may use the dialog plugin directly, for message boxes.
          const source = readFileSync(path, "utf8");
          if (source.includes('"@tauri-apps/plugin-dialog"')) expect(entry.name).toBe("nativePrompt.ts");
        }
      }
    };
    visit(root);
  });
});
