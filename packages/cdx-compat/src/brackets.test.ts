import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPatch, createEmptyDocument, type BracketObject } from "@chemdraft/chem-core";
import { exportDocumentToCdxml, exportDocumentToCdx, importCdx, openChemDraftPayload } from "./index";
import { XMLParser } from "fast-xml-parser";
import { cdxElementFromOrderedTree, cdxElementToCdxml, readCdx, writeCdx } from "./cdxBinary";

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

const binary = (source: string) => writeCdx(cdxElementFromOrderedTree(new XMLParser({ preserveOrder: true,
  ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, trimValues: false }).parse(source)));

describe("native bracket group interchange", () => {
  it.each(["sru", "multiple"] as const)("round-trips %s fields, graphics and crossing bonds through visible CDXML and CDX", usage => {
    const source = fixture(`brackets-native-${usage}`);
    for (const imported of [openChemDraftPayload(source), importCdx(binary(source))]) {
      const document = imported.document!;
      const brackets = document.pages[0].objects.filter((object): object is BracketObject => object.type === "bracket");
      const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
      expect(brackets.map(object => object.side)).toEqual(["open", "close"]);
      expect(brackets.every(object => object.bracketUsage === usage)).toBe(true);
      expect(brackets[0].crossingBondIds).toEqual([{ objectId: molecule.id, bondId: molecule.bonds[0].id }]);
      expect(brackets[0].containedObjectIds).toEqual([molecule.id]);
      if (usage === "sru") expect(brackets[1]).toMatchObject({ repeatUnit: true, label: "x-y", repeatCount: 7 });
      else expect(brackets[1]).toMatchObject({ repeatCount: 3 });
      expect(document.pages[0].objects.some(object => object.type === "unknown-compatibility-object")).toBe(false);
      expect(molecule.atoms.map(atom => [atom.element, atom.formalCharge])).toEqual([["C", 0], ["O", 0]]);
      expect(molecule.bonds[0].order).toBe("single");
      const xml = visibleOnly(exportDocumentToCdxml(document).contents);
      const binaryXml = cdxElementToCdxml(readCdx(exportDocumentToCdx(document).bytes));
      for (const attribute of ['BoundingBox="87 138 75 90"', 'BoundingBox="183 90 195 138"', 'LipSize="60"', 'Z="4"',
        'IgnoreWarnings="yes"', 'RepeatCount="' + (usage === "sru" ? "7" : "3") + '"']) expect(xml).toContain(attribute);
      if (usage === "sru") for (const attribute of ['Warning="synthetic bracket warning"', 'color="5"', 'SRULabel="x-y"']) expect(xml).toContain(attribute);
      for (const attribute of ['BoundingBox="87 138 75 90"', 'BoundingBox="183 90 195 138"', 'LipSize="60"', 'Z="4"',
        'IgnoreWarnings="yes"', 'BracketType="' + (usage === "sru" ? "Round" : "Square") + '"',
        'RepeatCount="' + (usage === "sru" ? "7" : "3") + '"', 'BondID="13"', 'InnerAtomID="11"']) expect(binaryXml).toContain(attribute);
      if (usage === "sru") for (const attribute of ['Warning="synthetic bracket warning"', 'color="5"', 'SRULabel="x-y"']) expect(binaryXml).toContain(attribute);
      for (const roundTrip of [openChemDraftPayload(xml), importCdx(exportDocumentToCdx(document).bytes)]) {
        const page = roundTrip.document!.pages[0];
        const native = page.objects.filter((object): object is BracketObject => object.type === "bracket");
        const reopenedMolecule = page.objects.find(object => object.type === "molecule")!;
        expect(native.map(object => object.side)).toEqual(["open", "close"]);
        expect(native[0].crossingBondIds).toEqual([{ objectId: reopenedMolecule.id, bondId: reopenedMolecule.bonds[0].id }]);
        expect(native[1]).toMatchObject({ bracketUsage: usage, repeatCount: usage === "sru" ? 7 : 3 });
        const restored = visibleOnly(exportDocumentToCdxml(roundTrip.document!).contents);
        expect(restored).toContain('InnerAtomID="11"');
        expect(restored).toContain('BondID="13"');
        expect(restored).toContain('LipSize="60"');
        expect(restored).toContain('IgnoreWarnings="yes"');
      }
    }
  });

  it("preserves atom membership and unresolved crossing references without discarding a pair", () => {
    const source = fixture("brackets-native-sru").replace('BracketedObjectIDs="10"', 'BracketedObjectIDs="11 12 missing"')
      .replace('BondID="13"', 'BondID="999"');
    const imported = openChemDraftPayload(source);
    const brackets = imported.document!.pages[0].objects.filter((object): object is BracketObject => object.type === "bracket");
    expect(brackets.every(object => object.pairId && !object.containedObjectIds.length)).toBe(true);
    expect(imported.warnings.map(warning => warning.code)).toEqual(expect.arrayContaining([
      "cdxml.bracket_atom_membership_preserved", "cdxml.bracket_crossing_unresolved"]));
    const exported = visibleOnly(exportDocumentToCdxml(imported.document!).contents);
    expect(exported).toContain('BracketedObjectIDs="11 12 missing"');
    expect(exported).toContain('BondID="999"');
    expect(exported).toContain('InnerAtomID="11"');
  });

  it("regenerates edited geometry, counts, labels and deleted crossings while retaining untouched attributes", () => {
    const imported = openChemDraftPayload(fixture("brackets-native-multiple")).document!;
    const brackets = imported.pages[0].objects.filter((object): object is BracketObject => object.type === "bracket");
    let edited = applyPatch(imported, { op: "updateObject", objectId: brackets[0].id, changes: { x: brackets[0].x + 10, crossingBondIds: [] } });
    for (const bracket of brackets) edited = applyPatch(edited, { op: "updateObject", objectId: bracket.id, changes: { repeatCount: 4 } });
    const xml = visibleOnly(exportDocumentToCdxml(edited).contents);
    expect(xml).not.toContain('BoundingBox="87 138 75 90"');
    expect(xml).toContain('BoundingBox="183 90 195 138"');
    expect(xml).toContain('RepeatCount="4"');
    expect(xml).toContain('IgnoreWarnings="yes"');
    expect(xml).not.toContain("<crossingbond");
    const sru = openChemDraftPayload(fixture("brackets-native-sru")).document!;
    const close = sru.pages[0].objects.find(object => object.type === "bracket" && object.side === "close")!;
    expect(visibleOnly(exportDocumentToCdxml(applyPatch(sru, { op: "updateObject", objectId: close.id, changes: { label: "m" } })).contents)).toContain('SRULabel="m"');
  });

  it("retains additional group data and remaps custom colour indices to the same RGB", () => {
    const source = fixture("brackets-native-sru").replace('<page id="1"', '<colortable><color r="0.2" g="0.4" b="0.6"/></colortable><page id="1"')
      .replace('color="5"', 'color="2"').replace('SRULabel="x-y"', 'SRULabel="x-y" PolymerRepeatPattern="HeadToTail"')
      .replace('</bracketedgroup>', '<objecttag id="40" Name="synthetic-extra" Value="retain me"/></bracketedgroup>');
    const imported = openChemDraftPayload(source);
    expect(imported.warnings.map(warning => warning.code)).toContain("cdxml.bracket_data_preserved");
    const xml = visibleOnly(exportDocumentToCdxml(imported.document!).contents);
    expect(xml).toContain('PolymerRepeatPattern="HeadToTail"');
    expect(xml).toContain('Name="synthetic-extra"');
    expect(xml).toContain('Value="retain me"');
    const reopened = openChemDraftPayload(xml).document!;
    expect(reopened.pages[0].objects.find(object => object.type === "bracket" && object.side === "open")!.compatibility!.unknown.cdxmlCurveColor).toBe("#336699");
  });

  it("maps crossing BondID through the allocator when a source id collides", () => {
    const document = openChemDraftPayload(fixture("brackets-native-sru")).document!;
    const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
    document.pages[0].objects.unshift({ ...molecule, id: "other", compatibility: { sourceFormat: "cdxml", originalId: "13", warnings: [], unknown: {} } });
    const exported = exportDocumentToCdxml(document);
    const xml = visibleOnly(exported.contents);
    const crossingId = /<crossingbond[^>]* BondID="([^"]+)"/.exec(xml)![1];
    expect(crossingId).not.toBe("13");
    expect(xml).toContain('<b id="' + crossingId + '"');
    const reopened = openChemDraftPayload(xml).document!;
    const bracket = reopened.pages[0].objects.find(object => object.type === "bracket" && object.crossingBondIds?.length) as BracketObject;
    expect(bracket.crossingBondIds).toHaveLength(1);
    expect(bracket.crossingBondIds![0].objectId).toBe(bracket.containedObjectIds[0]);
    expect(exported.warnings.map(warning => warning.code)).toContain("cdxml.source_id_remapped");
  });

  it("preserves different glyph kinds and multiple attachments to the same crossing bond", () => {
    const source = fixture("brackets-native-sru").replace('id="21" GraphicType="Bracket" BracketType="Round"', 'id="21" GraphicType="Bracket" BracketType="Square"')
      .replace('<crossingbond id="32" BondID="13" InnerAtomID="11"/>', '<crossingbond id="32" BondID="13" InnerAtomID="11"/><crossingbond id="34" BondID="13" InnerAtomID="12"/>');
    const imported = openChemDraftPayload(source).document!;
    const xml = visibleOnly(exportDocumentToCdxml(imported).contents);
    expect(xml).toContain('BracketType="Round"');
    expect(xml).toContain('BracketType="Square"');
    expect(xml).toContain('InnerAtomID="11"');
    expect(xml).toContain('InnerAtomID="12"');
    expect(openChemDraftPayload(xml).document!.pages[0].objects.filter(object => object.type === "bracket" && object.pairId)).toHaveLength(2);
  });
});

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
        expect(exported.contents).toContain('SRULabel="' + label + '"');
        expect(exported.warnings).toEqual([]);
        const visible = openChemDraftPayload(visibleOnly(exported.contents)).document!;
        expect(visible.pages[0].objects.find(object => object.type === "bracket" && object.side === "close")).toMatchObject({ label });

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
    const xml = visibleOnly(exportDocumentToCdxml(imported.document!).contents);
    expect(xml).not.toContain("SRULabel=");
    expect(openChemDraftPayload(xml).warnings.filter(warning => warning.code === "cdxml.repeat_label_unassociated")).toHaveLength(2);
  });

  it("imports a standalone foreign bracket as a plain glyph without pair metadata", () => {
    const source = fixture("brackets-round")
      .replace(/\s*<graphic id="b2"[^>]*\/>/, "")
      .replace(/\s*<bracketedgroup\b[\s\S]*?<\/bracketedgroup>/, "");
    const imported = openChemDraftPayload(source);
    const objects = imported.document!.pages[0].objects;
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ type: "bracket", bracketKind: "round", side: "open", containedObjectIds: [] });
    const bracket = objects[0] as BracketObject;
    expect(bracket.pairId).toBeUndefined();
    expect(bracket.repeatUnit).toBeUndefined();
    expect(bracket.label).toBeUndefined();
    const exported = exportDocumentToCdxml(imported.document!);
    expect(exported.contents).toContain('GraphicType="Bracket"');
    expect(exported.contents).not.toContain("<bracketedgroup");
    expect(exported.warnings).toEqual([]);
  });

  it("normalizes a broken native pair on open with a warning naming the bracket", () => {
    const native = pair("round", "m");
    native.pages[0].objects = [native.pages[0].objects[1]];
    for (const source of [JSON.stringify(native), exportDocumentToCdxml(native).contents]) {
      const imported = openChemDraftPayload(source);
      const bracket = imported.document!.pages[0].objects[0] as BracketObject;
      expect(bracket.pairId).toBeUndefined();
      expect(bracket.repeatUnit).toBeUndefined();
      expect(bracket.label).toBeUndefined();
      expect(imported.warnings).toContainEqual({ code: "document.bracket_partner_missing", sourceObjectId: "b2",
        message: "Bracket b2 had no partner; repeat-unit mark removed." });
      const exported = exportDocumentToCdxml(imported.document!);
      expect(exported.contents).toContain('GraphicType="Bracket"');
      expect(exported.contents).not.toContain("<bracketedgroup");
      expect(exported.warnings).toEqual([]);
    }
  });

  it("imports a foreign SRU with a missing partner as a plain glyph and names the bracket", () => {
    const source = fixture("brackets-sru").replace(/\s*<graphic id="b2"[^>]*\/>/, "");
    const imported = openChemDraftPayload(source);
    const bracket = imported.document!.pages[0].objects.find((object): object is BracketObject => object.type === "bracket")!;
    expect(bracket.pairId).toBeUndefined();
    expect(bracket.repeatUnit).toBeUndefined();
    expect(bracket.label).toBeUndefined();
    expect(imported.warnings).toContainEqual({ code: "document.bracket_partner_missing", sourceObjectId: bracket.id,
      message: "Bracket b1 had no partner; repeat-unit mark removed." });
    expect(imported.document!.pages[0].objects.some(object => object.type === "unknown-compatibility-object")).toBe(true);
  });

  it.each([
    ["brackets-sru-crossing", "sru"],
    ["brackets-unsupported-usage", "unknown"],
    ["brackets-unresolved-membership", "sru"]
  ])("keeps foreign group semantics in native pairs for %s", (name, usage) => {
    const imported = openChemDraftPayload(fixture(name));
    const objects = imported.document!.pages[0].objects;
    const brackets = objects.filter((object): object is BracketObject => object.type === "bracket");
    expect(brackets).toHaveLength(2);
    expect(brackets.every(object => object.pairId && object.bracketUsage === usage)).toBe(true);
    expect(objects.some(object => object.type === "unknown-compatibility-object")).toBe(false);
    if (usage === "unknown") expect(imported.warnings.map(warning => warning.code)).toContain("cdxml.bracket_usage_unknown");
    if (name.endsWith("membership")) expect(imported.warnings.map(warning => warning.code)).toContain("cdxml.bracket_atom_membership_preserved");
    const exported = exportDocumentToCdxml(imported.document!);
    expect(exported.contents).toContain("<bracketedgroup");
    const reopened = openChemDraftPayload(visibleOnly(exported.contents)).document!;
    expect(reopened.pages[0].objects.filter(object => object.type === "bracket").every(object => object.pairId && object.bracketUsage === usage)).toBe(true);
  });

  it("converts a fully representable foreign SRU group and remaps its whole-molecule membership", () => {
    const imported = openChemDraftPayload(fixture("brackets-sru"));
    const objects = imported.document!.pages[0].objects;
    const molecule = objects.find(object => object.type === "molecule")!;
    const brackets = objects.filter((object): object is BracketObject => object.type === "bracket");
    expect(brackets).toHaveLength(2);
    expect(brackets[0].pairId).toBe(brackets[1].pairId);
    expect(brackets[0].pairId).toBeDefined();
    expect(brackets.every(object => object.repeatUnit && object.containedObjectIds.length === 1 && object.containedObjectIds[0] === molecule.id)).toBe(true);
    expect(objects.some(object => object.type === "unknown-compatibility-object")).toBe(false);
    const exported = exportDocumentToCdxml(imported.document!);
    expect(exported.contents.match(/<bracketedgroup\b/g)).toHaveLength(1);
    expect(exported.contents).toContain('BracketUsage="SRU"');
    const visible = openChemDraftPayload(visibleOnly(exported.contents)).document!;
    const visibleMolecule = visible.pages[0].objects.find(object => object.type === "molecule")!;
    expect(visible.pages[0].objects.filter((object): object is BracketObject => object.type === "bracket")
      .every(object => object.containedObjectIds[0] === visibleMolecule.id)).toBe(true);
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
    const native = openChemDraftPayload(paired);
    expect(native.warnings.map(warning => warning.code)).toContain("cdxml.bracket_atom_membership_preserved");
    expect(native.document!.pages[0].objects.find(object => object.type === "bracket" && object.crossingBondIds?.length)).toBeDefined();
    const unsupported = pair("round");
    unsupported.pages[0].objects[0].rotation = 30;
    expect(exportDocumentToCdxml(unsupported).warnings.map(warning => warning.code)).toContain("cdxml.bracket_payload_only");
  });
});
