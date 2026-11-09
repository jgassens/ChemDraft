import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPatch, createEmptyDocument, readSerializedDocument, serializeDocument } from "@chemdraft/chem-core";
import { createNativeSavePayload, normalizeCommittedDocument, openNativeDocument } from "./documentWorkflow";
import { notifyNativeDocumentCompatibility } from "./nativeDocumentNotice";
import { nativePromptButtons, setNativePromptProvider, type NativePromptOptions } from "./nativePrompt";

function futureFile() {
  return JSON.stringify({ ...createEmptyDocument(), formatVersion: "1.10.0", minAppVersion: "1.10.2",
    conditionsLabel: { text: "future conditions" }, styles: { drawing: { stylePresetId: "future-preset" } } });
}

afterEach(() => vi.restoreAllMocks());

describe("native document compatibility notice", () => {
  it.each(["macos", "windows"] as const)("shows one document-owned notice with the file minimum on %s", async platform => {
    const prompt = vi.fn(async (_options: NativePromptOptions) => "ok");
    const restore = setNativePromptProvider(prompt);
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const opened = openNativeDocument(futureFile());
      expect(opened.warnings).toHaveLength(2);
      await notifyNativeDocumentCompatibility(opened, opened.document!, platform);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(prompt.mock.calls[0]![0]).toMatchObject({ owner: "document", kind: "warning",
        message: "This file was made with a newer ChemDraft (1.10.2). Some features may not show. Update to keep them." });
      expect(nativePromptButtons(prompt.mock.calls[0]![0], platform)).toEqual({ ok: "OK" });
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls.map(call => call[1])).toEqual(opened.warnings);
    } finally { restore(); }
  });

  it.each([undefined, "1.1.1", "1.2.0"])("does not notify for minimum %s", async minAppVersion => {
    const prompt = vi.fn(async () => "ok");
    const restore = setNativePromptProvider(prompt);
    try {
      const opened = openNativeDocument(JSON.stringify({ ...createEmptyDocument(), ...(minAppVersion ? { minAppVersion } : {}) }));
      await notifyNativeDocumentCompatibility(opened, opened.document!);
      expect(prompt).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it("notifies for a newer minimum even without any fallback warnings", async () => {
    const prompt = vi.fn(async () => "ok");
    const restore = setNativePromptProvider(prompt);
    try {
      const opened = openNativeDocument(JSON.stringify({ ...createEmptyDocument(), minAppVersion: "1.3.0" }));
      expect(opened.warnings).toEqual([]);
      await notifyNativeDocumentCompatibility(opened, opened.document!);
      expect(prompt).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });

  it("does not notify for edited visible CDXML when its future embedded document was not chosen", async () => {
    const prompt = vi.fn(async () => "ok");
    const restore = setNativePromptProvider(prompt);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await notifyNativeDocumentCompatibility(openNativeDocument(futureFile()), createEmptyDocument());
      expect(prompt).not.toHaveBeenCalled();
    } finally { restore(); }
  });
});

it("retains future content and its minimum through app normalization, edits, Save and session serialization", () => {
  const future = JSON.parse(futureFile());
  future.pages[0].objects.push({
    id: "m", type: "molecule", x: 0, y: 0, width: 30, height: 30, rotation: 0,
    style: {}, structureFormat: "smiles", structure: "CO", superatoms: [], rGroups: [],
    atoms: [{ id: "c", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "o", element: "O", x: 22, y: 0, formalCharge: 0 }],
    bonds: [{ id: "b", fromAtomId: "c", toAtomId: "o", order: "single", display: { bondStyle: "future-wavy" } }]
  });
  const opened = openNativeDocument(JSON.stringify(future)).document!;
  const normalized = normalizeCommittedDocument(opened);
  const edited = applyPatch(normalized, { op: "setSelection", objectIds: [] });
  const session = readSerializedDocument(serializeDocument(edited)).document;
  const saved = createNativeSavePayload(session);
  const reopened = openNativeDocument(saved.contents);
  expect(reopened.nativeDocumentVersions?.minAppVersion).toBe("1.10.2");
  const raw = JSON.parse(serializeDocument(reopened.document!));
  expect(raw.conditionsLabel).toEqual({ text: "future conditions" });
  expect(raw.styles.drawing.stylePresetId).toBe("future-preset");
  expect(raw.pages[0].objects[0].bonds[0].display.bondStyle).toBe("future-wavy");
  expect(raw.pages[0].objects[0].atoms.map((atom: { element: string }) => atom.element)).toEqual(["C", "O"]);
  expect(raw.minAppVersion).toBe("1.10.2");
  expect(raw.compatibility.nativeExtensions).toBeUndefined();
});
