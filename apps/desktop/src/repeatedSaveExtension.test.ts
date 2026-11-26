import { describe, expect, it, vi } from "vitest";
import {
  collapseRepeatedFileExtension,
  DOCUMENT_SAVE_EXTENSIONS,
  isFileAlreadyExistsError,
  resolveAppendedExtensionSavePath,
  resolveRepeatedExtensionSavePath,
  resolveRepeatedExtensionSaveTarget,
  writeGrantedRepeatedExtensionTarget,
  writeRepeatedExtensionSaveTarget,
  type RepeatedExtensionSaveTarget
} from "./repeatedSaveExtension";

describe("collapseRepeatedFileExtension", () => {
  it.each([
    ["/Users/me/x.chemdraft.chemdraft", "/Users/me/x.chemdraft"],
    ["C:\\Users\\me\\x.chemdraft.chemdraft", "C:\\Users\\me\\x.chemdraft"],
    ["C:\\Users\\me/mixed\\x.cdxml.cdxml", "C:\\Users\\me/mixed\\x.cdxml"],
    ["x.cdx.cdx", "x.cdx"],
    ["/tmp/x.ChemDraft.chemdraft", "/tmp/x.ChemDraft"],
    ["/tmp/X.CHEMDRAFT.CHEMDRAFT", "/tmp/X.CHEMDRAFT"]
  ])("collapses %s", (input, expected) => {
    expect(collapseRepeatedFileExtension(input, DOCUMENT_SAVE_EXTENSIONS)).toBe(expected);
  });

  it.each([
    "/tmp/x.chemdraft",
    "C:\\tmp\\x.chemdraft",
    "/tmp/a.b.chemdraft",
    "/tmp/x.cdxml.chemdraft",
    "C:\\tmp\\x.chemdraft.cdxml",
    "/tmp/x",
    "/tmp/.chemdraft.chemdraft",
    "C:\\tmp\\.chemdraft.chemdraft",
    "/tmp/x.chemdraft.chemdraft/child",
    "/dir.chemdraft.chemdraft/x.chemdraft"
  ])("leaves %s unchanged", input => {
    expect(collapseRepeatedFileExtension(input, DOCUMENT_SAVE_EXTENSIONS)).toBe(input);
  });

  it("only collapses an extension the panel offered", () => {
    expect(collapseRepeatedFileExtension("/tmp/fig.svg.svg", ["svg"])).toBe("/tmp/fig.svg");
    expect(collapseRepeatedFileExtension("C:\\out\\fig.SVG.svg", ["svg"])).toBe("C:\\out\\fig.SVG");
    expect(collapseRepeatedFileExtension("/tmp/fig.svg.svg", ["png"])).toBe("/tmp/fig.svg.svg");
    expect(collapseRepeatedFileExtension("/tmp/fig.svg.svg", ["*", ""])).toBe("/tmp/fig.svg.svg");
    expect(collapseRepeatedFileExtension("/tmp/fig.jpeg.jpeg", ["jpg", "jpeg"])).toBe("/tmp/fig.jpeg");
  });
});

