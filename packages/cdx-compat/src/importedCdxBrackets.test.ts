import { describe, expect, it } from "vitest";
import { applyPatch, type BracketObject, type ChemDraftDocument } from "@chemdraft/chem-core";
import { CDX_NATIVE_ENVELOPE_ATTRIBUTE, cdxElementToCdxml, readCdx, type CdxElement } from "./cdxBinary";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

// Entirely hand-written synthetic CDXML. Numeric IDs are a control; symbolic source IDs force
// binary object-header allocation and expose scalar bracket references that did not follow it.
// At 5993a603, cdxBinary.ts:144 omitted GraphicID/BondID/InnerAtomID from the reference set;
// their symbolic i32 values were omitted, so index.ts:3150 could no longer resolve the pair.
function reactionAndPolyethylene(symbolicIds: boolean): string {
  const id = (value: number) => symbolicIds ? `synthetic_${value}` : String(value);
  return `<CDXML><page id="${id(1)}" BoundingBox="0 0 612 792">
    <fragment id="${id(10)}">
      <n id="${id(11)}" Element="6" p="40 60"/>
      <n id="${id(12)}" Element="6" p="70 60"/>
      <b id="${id(13)}" B="${id(11)}" E="${id(12)}" Order="1"/>
    </fragment>
    <fragment id="${id(20)}">
      <n id="${id(21)}" Element="6" p="220 60"/>
      <n id="${id(22)}" Element="6" p="250 60"/>
      <b id="${id(23)}" B="${id(21)}" E="${id(22)}" Order="2"/>
    </fragment>
    <arrow id="${id(50)}" Tail3D="120 60 0" Head3D="180 60 0"
      ArrowheadHead="Full" ArrowheadType="Solid"/>
    <scheme id="${id(60)}"><step id="${id(61)}"
      ReactionStepReactants="${id(10)}" ReactionStepProducts="${id(20)}"
      ReactionStepArrows="${id(50)}"/></scheme>
    <fragment id="${id(100)}">
      <n id="${id(101)}" NodeType="GenericNickname" GenericNickname="R" p="40 180"/>
      <n id="${id(102)}" Element="6" p="80 180"/>
      <n id="${id(103)}" Element="6" p="110 180"/>
      <n id="${id(104)}" NodeType="GenericNickname" GenericNickname="R" p="150 180"/>
      <b id="${id(105)}" B="${id(101)}" E="${id(102)}" Order="1"/>
      <b id="${id(106)}" B="${id(102)}" E="${id(103)}" Order="1"/>
      <b id="${id(107)}" B="${id(103)}" E="${id(104)}" Order="1"/>
    </fragment>
    <graphic id="${id(110)}" GraphicType="Bracket" BracketType="Square" BoundingBox="66 200 60 160"/>
    <graphic id="${id(111)}" GraphicType="Bracket" BracketType="Square" BoundingBox="124 160 130 200"/>
    <bracketedgroup id="${id(200)}" BracketUsage="SRU" SRULabel="n"
      PolymerRepeatPattern="HeadToTail" BracketedObjectIDs="${id(100)}">
      <bracketattachment id="${id(201)}" GraphicID="${id(110)}">
        <crossingbond id="${id(202)}" BondID="${id(105)}" InnerAtomID="${id(102)}"/>
      </bracketattachment>
      <bracketattachment id="${id(203)}" GraphicID="${id(111)}">
        <crossingbond id="${id(204)}" BondID="${id(107)}" InnerAtomID="${id(103)}"/>
      </bracketattachment>
    </bracketedgroup>
  </page></CDXML>`;
}

function elements(root: CdxElement, name: string): CdxElement[] {
  return [...(root.name === name ? [root] : []), ...root.kids.flatMap(child => elements(child, name))];
}

