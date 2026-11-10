import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPatch, createEmptyDocument, serializeDocument, type BracketObject } from "@chemdraft/chem-core";
import { ChemDraftDocumentSchema as Released111DocumentSchema } from "../../chem-core/src/__fixtures__/v1.1.1/schemas";
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
  it.each(["CDXML", "CDX"])("snapshots member elements and all incident bonds without crossing attachments in %s", format => {
    const source = fixture("brackets-native-sru").replace('BracketedObjectIDs="10"', 'BracketedObjectIDs="11"')
      .replace(/<crossingbond[^>]*\/>/, "");
    const document = (format === "CDX" ? importCdx(binary(source)) : openChemDraftPayload(source)).document!;
    const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
    const [member, outside] = molecule.atoms;
    const [bond] = molecule.bonds;
    expect([member.cdxmlSourceId, outside.cdxmlSourceId, bond.cdxmlSourceId]).toEqual(["11", "12", "13"]);
    for (const bracket of document.pages[0].objects.filter(object => object.type === "bracket")) {
      expect(bracket.compatibility!.unknown.cdxmlBracketAtomSnapshots).toEqual([
        { sourceId: "11", atomId: member.id, element: "C", incidentBonds: [
          { id: bond.id, fromAtomId: member.id, toAtomId: outside.id, fromElement: "C", toElement: "O" }
        ] }
      ]);
      expect(bracket.crossingBondIds).toBeUndefined();
    }
  });

  it.each(["CDXML", "CDX"])("snapshots every atom and bond of a whole-molecule member in %s", format => {
    const source = fixture("brackets-native-sru").replace(/<crossingbond[^>]*\/>/, "")
      .replace("</fragment>", '<n id="14" Element="7" p="170 110"/></fragment>');
    const document = (format === "CDX" ? importCdx(binary(source)) : openChemDraftPayload(source)).document!;
    const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
    const [carbon, oxygen, isolated] = molecule.atoms;
    const [bond] = molecule.bonds;
    expect(molecule.atoms.map(atom => atom.cdxmlSourceId)).toEqual(["11", "12", "14"]);
    expect(bond.cdxmlSourceId).toBe("13");
    const incidentBonds = [{ id: bond.id, fromAtomId: carbon.id, toAtomId: oxygen.id, fromElement: "C", toElement: "O" }];
    for (const bracket of document.pages[0].objects.filter(object => object.type === "bracket")) {
      expect(bracket.compatibility!.unknown.cdxmlBracketAtomSnapshots).toEqual([
        { sourceId: "10", atomId: carbon.id, element: "C", incidentBonds },
        { sourceId: "10", atomId: oxygen.id, element: "O", incidentBonds },
        { sourceId: "10", atomId: isolated.id, element: "N", incidentBonds: [] }
      ]);
    }
  });

  it("keeps surviving atom members after membership edits and names each dropped source id", () => {
    const document = openChemDraftPayload(fixture("brackets-native-sru")
      .replace('BracketedObjectIDs="10"', 'BracketedObjectIDs="11 12 missing"')).document!;
    const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
    for (const object of document.pages[0].objects) if (object.type === "bracket") object.containedObjectIds = [molecule.id];
    // Imported native atom ids are local; remove the atom recorded for source id 12.
    const atomIds = molecule.compatibility!.unknown.cdxmlAtomIdsByAtomId as Record<string, string>;
    molecule.atoms = molecule.atoms.filter(atom => atomIds[atom.id] !== "12");
    molecule.bonds = [];
    const exported = exportDocumentToCdxml(document);
    expect(exported.contents).toContain('BracketedObjectIDs="11 10"');
    expect(exported.warnings.filter(warning => warning.code === "cdxml.bracket_member_dropped").map(warning => warning.message))
      .toEqual([expect.stringContaining('"12"'), expect.stringContaining('"missing"')]);
  });

  it("retains source object members that still export after native molecule membership changes", () => {
    const source = fixture("brackets-native-sru").replace('BracketedObjectIDs="10"', 'BracketedObjectIDs="10 50"')
      .replace("</page>", '<graphic id="50" GraphicType="Rectangle" BoundingBox="0 0 10 10"/></page>');
    const document = openChemDraftPayload(source).document!;
    for (const object of document.pages[0].objects) if (object.type === "bracket") object.containedObjectIds = [];
    const result = exportDocumentToCdxml(document, { embedNativePayload: false });
    expect(result.contents).toContain('BracketedObjectIDs="50"');
    expect(result.warnings.filter(warning => warning.code === "cdxml.bracket_member_dropped")).toEqual([
      expect.objectContaining({ message: expect.stringContaining('"10"') })
    ]);
  });

  it("keeps unresolved crossings across label and membership edits and warns on deleted resolved crossings", () => {
    const document = openChemDraftPayload(fixture("brackets-native-sru").replace('BondID="13"', 'BondID="999"')).document!;
    const molecule = document.pages[0].objects.find(object => object.type === "molecule")!;
    for (const object of document.pages[0].objects) if (object.type === "bracket") {
      object.containedObjectIds = [];
      if (object.side === "close") object.label = "new-label";
    }
    const exported = exportDocumentToCdxml(document);
    expect(exported.contents).toContain('SRULabel="new-label"');
    expect(exported.contents).toContain('BondID="999"');
    expect(exported.contents).toContain('InnerAtomID="11"');
    expect(exported.warnings.some(warning => warning.code === "cdxml.bracket_crossing_dropped")).toBe(false);
    const close = document.pages[0].objects.find(object => object.type === "bracket" && object.side === "close")!;
    const orphan = exportDocumentToCdxml(applyPatch(document, { op: "removeObject", objectId: close.id }), { embedNativePayload: false });
    expect(orphan.contents).not.toContain("<crossingbond");
    expect(orphan.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.bracket_crossing_dropped", message: expect.stringContaining('"999"') }));
    const resolved = openChemDraftPayload(fixture("brackets-native-sru")).document!;
    const resolvedMolecule = resolved.pages[0].objects.find(object => object.type === "molecule")!;
    const deleted = applyPatch(resolved, { op: "updateObject", objectId: resolvedMolecule.id, changes: { bonds: [] } });
    const deletion = exportDocumentToCdxml(deleted);
    expect(deletion.contents).not.toContain("<crossingbond");
    expect(deletion.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.bracket_crossing_dropped", message: expect.stringContaining('"13"') }));
    expect(molecule.bonds).toHaveLength(1);
  });

  it.each(["sru", "multiple"] as const)("writes %s semantics and crossings when one half needs geometry approximation", usage => {
    const document = openChemDraftPayload(fixture(`brackets-native-${usage}`)).document!;
    document.pages[0].objects.find(object => object.type === "bracket")!.rotation = 30;
    for (const result of [exportDocumentToCdxml(document, { embedNativePayload: false }), exportDocumentToCdx(document)]) {
      const xml = "contents" in result ? result.contents : cdxElementToCdxml(readCdx(result.bytes));
      expect(xml).toContain("<bracketedgroup");
      expect(xml).toContain(`BracketUsage="${usage === "sru" ? "SRU" : "MultipleGroup"}"`);
      expect(xml).toContain(`RepeatCount="${usage === "sru" ? "7" : "3"}"`);
      expect(xml).toContain('BracketedObjectIDs="10"');
      expect(xml).toContain('BondID="13"');
      if (usage === "sru") expect(xml).toContain('SRULabel="x-y"');
      expect(result.warnings.map(warning => warning.code)).toContain("cdxml.bracket_geometry_approximated");
      expect(result.warnings.map(warning => warning.code)).not.toContain("cdxml.bracket_payload_only");
      const reopened = openChemDraftPayload(xml).document!;
      expect(reopened.pages[0].objects.filter(object => object.type === "bracket").every(object => object.bracketUsage === usage)).toBe(true);
    }
  });

  it.each([false, true])("makes payload-only membership warnings truthful (embed: %s)", embedNativePayload => {
    const document = pair("round", "n");
    for (const object of document.pages[0].objects) if (object.type === "bracket") object.containedObjectIds = ["missing"];
    for (const exported of [exportDocumentToCdxml(document, { embedNativePayload }), exportDocumentToCdx(document, { embedNativePayload })]) {
      const warning = exported.warnings.find(warning => warning.code === "cdxml.bracket_membership_payload_only")!;
      expect(warning).toBeDefined();
      expect(warning.message).toContain(embedNativePayload ? "preserved only in the ChemDraft payload" : "NOT written");
      if (!embedNativePayload) expect(warning.message).not.toMatch(/preserved|reopens it exactly/);
    }
  });

  it.each(["", "9007199254740993", "9007199254740992", "0", "-1", "1.5", "1.00000000000000001", "NaN"])("preserves invalid RepeatCount %s verbatim without interpreting it", text => {
    const imported = openChemDraftPayload(fixture("brackets-native-sru").replace('RepeatCount="7"', `RepeatCount="${text}"`));
    const document = imported.document!;
    const brackets = document.pages[0].objects.filter((object): object is BracketObject => object.type === "bracket");
    expect(brackets.every(object => object.bracketUsage === "unknown" && object.repeatCount === undefined && !object.repeatUnit)).toBe(true);
    expect(imported.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.bracket_repeat_count_preserved", message: expect.stringContaining(`"${text}"`) }));
    for (const embedNativePayload of [false, true]) {
      const unedited = exportDocumentToCdxml(document, { embedNativePayload }).contents;
      expect(unedited).toContain(`RepeatCount="${text}"`);
      expect(unedited).toContain('SRULabel="x-y"');
      expect(() => exportDocumentToCdx(document, { embedNativePayload })).toThrow(`RepeatCount "${text}"`);
    }
    brackets[1].label = "unrelated-edit";
    const xml = exportDocumentToCdxml(document, { embedNativePayload: false }).contents;
    expect(xml).toContain(`RepeatCount="${text}"`);
    expect(xml).toContain('SRULabel="x-y"');
    expect(JSON.stringify(brackets[0].compatibility!.unknown.bracketedGroup)).toContain(text);
    for (const embedNativePayload of [false, true]) expect(() => exportDocumentToCdx(document, { embedNativePayload })).toThrow(`RepeatCount "${text}"`);
  });

  it.each(["", "NaN"])("warns when a semantic edit replaces invalid RepeatCount %s", text => {
    const document = openChemDraftPayload(fixture("brackets-native-sru").replace('RepeatCount="7"', `RepeatCount="${text}"`)).document!;
    const closing = document.pages[0].objects.find((object): object is BracketObject => object.type === "bracket" && object.side === "close")!;
    const edited = applyPatch(document, { op: "updateObject", objectId: closing.id, changes: { repeatCount: 4 } });
    for (const embedNativePayload of [false, true]) {
      const exported = exportDocumentToCdxml(edited, { embedNativePayload });
      expect(exported.contents).toContain('RepeatCount="4"');
      expect(exported.contents).not.toContain(`RepeatCount="${text}"`);
      expect(exported.warnings).toContainEqual({ code: "cdxml.bracket_repeat_count_dropped", sourceObjectId: closing.id,
        message: `Bracket RepeatCount "${text}" is NOT written because a native repeat count of 4 replaces it.` });
    }
  });

  it("uses recorded native members and inner atoms when fragments share source ids", () => {
    const source = fixture("brackets-native-sru").replace('BracketedObjectIDs="10"', 'BracketedObjectIDs="10 11"')
      .replace("</page>", '<fragment id="10"><n id="11" Element="7" p="250 110"/><n id="22" Element="6" p="280 110"/><b id="23" B="11" E="22" Order="1"/></fragment></page>');
    const document = openChemDraftPayload(source).document!;
    const first = document.pages[0].objects.find(object => object.type === "molecule")!;
    const exported = exportDocumentToCdxml(document, { embedNativePayload: false });
    const xml = exported.contents;
    const [firstFragment, secondFragment] = [...xml.matchAll(/<fragment id="([^"]+)"[^>]*>([\s\S]*?)<\/fragment>/g)];
    const firstAtom = /<n id="([^"]+)"/.exec(firstFragment[2])![1];
    const secondAtom = /<n id="([^"]+)"/.exec(secondFragment[2])![1];
    expect(firstAtom).not.toBe(secondAtom);
    expect(xml).toContain(`BracketedObjectIDs="${firstFragment[1]} ${firstAtom}"`);
    expect(xml).toContain(`InnerAtomID="${firstAtom}"`);
    const reopened = openChemDraftPayload(xml).document!;
    const member = reopened.pages[0].objects.find(object => object.type === "bracket") as BracketObject;
    const molecule = reopened.pages[0].objects.find(object => object.id === member.containedObjectIds[0])!;
    expect(molecule.type === "molecule" && molecule.atoms.map(atom => atom.element)).toEqual(first.atoms.map(atom => atom.element));
  });

  it.each(["vertical", "bounding-box", "identical"])("decides %s sides independently of attachment order", mode => {
    const source = fixture("brackets-native-sru")
      .replace('BoundingBox="87 138 75 90"', 'BoundingBox="75 90 87 138"')
      .replace('BoundingBox="183 90 195 138"', mode === "vertical" ? 'BoundingBox="75 150 87 198"' : mode === "bounding-box" ? 'BoundingBox="76 90 86 138"' : 'BoundingBox="75 90 87 138"');
    const reversed = source.replace(/(<bracketattachment id="31"[\s\S]*?<\/bracketattachment>)\s*(<bracketattachment id="33"[^>]*\/>)/, "$2$1");
    const results = [source, reversed].map(xml => openChemDraftPayload(xml));
    const sides = results.map(result => result.document!.pages[0].objects.filter((object): object is BracketObject => object.type === "bracket")
      .map(object => [object.compatibility!.originalId, object.side, object.label]));
    expect(sides[0]).toEqual(sides[1]);
    if (mode === "identical") {
      expect(sides[0]).toEqual([["20", undefined, undefined], ["21", undefined, undefined]]);
      for (const result of results) expect(result.warnings.map(warning => warning.code)).toContain("cdxml.bracket_sides_ambiguous");
    } else expect(sides[0]).toEqual([["20", "open", undefined], ["21", "close", "x-y"]]);
  });

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
      expect(openChemDraftPayload(exported.contents).document).toEqual({ ...native, formatVersion: "1.2.0", minAppVersion: "1.2.0" });
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
    expect(objects[0]).toMatchObject({ type: "bracket", bracketKind: "round", containedObjectIds: [] });
    expect(objects[0]).not.toHaveProperty("side");
    const bracket = objects[0] as BracketObject;
    expect(bracket.pairId).toBeUndefined();
    expect(bracket.repeatUnit).toBeUndefined();
    expect(bracket.label).toBeUndefined();
    const exported = exportDocumentToCdxml(imported.document!);
    // The glyph is baseline-compatible; its page's imported compatibility metadata is not.
    const expected = { ...imported.document!, formatVersion: "1.2.0", minAppVersion: "1.2.0" };
    expect(openChemDraftPayload(exported.contents).document).toEqual(expected);
    const saved = JSON.parse(serializeDocument(imported.document!));
    expect(saved).toEqual(expected);
    expect(Released111DocumentSchema.safeParse(imported.document).success).toBe(false);
    const baseline = structuredClone(imported.document!);
    delete baseline.pages[0].compatibility;
    expect(JSON.parse(serializeDocument(baseline))).toEqual(baseline);
    expect(Released111DocumentSchema.parse(baseline)).toEqual(baseline);
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
    expect(imported.warnings.find(warning => warning.code === "cdxml.bracket_group_preserved")).toMatchObject({
      sourceObjectId: "bg_crossing",
      message: "CDXML import: bracket group bg_crossing has 1 attachments or unsupported bracket references; bracket usage, repeat count, bracket members and crossing bonds are not imported as native group semantics (atom or object membership and crossing-bond attachments); the group is preserved as an unknown compatibility object and is not written to visible export."
    });
    const paired = fixture("crossing-bonds").replace('<bracketedgroup id="bg_crossing"', '<graphic id="g_other" BoundingBox="198 174 186 186" GraphicType="Bracket" BracketType="Round"/><bracketedgroup id="bg_crossing"')
      .replace('</bracketedgroup>', '<bracketattachment id="ba_other" GraphicID="g_other"/></bracketedgroup>');
    const native = openChemDraftPayload(paired);
    expect(native.warnings.map(warning => warning.code)).toContain("cdxml.bracket_atom_membership_preserved");
    expect(native.document!.pages[0].objects.find(object => object.type === "bracket" && object.crossingBondIds?.length)).toBeDefined();
    const unsupported = pair("round");
    unsupported.pages[0].objects[0].rotation = 30;
    expect(exportDocumentToCdxml(unsupported).warnings.map(warning => warning.code)).toContain("cdxml.bracket_geometry_approximated");
  });
});
