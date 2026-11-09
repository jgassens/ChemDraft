import { describe, expect, it, vi } from "vitest";
import { applyPatch, createEmptyDocument, readDocument, serializeDocument, type MoleculeObject, type TextObject } from "@chemdraft/chem-core";
import { canonicalVisibleCdxml, exportDocumentToCdxml, openChemDraftPayload } from "./index";

describe("native document compatibility inside a CDXML envelope", () => {
  it.each([undefined, "1.3.0"])("preserves main's degraded chemistry enums, without a single-bond guess, with version %s", version => {
    const raw = JSON.parse(serializeDocument(createEmptyDocument()));
    if (version) Object.assign(raw, { formatVersion: version, minAppVersion: version });
    const base = { x: 0, y: 0, width: 30, height: 30, rotation: 0, style: {} };
    const point = { kind: "point", point: { x: 0, y: 0 } };
    raw.pages[0].objects = [
      { ...base, id: "m", type: "molecule", structureFormat: "future-encoding", structure: "CC",
        atoms: [{ id: "a", element: "C", x: 0, y: 0 }, { id: "b", element: "C", x: 22, y: 0 }],
        bonds: [{ id: "bond", fromAtomId: "a", toAtomId: "b", order: "quadruple" }],
        superatoms: [{ label: "Me", expandedStructureFormat: "future-expansion" }] },
      { ...base, id: "r", type: "reaction", components: [], mappingState: "future-mapping" },
      { ...base, id: "a", type: "mechanism-arrow", arrowKind: "future-mechanism", source: point, target: point },
      { ...base, id: "e", type: "electron-mark", markKind: "future-electrons", anchor: point },
      { ...base, id: "s", type: "superatom", label: "Et", metadata: { label: "Et", expandedStructureFormat: "future-standalone-expansion" } }
    ];
    const active = readDocument(raw);
    expect(active.warnings).toHaveLength(7);
    expect(active.document.pages[0]!.objects).toMatchObject([
      { structureFormat: "unknown", bonds: [{ order: "unknown" }], superatoms: [{ expandedStructureFormat: "unknown" }] },
      { mappingState: "unknown" }, { arrowKind: "unknown" }, { markKind: "unknown" },
      { metadata: { expandedStructureFormat: "unknown" } }
    ]);
    const exported = exportDocumentToCdxml(active.document);
    const visible = canonicalVisibleCdxml(exported.contents);
    expect(visible).toContain('Order="any"');
    expect(visible).not.toContain('Order="1"');
    expect(exported.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.unknown_bond_order" }));
    expect(exported.warnings.filter(w => w.code === "cdxml.native_enum_payload_only").map(w => w.originalValue).sort())
      .toEqual(["quadruple", "future-encoding", "future-expansion", "future-mapping", "future-mechanism", "future-electrons", "future-standalone-expansion"].sort());
    const reopened = openChemDraftPayload(exported.contents);
    expect(reopened.source).toBe("native-payload");
    expect(reopened.warnings.filter(w => w.code === "NATIVE_CHEMISTRY_ENUM_FALLBACK")).toHaveLength(7);
    expect(JSON.parse(serializeDocument(reopened.document!)).pages[0].objects).toMatchObject(raw.pages[0].objects);
    const external = openChemDraftPayload(visible).document!;
    expect((external.pages[0]!.objects.find(o => o.type === "molecule") as MoleculeObject).bonds[0]!.order).toBe("unknown");

    // Resolving the order is an explicit edit: neither save route revives the old value or warning.
    const molecule = active.document.pages[0]!.objects[0] as MoleculeObject;
    const resolved = applyPatch(active.document, { op: "updateObject", objectId: molecule.id,
      changes: { bonds: molecule.bonds.map(bond => ({ ...bond, order: "double" })) } });
    const corrected = exportDocumentToCdxml(resolved);
    expect(corrected.warnings).not.toContainEqual(expect.objectContaining({ originalValue: "quadruple" }));
    expect(JSON.parse(serializeDocument(openChemDraftPayload(corrected.contents).document!)).pages[0].objects[0].bonds[0].order).toBe("double");
  });

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