describe("resolveRepeatedExtensionSavePath", () => {
  const context = (exists: boolean | Error, replace = true, ownPath?: string) => ({
    ownPath,
    platform: "macos" as const,
    exists: vi.fn(async () => { if (exists instanceof Error) throw exists; return exists; }),
    confirmReplace: vi.fn(async () => replace)
  });

  it("returns an undoubled path without checking the disk", async () => {
    const ctx = context(true);
    await expect(resolveRepeatedExtensionSavePath("/tmp/x.chemdraft", DOCUMENT_SAVE_EXTENSIONS, ctx)).resolves.toBe("/tmp/x.chemdraft");
    expect(ctx.exists).not.toHaveBeenCalled();
    expect(ctx.confirmReplace).not.toHaveBeenCalled();
  });

  it("saves a macOS panel path collapsed when nothing is there", async () => {
    const ctx = context(false);
    await expect(resolveRepeatedExtensionSavePath("/tmp/x.chemdraft.chemdraft", DOCUMENT_SAVE_EXTENSIONS, ctx)).resolves.toBe("/tmp/x.chemdraft");
    expect(ctx.confirmReplace).not.toHaveBeenCalled();
  });

  it.each([
    ["windows", "C:\\out\\figure.svg.svg"],
    ["linux", "/home/me/figure.svg.svg"]
  ] as const)("keeps a %s panel path exactly as typed", async (platform, selected) => {
    const ctx = { ...context(false), platform };
    await expect(resolveRepeatedExtensionSaveTarget(selected, ["svg"], ctx)).resolves.toEqual({ path: selected, recheck: false });
    await expect(resolveRepeatedExtensionSavePath("C:\\out\\x.chemdraft.chemdraft", DOCUMENT_SAVE_EXTENSIONS, ctx)).resolves.toBe("C:\\out\\x.chemdraft.chemdraft");
    expect(ctx.exists).not.toHaveBeenCalled();
    expect(ctx.confirmReplace).not.toHaveBeenCalled();
  });

  it("confirms replacing an existing file at the collapsed path", async () => {
    const accept = context(true, true);
    await expect(resolveRepeatedExtensionSavePath("/tmp/x.chemdraft.chemdraft", DOCUMENT_SAVE_EXTENSIONS, accept)).resolves.toBe("/tmp/x.chemdraft");
    expect(accept.confirmReplace).toHaveBeenCalledWith("/tmp/x.chemdraft");
    const decline = context(true, false);
    await expect(resolveRepeatedExtensionSavePath("/tmp/x.chemdraft.chemdraft", DOCUMENT_SAVE_EXTENSIONS, decline)).resolves.toBeUndefined();
  });

  it("does not ask before saving over exactly the document's own file", async () => {
    const ctx = context(true, false, "/tmp/x.chemdraft");
    await expect(resolveRepeatedExtensionSavePath("/tmp/x.chemdraft.chemdraft", DOCUMENT_SAVE_EXTENSIONS, ctx)).resolves.toBe("/tmp/x.chemdraft");
    expect(ctx.exists).not.toHaveBeenCalled();
    expect(ctx.confirmReplace).not.toHaveBeenCalled();
  });

  it.each(["/tmp/X.chemdraft", "/tmp/./x.chemdraft", "/private/tmp/x.chemdraft"])(
    "asks before replacing an existing file that is only spelled like the document's own (%s)",
    async ownPath => {
      const ctx = context(true, false, ownPath);
      await expect(resolveRepeatedExtensionSavePath("/tmp/x.chemdraft.chemdraft", DOCUMENT_SAVE_EXTENSIONS, ctx)).resolves.toBeUndefined();
      expect(ctx.confirmReplace).toHaveBeenCalledWith("/tmp/x.chemdraft");
    }
  );

  it("keeps the panel's path when the collapsed path cannot be checked", async () => {
    const ctx = context(new Error("forbidden path"));
    await expect(resolveRepeatedExtensionSavePath("/Volumes/x.chemdraft.chemdraft", DOCUMENT_SAVE_EXTENSIONS, ctx))
      .resolves.toBe("/Volumes/x.chemdraft.chemdraft");
    expect(ctx.confirmReplace).not.toHaveBeenCalled();
  });

  it("deliberately writes the granted path unchanged outside the file access scope, without rejecting", async () => {
    // The fs plugin rejects `exists` outside its scope (an external volume); the panel granted only
    // the exact doubled path, so that path is the one written, and no later re-check is requested.
    for (const failure of [new Error("forbidden path"), "not allowed by scope"]) {
      const ctx = {
        platform: "macos" as const,
        exists: vi.fn(() => Promise.reject(failure)),
        confirmReplace: vi.fn(async () => true)
      };
      await expect(resolveRepeatedExtensionSaveTarget("/Volumes/USB/x.svg.svg", ["svg"], ctx))
        .resolves.toEqual({ path: "/Volumes/USB/x.svg.svg", recheck: false });
      expect(ctx.exists).toHaveBeenCalledWith("/Volumes/USB/x.svg");
      expect(ctx.confirmReplace).not.toHaveBeenCalled();
    }
  });
});

