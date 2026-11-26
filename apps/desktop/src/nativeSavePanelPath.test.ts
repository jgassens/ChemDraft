import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({ existing: new Set<string>() }));
const prompt = vi.hoisted(() => ({ answer: "cancel", calls: [] as { message: string; platform: unknown }[] }));

vi.mock("@tauri-apps/plugin-fs", () => ({ exists: async (path: string) => fs.existing.has(path) }));
vi.mock("./nativePrompt", () => ({
  nativePrompt: async (options: { message: string }, _fallback: unknown, _signal: unknown, _onShowing: unknown, platform: unknown) => {
    prompt.calls.push({ message: options.message, platform });
    return prompt.answer;
  }
}));

import { resolveNativeAppendedExtensionPath } from "./nativeSavePanelPath";

beforeEach(() => {
  fs.existing.clear();
  prompt.answer = "cancel";
  prompt.calls = [];
});

describe("resolveNativeAppendedExtensionPath", () => {
  it.each([
    ["linux", "/home/me/bare", "/home/me/bare.chemdraft"],
    ["windows", "C:\\Users\\me\\bare", "C:\\Users\\me\\bare.chemdraft"]
  ] as const)("asks Replace / Cancel on %s for an existing appended path; Cancel resolves undefined", async (platform, selected, appended) => {
    fs.existing.add(appended);
    await expect(resolveNativeAppendedExtensionPath(selected, appended, { platform })).resolves.toBeUndefined();
    expect(prompt.calls).toEqual([{ message: "“bare.chemdraft” already exists. Do you want to replace it?", platform }]);
    prompt.answer = "replace";
    await expect(resolveNativeAppendedExtensionPath(selected, appended, { platform })).resolves.toBe(appended);
  });

  it.each(["macos", "windows", "linux"] as const)("does not ask on %s when the panel returned the final path", async (platform) => {
    fs.existing.add("/Users/me/bare.chemdraft");
    await expect(resolveNativeAppendedExtensionPath("/Users/me/bare.chemdraft", "/Users/me/bare.chemdraft", { platform }))
      .resolves.toBe("/Users/me/bare.chemdraft");
    expect(prompt.calls).toEqual([]);
  });
});

describe("paths that append an extension after the save panel", () => {
  const source = readFileSync(new URL("./MainWindow.tsx", import.meta.url), "utf8");

  it("Save As confirms the appended .chemdraft path before writing", () => {
    expect(source).toMatch(/path = picked && await resolveNativeAppendedExtensionPath\(picked, ensureChemDraftFileExtension\(picked\),/);
  });

  it("the template export uses the same helper for its appended .template path", () => {
    expect(source).toContain('resolveNativeAppendedExtensionPath(resolved, ensureExportFileExtension(resolved, ["template"]))');
  });

  it("no other caller appends an extension to a panel path without the helper", () => {
    const appends = source.match(/ensure(?:ChemDraft|Export)FileExtension\((?:path|resolved|picked)[,)]/g) ?? [];
    // Save As (helper + the idempotent final normalisation) and the template export.
    expect(appends.sort()).toEqual([
      "ensureChemDraftFileExtension(path)",
      "ensureChemDraftFileExtension(picked)",
      "ensureExportFileExtension(resolved,"
    ].sort());
  });
});
