import { describe, expect, it } from "vitest";
import { createEmptyDocument, type BracketObject, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { CDX_NATIVE_ENVELOPE_ATTRIBUTE, cdxElementToCdxml, readCdx, type CdxElement } from "./cdxBinary";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

const cases = [
  { usage: "sru", label: "n", count: undefined },
  { usage: "multiple", label: undefined, count: 3 },
  { usage: "generic", label: undefined, count: undefined }
] as const;

// Entirely native, synthetic document: no imported source IDs or bracket compatibility snapshots.
function nativeRepeatUnit({ usage, label, count }: typeof cases[number]): ChemDraftDocument {
  const document = createEmptyDocument({ now: "2026-11-10T00:00:00.000Z" });
  const molecule: MoleculeObject = {
    id: "molecule_1", type: "molecule", x: 40, y: 100, width: 110, height: 1, rotation: 0, style: {},
    structure: "", structureFormat: "unknown", superatoms: [], rGroups: [],
    atoms: [
      { id: "stub_left", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "ch2_left", element: "C", x: 40, y: 0, formalCharge: 0 },
      { id: "ch2_right", element: "C", x: 70, y: 0, formalCharge: 0 },
      { id: "stub_right", element: "C", x: 110, y: 0, formalCharge: 0 }
    ],
    bonds: [
      { id: "crossing_left", fromAtomId: "stub_left", toAtomId: "ch2_left", order: "single" },
      { id: "unit_bond", fromAtomId: "ch2_left", toAtomId: "ch2_right", order: "single" },
      { id: "crossing_right", fromAtomId: "ch2_right", toAtomId: "stub_right", order: "single" }
    ]
  };
  const open: BracketObject = {
    id: "bracket_1", type: "bracket", bracketKind: "square", side: "open", pairId: "bracket_1",
    x: 60, y: 80, width: 6, height: 40, rotation: 0, style: {},
    bracketUsage: usage, containedObjectIds: [molecule.id],
    crossingBondIds: [{ objectId: molecule.id, bondId: "crossing_left" }],
    ...(usage === "sru" ? { repeatUnit: true } : {}),
    ...(count === undefined ? {} : { repeatCount: count }),
    compatibility: { sourceFormat: "chemdraft-native", warnings: [], unknown: {} }
  };
  document.pages[0].objects = [molecule, open, {
    ...open, id: "bracket_2", x: 124, side: "close",
    crossingBondIds: [{ objectId: molecule.id, bondId: "crossing_right" }],
    ...(label === undefined ? {} : { label })
  }];
  return document;
}

function elements(root: CdxElement, name: string): CdxElement[] {
  return [...(root.name === name ? [root] : []), ...root.kids.flatMap(child => elements(child, name))];
}

function state(document: ChemDraftDocument) {
  const objects = document.pages[0].objects;
  return objects.filter((object): object is BracketObject => object.type === "bracket").map(bracket => ({
    kind: bracket.bracketKind, side: bracket.side,
    paired: !!bracket.pairId && objects.filter(object => object.type === "bracket" && object.pairId === bracket.pairId).length === 2,
    usage: bracket.bracketUsage, repeatUnit: bracket.repeatUnit, count: bracket.repeatCount, label: bracket.label,
    members: bracket.containedObjectIds.map(id => objects.findIndex(object => object.id === id)),
    crossings: (bracket.crossingBondIds ?? []).map(ref => {
      const molecule = objects.find(object => object.id === ref.objectId);
      return [objects.indexOf(molecule!), molecule?.type === "molecule" ? molecule.bonds.findIndex(bond => bond.id === ref.bondId) : -1];
    })
  }));
}

describe.each([false, true])("native bracket CDX round trip (payload=%s)", embedNativePayload => {
  it.each(cases)("preserves $usage semantics and attachments", testCase => {
    const original = nativeRepeatUnit(testCase);
    const expected = state(original);
    const cdxml = exportDocumentToCdxml(original, { embedNativePayload: false });
    const xmlReopened = openChemDraftPayload(cdxml.contents);
    const exported = exportDocumentToCdx(original, { embedNativePayload });
    const reopened = importCdx(exported.bytes);
    const decoded = readCdx(exported.bytes);
    delete decoded.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE];
    const visible = openChemDraftPayload(cdxElementToCdxml(decoded));
    console.log(JSON.stringify({ usage: testCase.usage, embedNativePayload, original: expected,
      cdxml: state(xmlReopened.document!), cdx: state(reopened.document!), visible: state(visible.document!),
      group: elements(decoded, "bracketedgroup"), graphics: elements(decoded, "graphic").map(graphic => graphic.attrs),
      warnings: [...exported.warnings, ...reopened.warnings, ...visible.warnings] }));
    expect(state(xmlReopened.document!)).toEqual(expected);
    expect(reopened.conflict).toBeUndefined();
    expect(reopened.source).toBe(embedNativePayload ? "native-payload" : "external-cdxml");
    expect(state(reopened.document!)).toEqual(expected);
    expect(state(visible.document!)).toEqual(expected);
    expect(reopened.warnings.some(warning => warning.code === "cdxml.bracket_group_preserved")).toBe(false);
  });
});
