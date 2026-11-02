import { readFileSync } from "node:fs";
import { CommandRegistry } from "@chemdraft/plugin-host";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreCommandRegistrar, type CoreCommandBinding } from "../commands/coreCommandRegistrar";
import { registerVibeCodeStarter, VIBE_CODE_STARTER_COMMAND_ID, vibeCodeStarterCommand } from "../commands/vibeCodeStarter";
import { save } from "../nativeFileDialog";
import { PLUGIN_STARTER_FILENAME, type VibeCodeStarterSaveOptions } from "./vibeCodeStarter";

const native = vi.hoisted(() => ({
  save: vi.fn(), write: vi.fn(), documents: vi.fn(), join: vi.fn(), version: vi.fn()
}));
vi.mock("../nativeFileDialog", () => ({ save: native.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: native.write }));
vi.mock("@tauri-apps/api/path", () => ({ documentDir: native.documents, join: native.join }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: native.version }));

function setup(isDesktop = true) {
  const registry = new CommandRegistry();
  const bindings = new Map<string, CoreCommandBinding>();
  const download = vi.fn();
  const onError = vi.fn();
  // Same picker/writer contract as MainWindow's existing export/save helpers.
  const options: VibeCodeStarterSaveOptions = {
    isDesktop,
    pickSavePath: async (defaultPath, formatLabel, extensions) => await save({
      title: `Export ${formatLabel}`, defaultPath,
      filters: [{ name: formatLabel, extensions: [...extensions] }]
    }) ?? undefined,
    writeText: async (path, contents) => {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, contents);
    },
    download
  };
  registerVibeCodeStarter((spec, run) => bindings.set(spec.id, { spec, run }), options, onError);
  createCoreCommandRegistrar(registry, () => bindings)(bindings);
  return { registry, download, onError };
}

beforeEach(() => {
  vi.resetAllMocks();
  native.documents.mockResolvedValue("Documents");
  native.join.mockImplementation(async (...parts: string[]) => parts.join("/"));
  native.version.mockResolvedValue("9.8.7");
});

describe("plugin starter command", () => {
  it.each([
    ["/Users/test/Documents", "/Users/test/Documents/ChemDraft plugin starter.md", "/chosen/brief.custom"],
    ["C:\\Users\\test\\Documents", "C:\\Users\\test\\Documents\\ChemDraft plugin starter.md", "D:\\chosen\\brief.custom"]
  ])("registers and saves exactly the selected path from %s", async (documents, defaultPath, selected) => {
    native.documents.mockResolvedValue(documents);
    native.join.mockResolvedValue(defaultPath);
    native.save.mockResolvedValue(selected);
    const { registry, download, onError } = setup();
    expect(VIBE_CODE_STARTER_COMMAND_ID).toBe("plugins.vibeCodeStarter");
    expect(vibeCodeStarterCommand.title).toBe("Vibe Code Your Own Plugin…");
    await registry.invoke(VIBE_CODE_STARTER_COMMAND_ID);
    expect(native.join).toHaveBeenCalledWith(documents, PLUGIN_STARTER_FILENAME);
    expect(native.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      defaultPath, filters: [{ name: "ChemDraft plugin starter", extensions: ["md"] }]
    }));
    expect(native.write).toHaveBeenCalledExactlyOnceWith(selected, expect.stringContaining("ChemDraft 9.8.7"));
    expect(download).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith("Saved plugin starter to brief.custom");
  });

  it("does nothing on Cancel", async () => {
    native.save.mockResolvedValue(null);
    const { registry, download, onError } = setup();
    await registry.invoke(VIBE_CODE_STARTER_COMMAND_ID);
    expect(native.write).not.toHaveBeenCalled();
    expect(native.version).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("downloads the same brief with the configured app version in the browser", async () => {
    const { registry, download, onError } = setup(false);
    await registry.invoke(VIBE_CODE_STARTER_COMMAND_ID);
    const config = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
    expect(download).toHaveBeenCalledExactlyOnceWith(PLUGIN_STARTER_FILENAME,
      expect.stringContaining(`ChemDraft ${config.version}`), "text/markdown;charset=utf-8");
    expect(native.save).not.toHaveBeenCalled();
    expect(native.write).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledExactlyOnceWith(`Saved plugin starter to ${PLUGIN_STARTER_FILENAME}`);
  });

  it("reports native write failures without downloading or retrying", async () => {
    native.save.mockResolvedValue("/chosen/brief.md");
    native.write.mockRejectedValue(new Error("Disk full"));
    const { registry, download, onError } = setup();
    await registry.invoke(VIBE_CODE_STARTER_COMMAND_ID);
    expect(onError).toHaveBeenCalledExactlyOnceWith("Could not save plugin starter: Disk full");
    expect(native.write).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
  });

  it("uses the tested binding and existing save helpers in MainWindow and exposes Customize", () => {
    const main = readFileSync(new URL("../MainWindow.tsx", import.meta.url), "utf8");
    expect(main).toContain("registerVibeCodeStarter(register, {");
    expect(main).toContain("pickSavePath: pickNativeExportPath");
    expect(main).toContain("writeText: writeNativeTextFile");
    expect(main).toContain("download: downloadText");
    expect(main).toContain("}), vibeCodeStarterCommand]");
    expect(main).toContain("for (const command of shellCommandSpecs)");
  });
});
