import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filtersMatchingDefaultPathFirst, open, save, saveDialogOptionsForPlatform } from "./nativeFileDialog";
import { nativePrompt } from "./nativePrompt";
import { FILE_DIALOG_ALREADY_OPEN_STATUS, onFileDialogRefused, withOneFileDialog } from "./fileDialogGuard";

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

  it.each(["drawing.pdf", null])("returns focus to the initiating Export session after save returns %s", async selected => {
    native.invoke.mockResolvedValue(undefined);
    native.save.mockResolvedValue(selected);
    await expect(save({ title: "Export PDF" }, "export-session")).resolves.toBe(selected);
    expect(native.invoke).toHaveBeenLastCalledWith("suspend_toolset_windows", {
      suspended: false, focusExportSessionId: "export-session"
    });
    expect(native.save).toHaveBeenCalledWith({ title: "Export PDF" });
  });

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
          // Type imports do not open panels (exportDirectory uses SaveDialogOptions).
          // Only nativePrompt may import the runtime directly, for message boxes.
          const text = readFileSync(path, "utf8");
          if (!text.includes("@tauri-apps/plugin-dialog")) continue;
          const source = ts.createSourceFile(path.pathname, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
          const visitImports = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly || ts.isImportTypeNode(node) ||
              ts.isExportDeclaration(node) && node.isTypeOnly) return;
            // Also catch re-exports, require() and indirect dynamic imports, with either quote style.
            if (ts.isStringLiteral(node) && node.text === "@tauri-apps/plugin-dialog") {
              expect(entry.name).toBe("nativePrompt.ts");
            }
            ts.forEachChild(node, visitImports);
          };
          visitImports(source);
        }
      }
    };
    visit(root);
  });
});

describe("one native file dialog at a time", () => {
  const panel = () => {
    let resolve!: (path: string | null) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string | null>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const listen = () => {
    const refusals: string[] = [];
    return { refusals, unsubscribe: onFileDialogRefused(status => refusals.push(status)) };
  };

  it.each(["linux", "macos", "windows"] as const)("on %s a second Save or Open while Save is pending opens nothing and is reported", async platform => {
    native.invoke.mockResolvedValue(undefined);
    const first = panel();
    native.save.mockReturnValueOnce(first.promise);
    const { refusals, unsubscribe } = listen();
    try {
      const pending = save({ title: "Save As" }, undefined, platform);
      // Pressed again before the first panel even appeared (the lagging-VM case).
      await expect(save({ title: "Save As" }, undefined, platform)).resolves.toBeNull();
      await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1));
      await expect(save({ title: "Save As" }, undefined, platform)).resolves.toBeNull();
      await expect(open({ title: "Open" })).resolves.toBeNull();
      expect(native.save).toHaveBeenCalledTimes(1);
      expect(native.open).not.toHaveBeenCalled();
      expect(refusals).toEqual(Array(3).fill("A file dialog is already open"));
      expect(FILE_DIALOG_ALREADY_OPEN_STATUS).toBe("A file dialog is already open");
      first.resolve("/tmp/drawing.chemdraft");
      await expect(pending).resolves.toBe("/tmp/drawing.chemdraft");
      // Only the one real panel suspended and restored the utility windows.
      expect(native.invoke).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it.each(["selected", "cancelled", "rejected", "suspension throws"] as const)(
    "a request after one that was %s opens normally",
    async ending => {
      native.invoke.mockResolvedValue(undefined);
      if (ending === "suspension throws") native.invoke.mockRejectedValueOnce(new Error("quitting"));
      const first = panel();
      native.save.mockReturnValueOnce(first.promise);
      const pending = save({ title: "Save" });
      if (ending === "suspension throws") {
        await expect(pending).rejects.toThrow("quitting");
        expect(native.save).not.toHaveBeenCalled();
      } else {
        await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1));
        if (ending === "rejected") {
          first.reject(new Error("panel unavailable"));
          await expect(pending).rejects.toThrow("panel unavailable");
        } else {
          first.resolve(ending === "selected" ? "/tmp/drawing.chemdraft" : null);
          await expect(pending).resolves.toBe(ending === "selected" ? "/tmp/drawing.chemdraft" : null);
        }
      }
      const { refusals, unsubscribe } = listen();
      try {
        native.open.mockResolvedValueOnce("/tmp/next.chemdraft");
        await expect(open({ title: "Open" })).resolves.toBe("/tmp/next.chemdraft");
        expect(native.open).toHaveBeenCalledTimes(1);
        expect(refusals).toEqual([]);
      } finally {
        unsubscribe();
      }
    }
  );

  it.each(["rejects", "throws synchronously"])("the guard is released when a step %s", async failure => {
    const step = failure === "rejects"
      ? async (): Promise<string | null> => { throw new Error("step failed"); }
      : ((): Promise<string | null> => { throw new Error("step failed"); });
    await expect(withOneFileDialog(step, null)).rejects.toThrow("step failed");
    const next = vi.fn(async () => "opened");
    await expect(withOneFileDialog<string | null>(next, null)).resolves.toBe("opened");
    expect(next).toHaveBeenCalledOnce();
  });

  it("does not hold message boxes such as the Replace prompt", async () => {
    native.invoke.mockResolvedValue(undefined);
    const first = panel();
    native.save.mockReturnValueOnce(first.promise);
    native.message.mockResolvedValue("Replace");
    const pending = save({ title: "Save" });
    await vi.waitFor(() => expect(native.save).toHaveBeenCalledTimes(1));
    await expect(nativePrompt({
      title: "Replace existing file?", message: "Replace?", kind: "warning",
      choices: [{ id: "replace", label: "Replace" }, { id: "cancel", label: "Cancel", cancel: true }]
    })).resolves.toBe("replace");
    expect(native.message).toHaveBeenCalledOnce();
    first.resolve(null);
    await expect(pending).resolves.toBeNull();
  });

  it("an unsubscribed listener hears nothing and a replaced listener keeps the newer one", async () => {
    const older = vi.fn();
    const newer = vi.fn();
    const unsubscribeOlder = onFileDialogRefused(older);
    const unsubscribeNewer = onFileDialogRefused(newer);
    unsubscribeOlder();
    let finish!: () => void;
    const pending = withOneFileDialog(() => new Promise<string | null>(resolve => { finish = () => resolve(null); }), null);
    await expect(withOneFileDialog<string | null>(async () => "second", null)).resolves.toBeNull();
    expect(newer).toHaveBeenCalledWith(FILE_DIALOG_ALREADY_OPEN_STATUS);
    expect(older).not.toHaveBeenCalled();
    unsubscribeNewer();
    await expect(withOneFileDialog<string | null>(async () => "third", null)).resolves.toBeNull();
    expect(newer).toHaveBeenCalledOnce();
    finish();
    await pending;
  });
});

