import { posix, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { saveInExportDirectory, type ExportDirectoryDependencies } from "./exportDirectory";

describe.each([
  { platform: "macOS", paths: posix, documents: "/Users/chemist/Documents", last: "/Users/chemist/Exports" },
  { platform: "Windows", paths: win32, documents: "C:\\Users\\chemist\\Documents", last: "D:\\NMR exports" }
])("export directory on $platform", ({ paths, documents, last }) => {
  function dependencies(folder?: string) {
    return {
      directory: { current: folder },
      documentDir: vi.fn(async () => documents),
      join: vi.fn(async (...parts: string[]) => paths.join(...parts)),
      dirname: vi.fn(async (path: string) => paths.dirname(path)),
      isDirectory: vi.fn(async () => true),
      save: vi.fn<ExportDirectoryDependencies["save"]>(async () => null)
    };
  }
  it("starts in Documents when there is no remembered folder", async () => {
    const deps = dependencies();
    await saveInExportDirectory("spectrum.svg", {}, vi.fn(), deps);
    expect(deps.join).toHaveBeenCalledWith(documents, "spectrum.svg");
    expect(deps.save).toHaveBeenCalledWith({ defaultPath: paths.join(documents, "spectrum.svg") });
  });
  it("joins the last folder with the suggested name using the platform path API", async () => {
    const deps = dependencies(last);
    await saveInExportDirectory("spectrum.png", {}, vi.fn(), deps);
    expect(deps.save).toHaveBeenCalledWith({ defaultPath: paths.join(last, "spectrum.png") });
    expect(deps.documentDir).not.toHaveBeenCalled();
  });
  it.each(["deleted", "not a directory", "inaccessible"])("falls back to Documents if the remembered folder is %s", async reason => {
    const deps = dependencies(last);
    if (reason === "inaccessible") deps.isDirectory.mockRejectedValue(new Error("Access denied"));
    else deps.isDirectory.mockResolvedValue(false);
    await saveInExportDirectory("spectrum.pdf", {}, vi.fn(), deps);
    expect(deps.save).toHaveBeenCalledWith({ defaultPath: paths.join(documents, "spectrum.pdf") });
  });
  it("remembers the selected parent only after a successful write, across export formats", async () => {
    const deps = dependencies();
    const destination = paths.join(last, "renamed.svg");
    deps.save.mockResolvedValueOnce(destination);
    const write = vi.fn(async () => { expect(deps.directory.current).toBeUndefined(); });
    await expect(saveInExportDirectory("spectrum.svg", {}, write, deps)).resolves.toBe("saved");
    expect(write).toHaveBeenCalledWith(destination);
    expect(deps.directory.current).toBe(last);
    await saveInExportDirectory("spectrum.png", {}, vi.fn(), deps);
    expect(deps.save).toHaveBeenLastCalledWith({ defaultPath: paths.join(last, "spectrum.png") });
  });
  it("does not remember a cancelled destination or a failed write", async () => {
    const deps = dependencies(last);
    const write = vi.fn(async () => { throw new Error("disk full"); });
    await expect(saveInExportDirectory("spectrum.svg", {}, write, deps)).resolves.toBe("cancelled");
    expect(write).not.toHaveBeenCalled();
    expect(deps.directory.current).toBe(last);
    deps.save.mockResolvedValue(paths.join(documents, "spectrum.svg"));
    await expect(saveInExportDirectory("spectrum.svg", {}, write, deps)).rejects.toThrow("disk full");
    expect(deps.directory.current).toBe(last);
  });
});
