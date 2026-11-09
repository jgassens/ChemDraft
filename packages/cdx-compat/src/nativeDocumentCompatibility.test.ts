import { describe, expect, it, vi } from "vitest";
import { createEmptyDocument, readDocument, serializeDocument, type MoleculeObject, type TextObject } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";

describe("native document compatibility inside a CDXML envelope", () => {
  it("restores future native data before encoding, rather than persisting an internal sidecar", () => {
    const source = createEmptyDocument({ now: "2026-11-09T00:00:00.000Z" });
    const raw = JSON.parse(serializeDocument(source));
    raw.formatVersion = "1.3.0";
    raw.minAppVersion = "1.3.0";
    raw.futureNestedObject = { properties: ["preserved", null, 123] };
    raw.pages[0].objects.push({ id: "m", type: "molecule", x: 0, y: 0, width: 22, height: 1,
      rotation: 0, style: {}, structureFormat: "smiles", structure: "CC", superatoms: [], rGroups: [],
      atoms: [{ id: "a", element: "C", x: 0, y: 0, formalCharge: 0 }, { id: "b", element: "C", x: 22, y: 0, formalCharge: 0 }],
      bonds: [{ id: "bond", fromAtomId: "a", toAtomId: "b", order: "single", display: { bondStyle: "future-wave" } }] });
    const active = readDocument(raw).document;
    expect((active.pages[0]!.objects[0] as MoleculeObject).bonds[0]!.display?.bondStyle).toBeUndefined();
    const envelope = exportDocumentToCdxml(active);
    const reopened = openChemDraftPayload(envelope.contents);
    expect(reopened.document).toBeDefined();
    expect(JSON.parse(serializeDocument(reopened.document!))).toEqual(raw);
    expect(reopened.nativeDocumentVersions).toEqual({ formatVersion: "1.3.0", minAppVersion: "1.3.0" });
    expect(reopened.warnings).toContainEqual(expect.objectContaining({ code: "NATIVE_BOND_STYLE_FALLBACK", originalValue: "future-wave" }));
    const legacyJson = openChemDraftPayload(JSON.stringify(raw));
    expect(legacyJson.nativeDocumentVersions).toEqual(reopened.nativeDocumentVersions);
    expect(legacyJson.warnings).toContainEqual(expect.objectContaining({ code: "NATIVE_UNKNOWN_FIELD_PRESERVED" }));
    expect(reopened.warnings).not.toContainEqual(expect.objectContaining({ code: "cdxml.native_payload_invalid" }));
  });

  it("returns and logs dropped-data warnings to envelope save callers", () => {
    const source = { ...createEmptyDocument(), formatVersion: "1.3.0", minAppVersion: "1.3.0" };
    const raw = JSON.parse(JSON.stringify(source));
    raw.pages[0].objects.push({ id: "text", type: "text", x: 0, y: 0, width: 30, height: 30, rotation: 0,
      style: {}, text: "firstsecond", spans: [{ text: "first", futureFont: "original" }, { text: "second" }] });
    const active = readDocument(raw).document;
    (active.pages[0]!.objects[0] as TextObject).spans.reverse();
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const saved = exportDocumentToCdxml(active);
      expect(saved.warnings).toContainEqual(expect.objectContaining({ code: "NATIVE_EXTENSION_DATA_DROPPED" }));
      expect(log).toHaveBeenCalledWith("Native document compatibility", expect.objectContaining({ code: "NATIVE_EXTENSION_DATA_DROPPED" }));
      const reopened = openChemDraftPayload(saved.contents).document!;
      expect(serializeDocument(reopened)).not.toContain("futureFont");
      expect((reopened.pages[0]!.objects[0] as TextObject).spans.map(span => span.text)).toEqual(["second", "first"]);
    } finally { log.mockRestore(); }
  });
});
