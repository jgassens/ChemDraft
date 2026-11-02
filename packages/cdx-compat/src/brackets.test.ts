import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEmptyDocument, type BracketObject } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, openChemDraftPayload } from "./index";

function fixture(name: string) { return readFileSync(new URL(`../../fixtures/cdxml/${name}.cdxml`, import.meta.url), "utf8"); }
function visibleOnly(cdxml: string) { return cdxml.replace(/<objecttag\b[^>]*\/>/g, ""); }
function pair(kind: "square" | "round", label?: string) {
  const document = createEmptyDocument();
  const open: BracketObject = { id: "b1", type: "bracket", bracketKind: kind, side: "open", pairId: "b1",
    x: 100, y: 120, width: 16, height: 64, rotation: 0, style: {}, containedObjectIds: [],
    ...(label === undefined ? {} : { repeatUnit: true }) };
  document.pages[0].objects = [open, { ...open, id: "b2", x: 244, side: "close", ...(label ? { label } : {}) }];
  return document;
}
const geometry = (objects: BracketObject[]) => objects.map(({ bracketKind, side, x, y, width, height, repeatUnit, label }) =>
  ({ bracketKind, side, x, y, width, height, repeatUnit, label }));

describe("CDXML bracket graphics", () => {
  it.each(["square", "round"] as const)("imports the %s fixture as a native pair and round-trips its visible geometry", kind => {
    const imported = openChemDraftPayload(fixture(`brackets-${kind}`));
    expect(imported.warnings.map(warning => warning.code)).toEqual(["cdxml.external_subset_imported"]);
    const original = imported.document!.pages[0].objects as BracketObject[];
    expect(original.map(object => object.side)).toEqual(["open", "close"]);
    expect(original[0].pairId).toBe(original[1].pairId);
    expect(geometry(original)).toEqual(geometry(pair(kind).pages[0].objects as BracketObject[]));
    const exported = exportDocumentToCdxml(imported.document!);
    expect(exported.contents).toContain('GraphicType="Bracket"');
    expect(exported.contents).toContain(`BracketType="${kind === "round" ? "Round" : "Square"}"`);
    expect(exported.contents).toContain("<bracketedgroup");
    expect(exported.contents.match(/<bracketattachment\b/g)).toHaveLength(2);
    expect(exported.warnings).toEqual([]);
    const reopened = openChemDraftPayload(visibleOnly(exported.contents));
    expect(geometry(reopened.document!.pages[0].objects as BracketObject[])).toEqual(geometry(original));
  });

  it.each(["square", "round"] as const)("preserves native %s pairs and repeat labels n/m exactly in the document envelope", kind => {
    for (const label of [undefined, "n", "m"]) {
      const native = pair(kind, label);
      const exported = exportDocumentToCdxml(native);
      expect(openChemDraftPayload(exported.contents).document).toEqual(native);
      expect(exported.warnings.some(warning => warning.code === "cdxml.bracket_payload_only")).toBe(false);
      if (label) {
        expect(exported.contents).toContain('BracketUsage="SRU"');
        expect(exported.contents).toContain(`>${label}</s>`);
        expect(exported.warnings.map(warning => warning.code)).toEqual([
          "cdxml.repeat_label_payload_only", "cdxml.repeat_connectivity_not_represented"
        ]);
        expect(exported.warnings.map(warning => warning.message)).toEqual([
          `CDXML export: repeat-unit label "${label}" of bracket pair b1 is visible, but its association with the bracket pair is kept only in the embedded ChemDraft payload.`,
          "CDXML export: bracket pair b1 has whole-molecule membership only; atom membership, polymer crossing bonds and head-to-tail connectivity are not written."
        ]);
      }
    }
  });

  it("preserves external repeat label text independently and warns about its unverified association", () => {
    const imported = openChemDraftPayload(fixture("brackets-repeat-labels"));
    expect(imported.document!.pages[0].objects.filter(object => object.type === "text").map(object => object.text)).toEqual(["n", "m"]);
    expect(imported.document!.pages[0].objects.filter(object => object.type === "bracket").every(object => object.repeatUnit)).toBe(true);
    expect(imported.warnings.map(warning => warning.code)).toEqual(["cdxml.external_subset_imported", "cdxml.repeat_label_unassociated", "cdxml.repeat_label_unassociated"]);
    expect(imported.warnings.slice(1).map(warning => warning.message)).toEqual(["pair1", "pair2"].map(id =>
      `CDXML import: repeat-unit label association for bracket group ${id} is not interpreted; separate label text is retained independently.`));
  });

  it("preserves unknown bracket types and crossing attachments instead of assigning polymer connectivity", () => {
    const unfamiliar = openChemDraftPayload(fixture("brackets-square").replaceAll('BracketType="Square"', 'BracketType="FutureBracket"'));
    expect(unfamiliar.document!.pages[0].objects[0].type).toBe("unknown-compatibility-object");
    expect(JSON.stringify(unfamiliar.document!.pages[0].objects[0])).toContain("FutureBracket");
    expect(unfamiliar.warnings.map(warning => warning.code)).toContain("cdxml.bracket_type_preserved");
    const imported = openChemDraftPayload(fixture("crossing-bonds"));
    const unknown = imported.document!.pages[0].objects.find(object => object.type === "unknown-compatibility-object");
    expect(JSON.stringify(unknown)).toContain("crossingbond");
    expect(JSON.stringify(unknown)).toContain("InnerAtomID");
    expect(imported.warnings.find(warning => warning.code === "cdxml.bracket_group_preserved")?.message).toBe("CDXML import: bracket group bg_crossing has unsupported attachment count or bracket references; the following data is not interpreted: atom or object membership and crossing-bond attachments; the group is preserved as an unknown compatibility object.");
    const paired = fixture("crossing-bonds").replace('<bracketedgroup id="bg_crossing"', '<graphic id="g_other" BoundingBox="198 174 186 186" GraphicType="Bracket" BracketType="Round"/><bracketedgroup id="bg_crossing"')
      .replace('</bracketedgroup>', '<bracketattachment id="ba_other" GraphicID="g_other"/></bracketedgroup>');
    expect(openChemDraftPayload(paired).warnings.find(warning => warning.code === "cdxml.bracket_semantics_preserved")?.message)
      .toBe("CDXML import: bracket group bg_crossing has unsupported crossing-bond attachments, unresolved atom or object membership; this data is preserved as an unknown compatibility object and is not interpreted as polymer connectivity.");
    const unsupported = pair("round");
    unsupported.pages[0].objects[0].rotation = 30;
    expect(exportDocumentToCdxml(unsupported).warnings.map(warning => warning.code)).toContain("cdxml.bracket_payload_only");
  });
});