describe("Linux save filter order (blank GTK file-type list)", () => {
  const documentFilters = [
    { name: "ChemDraft", extensions: ["chemdraft"] },
    { name: "CDXML", extensions: ["cdxml"] },
    { name: "CDX (*.cdx)", extensions: ["cdx"] }
  ];

  it("offers the filter matching the suggested file first, keeping the others in order", () => {
    expect(filtersMatchingDefaultPathFirst(documentFilters, "/tmp/drawing.cdxml").map(filter => filter.name))
      .toEqual(["CDXML", "ChemDraft", "CDX (*.cdx)"]);
    expect(filtersMatchingDefaultPathFirst(documentFilters, "C:\\Users\\a\\Drawing.CDX").map(filter => filter.name))
      .toEqual(["CDX (*.cdx)", "ChemDraft", "CDXML"]);
  });

  it.each([
    ["the first filter already matches", "/tmp/drawing.chemdraft"],
    ["no filter matches", "/tmp/drawing.mol"],
    ["the name has no extension", "/tmp/cdxml"]
  ])("returns the same list when %s", (_case, defaultPath) => {
    expect(filtersMatchingDefaultPathFirst(documentFilters, defaultPath)).toBe(documentFilters);
  });

  it("treats a \"*\" filter as matching any name", () => {
    const filters = [{ name: "PNG", extensions: ["png"] }, { name: "All files", extensions: ["*"] }];
    expect(filtersMatchingDefaultPathFirst(filters, "notes.txt").map(filter => filter.name)).toEqual(["All files", "PNG"]);
  });

  it("reorders only on Linux and only when there is a suggested path and filters", () => {
    const options = { title: "Save", defaultPath: "/tmp/drawing.cdxml", filters: documentFilters };
    expect(saveDialogOptionsForPlatform(options, "linux")).toEqual({
      title: "Save", defaultPath: "/tmp/drawing.cdxml", filters: [documentFilters[1], documentFilters[0], documentFilters[2]]
    });
    // The caller's options are not mutated.
    expect(options.filters).toBe(documentFilters);
    for (const platform of ["macos", "windows"] as const) {
      expect(saveDialogOptionsForPlatform(options, platform)).toBe(options);
    }
    const noPath = { title: "Save", filters: documentFilters };
    expect(saveDialogOptionsForPlatform(noPath, "linux")).toBe(noPath);
    const noFilters = { title: "Save", defaultPath: "/tmp/drawing.cdxml" };
    expect(saveDialogOptionsForPlatform(noFilters, "linux")).toBe(noFilters);
    expect(saveDialogOptionsForPlatform(undefined, "linux")).toBeUndefined();
  });

  it.each(["linux", "macos", "windows"] as const)("hands the %s panel the platform's filter order", async platform => {
    native.invoke.mockResolvedValue(undefined);
    native.save.mockResolvedValue(null);
    await save({ defaultPath: "/tmp/drawing.cdxml", filters: documentFilters }, undefined, platform);
    expect(native.save.mock.calls[0]![0].filters.map((filter: { name: string }) => filter.name)).toEqual(
      platform === "linux" ? ["CDXML", "ChemDraft", "CDX (*.cdx)"] : ["ChemDraft", "CDXML", "CDX (*.cdx)"]
    );
  });
});