function assertImportedSemantics(document: ChemDraftDocument, innerAtomY?: number) {
  const objects = document.pages[0].objects;
  const molecules = objects.filter(object => object.type === "molecule");
  expect(molecules).toHaveLength(3);
  const polymer = molecules[2];
  expect(polymer.atoms.map(atom => atom.element)).toEqual(["R", "C", "C", "R"]);
  expect(polymer.atoms.map(atom => atom.formalCharge)).toEqual([0, 0, 0, 0]);
  expect(polymer.bonds.map(bond => bond.order)).toEqual(["single", "single", "single"]);
  expect(polymer.bonds.map(bond => [polymer.atoms.findIndex(atom => atom.id === bond.fromAtomId),
    polymer.atoms.findIndex(atom => atom.id === bond.toAtomId)])).toEqual([[0, 1], [1, 2], [2, 3]]);
  if (innerAtomY !== undefined) expect(polymer.atoms[1].y).toBeCloseTo(innerAtomY, 4);

  const brackets = objects.filter((object): object is BracketObject => object.type === "bracket")
    .sort((a, b) => a.x - b.x);
  expect(brackets).toHaveLength(2);
  expect(brackets[0].pairId).toBeTruthy();
  expect(brackets[1].pairId).toBe(brackets[0].pairId);
  expect(brackets.map(bracket => [bracket.bracketKind, bracket.side, bracket.bracketUsage, bracket.repeatUnit, bracket.label]))
    .toEqual([["square", "open", "sru", true, undefined], ["square", "close", "sru", true, "n"]]);
  for (const [index, bracket] of brackets.entries()) {
    expect(bracket.containedObjectIds).toEqual([polymer.id]);
    expect(bracket.crossingBondIds).toEqual([{ objectId: polymer.id, bondId: polymer.bonds[index === 0 ? 0 : 2].id }]);
    // Repeat pattern has no native chemistry field: it must remain in preserved group data.
    expect(bracket.compatibility?.unknown.bracketedGroup).toMatchObject({
      attributes: { BracketUsage: "SRU", SRULabel: "n", PolymerRepeatPattern: "HeadToTail" }
    });
  }

  const reactions = objects.filter(object => object.type === "reaction");
  expect(reactions).toHaveLength(1);
  expect(reactions[0].components.map(component => [component.role, component.objectId]))
    .toEqual([["reactant", molecules[0].id], ["product", molecules[1].id]]);
  expect(reactions[0].arrowObjectIds).toHaveLength(1);
  expect(objects.some(object => object.id === reactions[0].arrowObjectIds![0])).toBe(true);
  expect(objects.some(object => object.type === "unknown-compatibility-object")).toBe(false);
  return { polymer, brackets };
}

function assertVisibleReferences(root: CdxElement) {
  const fragments = elements(root, "fragment");
  expect(fragments).toHaveLength(3);
  const polymer = fragments[2];
  const groups = elements(root, "bracketedgroup");
  expect(groups).toHaveLength(1);
  const group = groups[0];
  expect(group.attrs).toMatchObject({ BracketUsage: "SRU", SRULabel: "n",
    PolymerRepeatPattern: "HeadToTail", BracketedObjectIDs: polymer.attrs.id });
  const glyphs = elements(root, "graphic").filter(graphic => graphic.attrs.GraphicType === "Bracket");
  expect(glyphs.map(glyph => [glyph.attrs.BracketType, glyph.attrs.BoundingBox]))
    .toEqual([["Square", "66 200 60 160"], ["Square", "124 160 130 200"]]);
  const attachments = elements(group, "bracketattachment");
  expect(attachments).toHaveLength(2);
  // Keep going after broken scalar links, so the same test also diagnoses the reopened native pair.
  expect.soft(attachments.map(attachment => attachment.attrs.GraphicID)).toEqual(glyphs.map(glyph => glyph.attrs.id));
  const crossings = elements(group, "crossingbond");
  expect(crossings).toHaveLength(2);
  const bonds = elements(polymer, "b");
  const atoms = elements(polymer, "n");
  expect.soft(crossings.map(crossing => [crossing.attrs.BondID, crossing.attrs.InnerAtomID]))
    .toEqual([[bonds[0].attrs.id, atoms[1].attrs.id], [bonds[2].attrs.id, atoms[2].attrs.id]]);
  const steps = elements(root, "step");
  expect(steps).toHaveLength(1);
  expect(steps[0].attrs).toMatchObject({ ReactionStepReactants: fragments[0].attrs.id,
    ReactionStepProducts: fragments[1].attrs.id, ReactionStepArrows: elements(root, "arrow")[0].attrs.id });
}