/** A fake disk: `createNew` fails when the path is already there, as the fs plugin does. */
function disk(initial: string[] = []) {
  const files = new Set(initial);
  let failNext: Error | undefined;
  const write = vi.fn(async (path: string, { createNew }: { createNew: boolean }) => {
    if (createNew && files.has(path)) throw new Error("File exists (os error 17)");
    if (failNext) { const error = failNext; failNext = undefined; throw error; }
    files.add(path);
  });
  const ctx = { exists: vi.fn(async (path: string) => files.has(path)), confirmReplace: vi.fn(async () => true) };
  return { files, write, ctx, failOnce: (error: Error) => { failNext = error; } };
}

describe("resolveRepeatedExtensionSaveTarget and writeRepeatedExtensionSaveTarget", () => {
  const extensions = ["svg"];
  it("asks for a re-check only when the collapsed path was free and never confirmed", async () => {
    const free = { platform: "macos" as const, exists: vi.fn(async () => false), confirmReplace: vi.fn(async () => true) };
    await expect(resolveRepeatedExtensionSaveTarget("/out/fig.svg.svg", extensions, free)).resolves.toEqual({ path: "/out/fig.svg", recheck: true });
    await expect(resolveRepeatedExtensionSaveTarget("/out/fig.svg", extensions, free)).resolves.toEqual({ path: "/out/fig.svg", recheck: false });
    const confirmed = { ...free, exists: vi.fn(async () => true) };
    await expect(resolveRepeatedExtensionSaveTarget("/out/fig.svg.svg", extensions, confirmed)).resolves.toEqual({ path: "/out/fig.svg", recheck: false });
    const own = { ...free, ownPath: "/out/fig.svg" };
    await expect(resolveRepeatedExtensionSaveTarget("/out/fig.svg.svg", extensions, own)).resolves.toEqual({ path: "/out/fig.svg", recheck: false });
  });

  it("writes normally when no re-check is needed, even over an existing file", async () => {
    const { write, ctx } = disk(["/out/fig.svg"]);
    await expect(writeRepeatedExtensionSaveTarget({ path: "/out/fig.svg", recheck: false }, ctx, write)).resolves.toBe(true);
    expect(write.mock.calls).toEqual([["/out/fig.svg", { createNew: false }]]);
    expect(ctx.confirmReplace).not.toHaveBeenCalled();
  });

  it("writes a still-free re-check path with exclusive creation and no question", async () => {
    const { write, ctx, files } = disk();
    await expect(writeRepeatedExtensionSaveTarget({ path: "/out/fig.svg", recheck: true }, ctx, write)).resolves.toBe(true);
    expect(write.mock.calls).toEqual([["/out/fig.svg", { createNew: true }]]);
    expect(ctx.confirmReplace).not.toHaveBeenCalled();
    expect(files.has("/out/fig.svg")).toBe(true);
  });

  it.each([[true, true], [false, false]])("asks when the exclusive write finds a file that appeared (replace: %s)", async (replace, writes) => {
    const { write, ctx } = disk(["/out/fig.svg"]);
    ctx.confirmReplace.mockResolvedValue(replace);
    await expect(writeRepeatedExtensionSaveTarget({ path: "/out/fig.svg", recheck: true }, ctx, write)).resolves.toBe(writes);
    expect(ctx.confirmReplace).toHaveBeenCalledWith("/out/fig.svg");
    expect(write.mock.calls).toEqual(writes
      ? [["/out/fig.svg", { createNew: true }], ["/out/fig.svg", { createNew: false }]]
      : [["/out/fig.svg", { createNew: true }]]);
  });

  it("rejects without asking when the exclusive write fails for another reason", async () => {
    const { write, ctx, failOnce } = disk();
    failOnce(new Error("disk full"));
    await expect(writeRepeatedExtensionSaveTarget({ path: "/out/fig.svg", recheck: true }, ctx, write)).rejects.toThrow("disk full");
    expect(ctx.confirmReplace).not.toHaveBeenCalled();
  });

  // tauri-plugin-fs 2.5.1 rejects with a plain string carrying Rust's io::Error text.
  const collisions = [
    "failed to open file at path: /out/fig.svg with error: File exists (os error 17)",
    "failed to open file at path: C:\\out\\fig.svg with error: The file exists. (os error 80)",
    "failed to open file at path: C:\\out\\fig.svg with error: Cannot create a file when that file already exists. (os error 183)",
    "failed to open file at path: C:\\out\\fig.svg with error: Die Datei ist vorhanden. (os error 80)",
    "FAILED TO OPEN FILE AT PATH: /out/fig.svg WITH ERROR: FILE EXISTS (OS ERROR 17)",
    new Error("File exists (os error 17)"),
    { message: "entity already exists" }
  ];

  it.each(collisions)("recognizes an AlreadyExists error: %s", (error) => {
    expect(isFileAlreadyExistsError(error)).toBe(true);
  });

  it.each([
    "failed to write bytes to file at path: /out/fig.svg with error: No space left on device (os error 28)",
    "failed to write bytes to file at path: C:\\out\\fig.svg with error: There is not enough space on the disk. (os error 112)",
    "failed to open file at path: /out/File exists (os error 17).svg with error: Permission denied (os error 13)",
    "failed to open file at path: /out/fig.svg with error: Input/output error (os error 5)",
    "forbidden path: /out/fig.svg",
    "(os error 170)",
    new Error("disk full"),
    undefined,
    null
  ])("does not treat another failure as AlreadyExists: %s", (error) => {
    expect(isFileAlreadyExistsError(error)).toBe(false);
  });

  it.each(collisions)("asks to replace only on an AlreadyExists error: %s", async (collision) => {
    const write = vi.fn(async (_path: string, { createNew }: { createNew: boolean }) => { if (createNew) throw collision; });
    const ctx = { exists: vi.fn(async () => true), confirmReplace: vi.fn(async () => true) };
    await expect(writeRepeatedExtensionSaveTarget({ path: "/out/fig.svg", recheck: true }, ctx, write)).resolves.toBe(true);
    expect(ctx.confirmReplace).toHaveBeenCalledWith("/out/fig.svg");
    expect(write.mock.calls).toEqual([["/out/fig.svg", { createNew: true }], ["/out/fig.svg", { createNew: false }]]);
  });

  it("reports a disk-full failure that left a file behind instead of asking or cancelling", async () => {
    // The plugin creates the file before writing its bytes, so a full disk leaves an empty file.
    const files = new Set<string>();
    const diskFull = "failed to write bytes to file at path: /out/fig.svg with error: No space left on device (os error 28)";
    const write = vi.fn(async (path: string) => { files.add(path); throw diskFull; });
    const ctx = { exists: vi.fn(async (path: string) => files.has(path)), confirmReplace: vi.fn(async () => false) };
    await expect(writeRepeatedExtensionSaveTarget({ path: "/out/fig.svg", recheck: true }, ctx, write)).rejects.toBe(diskFull);
    expect(files.has("/out/fig.svg")).toBe(true);
    expect(ctx.confirmReplace).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("reports a disk-full failure through a deferred grant and keeps its re-check", async () => {
    const grants = new Map([["tab", { path: "/out/fig.svg", recheck: true }]]);
    const write = vi.fn(async () => { throw new Error("failed to write bytes to file at path: /out/fig.svg with error: No space left on device (os error 28)"); });
    const ctx = { exists: vi.fn(async () => true), confirmReplace: vi.fn(async () => false) };
    await expect(writeGrantedRepeatedExtensionTarget(grants, "tab", "/out/fig.svg", ctx, write)).rejects.toThrow("No space left on device");
    expect(ctx.confirmReplace).not.toHaveBeenCalled();
    expect(grants.get("tab")!.recheck).toBe(true);
  });

  it("rejects with the write's error when the path can no longer be checked", async () => {
    const write = vi.fn(async () => { throw new Error("forbidden path"); });
    const ctx = { exists: vi.fn(async () => { throw new Error("scope"); }), confirmReplace: vi.fn(async () => true) };
    await expect(writeRepeatedExtensionSaveTarget({ path: "/out/fig.svg", recheck: true }, ctx, write)).rejects.toThrow("forbidden path");
    expect(ctx.confirmReplace).not.toHaveBeenCalled();
  });
});

describe("writeGrantedRepeatedExtensionTarget", () => {
  type Grant = RepeatedExtensionSaveTarget & { filename: string };
  const grantFor = (path: string, recheck: boolean): Grant => ({ path, recheck, filename: path.split("/").at(-1)! });

  it("clears the re-check only after a successful write", async () => {
    const grants = new Map([["tab", grantFor("/out/fig.svg", true)]]);
    const { write, ctx } = disk();
    await expect(writeGrantedRepeatedExtensionTarget(grants, "tab", "/out/fig.svg", ctx, write)).resolves.toBe(true);
    expect(grants.get("tab")).toEqual(grantFor("/out/fig.svg", false));
    // The user's own export is there now; writing again does not ask.
    await expect(writeGrantedRepeatedExtensionTarget(grants, "tab", "/out/fig.svg", ctx, write)).resolves.toBe(true);
    expect(ctx.confirmReplace).not.toHaveBeenCalled();
    expect(write.mock.calls.at(-1)).toEqual(["/out/fig.svg", { createNew: false }]);
  });

  it("still asks on a retry after a confirmed write failed", async () => {
    const grants = new Map([["tab", grantFor("/out/fig.svg", true)]]);
    const { write, ctx, failOnce } = disk(["/out/fig.svg"]);
    // A file appeared since the pick: the user confirms, but the replacing write fails.
    ctx.confirmReplace.mockImplementationOnce(async () => { failOnce(new Error("disk full")); return true; });
    await expect(writeGrantedRepeatedExtensionTarget(grants, "tab", "/out/fig.svg", ctx, write)).rejects.toThrow("disk full");
    expect(grants.get("tab")!.recheck).toBe(true);
    // The retry re-checks and asks again before replacing.
    await expect(writeGrantedRepeatedExtensionTarget(grants, "tab", "/out/fig.svg", ctx, write)).resolves.toBe(true);
    expect(ctx.confirmReplace).toHaveBeenCalledTimes(2);
    expect(grants.get("tab")!.recheck).toBe(false);
  });

  it("still asks on a retry after the user declined", async () => {
    const grants = new Map([["tab", grantFor("/out/fig.svg", true)]]);
    const { write, ctx } = disk(["/out/fig.svg"]);
    ctx.confirmReplace.mockResolvedValueOnce(false);
    await expect(writeGrantedRepeatedExtensionTarget(grants, "tab", "/out/fig.svg", ctx, write)).resolves.toBe(false);
    expect(grants.get("tab")!.recheck).toBe(true);
    await expect(writeGrantedRepeatedExtensionTarget(grants, "tab", "/out/fig.svg", ctx, write)).resolves.toBe(true);
    expect(ctx.confirmReplace).toHaveBeenCalledTimes(2);
  });

  it("writes normally without a matching grant", async () => {
    const grants = new Map([["tab", grantFor("/out/other.svg", true)]]);
    const { write, ctx } = disk(["/out/fig.svg"]);
    await expect(writeGrantedRepeatedExtensionTarget(grants, "tab", "/out/fig.svg", ctx, write)).resolves.toBe(true);
    expect(write.mock.calls).toEqual([["/out/fig.svg", { createNew: false }]]);
    expect(grants.get("tab")).toEqual(grantFor("/out/other.svg", true));
  });

  it("leaves a grant replaced while the user was being asked alone", async () => {
    const grants = new Map([["tab", grantFor("/out/fig.svg", true)]]);
    const { write, ctx } = disk(["/out/fig.svg"]);
    const newer = grantFor("/out/new.svg", true);
    ctx.confirmReplace.mockImplementationOnce(async () => { grants.set("tab", newer); return true; });
    await expect(writeGrantedRepeatedExtensionTarget(grants, "tab", "/out/fig.svg", ctx, write)).resolves.toBe(true);
    expect(grants.get("tab")).toBe(newer);
  });
});

describe("resolveAppendedExtensionSavePath", () => {
  function appendedContext(existing: readonly string[], replace: boolean, ownPath?: string) {
    return {
      ownPath,
      exists: vi.fn(async (path: string) => existing.includes(path)),
      confirmReplace: vi.fn(async (_path: string) => replace)
    };
  }

  /** The Save As flow: resolve the appended path, then write only what was resolved. */
  async function saveAs(selected: string, appended: string, ctx: ReturnType<typeof appendedContext>) {
    const write = vi.fn(async (_path: string) => {});
    const path = await resolveAppendedExtensionSavePath(selected, appended, ctx);
    if (path) await write(path);
    return { path, write };
  }

  it("asks before replacing an existing file the extension was appended onto; Cancel writes nothing", async () => {
    const ctx = appendedContext(["/home/me/bare.chemdraft"], false);
    const { path, write } = await saveAs("/home/me/bare", "/home/me/bare.chemdraft", ctx);
    expect(ctx.confirmReplace).toHaveBeenCalledWith("/home/me/bare.chemdraft");
    expect(path).toBeUndefined();
    expect(write).not.toHaveBeenCalled();
  });

  it("writes the appended path once the user chooses Replace", async () => {
    const ctx = appendedContext(["C:\\Users\\me\\bare.chemdraft"], true);
    const { path, write } = await saveAs("C:\\Users\\me\\bare", "C:\\Users\\me\\bare.chemdraft", ctx);
    expect(ctx.confirmReplace).toHaveBeenCalledTimes(1);
    expect(path).toBe("C:\\Users\\me\\bare.chemdraft");
    expect(write).toHaveBeenCalledWith("C:\\Users\\me\\bare.chemdraft");
  });

  it("does not ask when the panel already returned the final path, even if it exists", async () => {
    const ctx = appendedContext(["/Users/me/bare.chemdraft"], false);
    const { path, write } = await saveAs("/Users/me/bare.chemdraft", "/Users/me/bare.chemdraft", ctx);
    expect(ctx.exists).not.toHaveBeenCalled();
    expect(ctx.confirmReplace).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith("/Users/me/bare.chemdraft");
  });

  it("does not ask when the appended path is free or is the document's own file", async () => {
    const free = appendedContext([], false);
    await expect(resolveAppendedExtensionSavePath("/tmp/new", "/tmp/new.svg", free)).resolves.toBe("/tmp/new.svg");
    expect(free.confirmReplace).not.toHaveBeenCalled();
    const own = appendedContext(["/tmp/doc.chemdraft"], false, "/tmp/doc.chemdraft");
    await expect(resolveAppendedExtensionSavePath("/tmp/doc", "/tmp/doc.chemdraft", own)).resolves.toBe("/tmp/doc.chemdraft");
    expect(own.confirmReplace).not.toHaveBeenCalled();
  });

  it("keeps the appended path, as before, when it cannot be checked", async () => {
    const ctx = appendedContext([], false);
    ctx.exists.mockRejectedValueOnce(new Error("forbidden path"));
    await expect(resolveAppendedExtensionSavePath("/mnt/x", "/mnt/x.pdf", ctx)).resolves.toBe("/mnt/x.pdf");
    expect(ctx.confirmReplace).not.toHaveBeenCalled();
  });
});