describe.each([false, true])("imported reaction and polyethylene SRU (symbolic source IDs=%s)", symbolicIds => {
  describe.each([false, true])("native payload=%s", embedNativePayload => {
    it.each([false, true])("preserves group semantics and links after binary CDX reopen (atom edited=%s)", edited => {
      // Import afresh for every matrix case: neither the atom edit nor envelope removal is shared.
      const imported = openChemDraftPayload(reactionAndPolyethylene(symbolicIds));
      expect(imported.source).toBe("external-cdxml");
      expect(imported.document, JSON.stringify(imported.warnings)).toBeDefined();
      const original = imported.document!;
      const { polymer, brackets } = assertImportedSemantics(original);
      expect(polymer.id).not.toMatch(/^\d+$/);
      for (const bracket of brackets) {
        expect(bracket.compatibility?.unknown.cdxmlBracketMembership).toBe(JSON.stringify([polymer.id]));
      }
      const originalY = polymer.atoms[1].y;
      const expectedY = originalY + (edited ? 12 : 0);
      const document = edited ? applyPatch(original, {
        op: "updateObject", objectId: polymer.id,
        changes: { atoms: polymer.atoms.map((atom, index) => index === 1 ? { ...atom, y: expectedY } : atom) }
      }) : original;
      expect(polymer.atoms[1].y).toBe(originalY);
      assertImportedSemantics(document, expectedY);

      // Control the CDXML path before testing binary encoding; the edited coordinate must survive.
      const xml = exportDocumentToCdxml(document, { embedNativePayload: false });
      if (edited) expect(xml.contents).not.toBe(exportDocumentToCdxml(original, { embedNativePayload: false }).contents);
      const xmlReopened = openChemDraftPayload(xml.contents);
      expect(xmlReopened.document, JSON.stringify(xmlReopened.warnings)).toBeDefined();
      assertImportedSemantics(xmlReopened.document!, expectedY);

      const exported = exportDocumentToCdx(document, { embedNativePayload });
      expect.soft(exported.warnings.filter(warning => warning.code === "cdx.unencodable_data")).toEqual([]);
      const decoded = readCdx(exported.bytes);
      expect(decoded.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] !== undefined).toBe(embedNativePayload);
      assertVisibleReferences(decoded);

      const reopened = importCdx(exported.bytes);
      expect(reopened.conflict).toBeUndefined();
      expect(reopened.source).toBe(embedNativePayload ? "native-payload" : "external-cdxml");
      expect(reopened.document, JSON.stringify(reopened.warnings)).toBeDefined();
      expect.soft(reopened.warnings.filter(warning => warning.code === "cdxml.bracket_group_preserved"
        || warning.code === "cdxml.bracket_crossing_unresolved")).toEqual([]);
      assertImportedSemantics(reopened.document!, expectedY);

      // Embedded native JSON can mask a broken visible layer. Reopen that layer independently too.
      delete decoded.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE];
      const visible = openChemDraftPayload(cdxElementToCdxml(decoded));
      expect(visible.document, JSON.stringify(visible.warnings)).toBeDefined();
      expect.soft(visible.warnings.filter(warning => warning.code === "cdxml.bracket_group_preserved"
        || warning.code === "cdxml.bracket_crossing_unresolved")).toEqual([]);
      assertImportedSemantics(visible.document!, expectedY);
    });
  });
});
