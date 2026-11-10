import { describe, expect, it } from "vitest";
import { type BracketObject, type ChemDraftDocument } from "@chemdraft/chem-core";
import { CDX_NATIVE_ENVELOPE_ATTRIBUTE, cdxElementToCdxml, readCdx, type CdxElement } from "./cdxBinary";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "./index";

const cases = [
  { usage: "SRU", nativeUsage: "sru", attributes: 'BracketUsage="SRU" RepeatCount="7" SRULabel="n" PolymerRepeatPattern="HeadToTail"', count: 7, label: "n" },
  { usage: "MultipleGroup", nativeUsage: "multiple", attributes: 'BracketUsage="MultipleGroup" RepeatCount="3"', count: 3, label: undefined },
  { usage: "generic", nativeUsage: "generic", attributes: "", count: undefined, label: undefined }
] as const;

// Original synthetic C2 repeat fragment with an R end on each crossing bond. Symbolic source IDs
// exercise CDXML -> CDX ID allocation; numeric-only fixtures do not expose stale scalar references.
function source(attributes: string, symbolicIds: boolean): string {
  const id = (value: number) => symbolicIds ? `source_${value}` : String(value);
  return `<CDXML><page id="${id(1)}" BoundingBox="0 0 612 792">
    <fragment id="${id(10)}">
      <n id="${id(11)}" NodeType="GenericNickname" GenericNickname="R" p="40 100"/>
      <n id="${id(12)}" Element="6" p="80 100"/>
      <n id="${id(13)}" Element="6" p="110 100"/>
      <n id="${id(14)}" NodeType="GenericNickname" GenericNickname="R" p="150 100"/>
      <b id="${id(15)}" B="${id(11)}" E="${id(12)}" Order="1"/>
      <b id="${id(16)}" B="${id(12)}" E="${id(13)}" Order="1"/>
      <b id="${id(17)}" B="${id(13)}" E="${id(14)}" Order="1"/>
    </fragment>
    <graphic id="${id(20)}" GraphicType="Bracket" BracketType="Square" BoundingBox="60 80 66 120"/>
    <graphic id="${id(21)}" GraphicType="Bracket" BracketType="Square" BoundingBox="124 80 130 120"/>
    <bracketedgroup id="${id(30)}" BracketedObjectIDs="${id(10)}" ${attributes}>
      <bracketattachment id="${id(31)}" GraphicID="${id(20)}">
        <crossingbond id="${id(32)}" BondID="${id(15)}" InnerAtomID="${id(12)}"/>
      </bracketattachment>
      <bracketattachment id="${id(33)}" GraphicID="${id(21)}">
        <crossingbond id="${id(34)}" BondID="${id(17)}" InnerAtomID="${id(13)}"/>
      </bracketattachment>
    </bracketedgroup>
  </page></CDXML>`;
}

function elements(root: CdxElement, name: string): CdxElement[] {
  return [...(root.name === name ? [root] : []), ...root.kids.flatMap(child => elements(child, name))];
}

function bracketState(document: ChemDraftDocument) {
  const page = document.pages[0];
  const molecules = page.objects.filter(object => object.type === "molecule");
  const brackets = page.objects.filter((object): object is BracketObject => object.type === "bracket");
  expect(brackets).toHaveLength(2);
  expect(brackets[0].pairId).toBeTruthy();
  expect(brackets[1].pairId).toBe(brackets[0].pairId);
  expect(page.objects.some(object => object.type === "unknown-compatibility-object")).toBe(false);
  return brackets.map(bracket => ({
    type: bracket.type, kind: bracket.bracketKind, side: bracket.side, usage: bracket.bracketUsage,
    repeatUnit: bracket.repeatUnit, count: bracket.repeatCount, label: bracket.label,
    members: bracket.containedObjectIds.map(id => molecules.findIndex(molecule => molecule.id === id)),
    crossings: (bracket.crossingBondIds ?? []).map(ref => {
      const moleculeIndex = molecules.findIndex(molecule => molecule.id === ref.objectId);
      expect(moleculeIndex).toBeGreaterThanOrEqual(0);
      const bondIndex = molecules[moleculeIndex].bonds.findIndex(bond => bond.id === ref.bondId);
      expect(bondIndex).toBeGreaterThanOrEqual(0);
      return [moleculeIndex, bondIndex];
    })
  }));
}

describe.each([false, true])("binary bracket interchange (symbolic IDs=%s)", symbolicIds => {
  describe.each([false, true])("native payload=%s", embedNativePayload => {
    it.each([1_000_000_000, Number.MAX_SAFE_INTEGER])("preserves a MultipleGroup repeat count of %s", count => {
      const original = openChemDraftPayload(source(`BracketUsage="MultipleGroup" RepeatCount="${count}"`, symbolicIds)).document!;
      const expected = bracketState(original);
      expect(expected.map(bracket => bracket.count)).toEqual([count, count]);
      const exported = exportDocumentToCdx(original, { embedNativePayload });
      expect(exported.warnings.filter(warning => warning.code === "cdx.unencodable_data")).toEqual([]);
      const decoded = readCdx(exported.bytes);
      expect(elements(decoded, "bracketedgroup")[0].attrs.RepeatCount).toBe(String(count));
      expect(bracketState(importCdx(exported.bytes).document!)).toEqual(expected);
      delete decoded.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE];
      expect(bracketState(openChemDraftPayload(cdxElementToCdxml(decoded)).document!)).toEqual(expected);
    });

    it.each(cases)("round-trips $usage as faithfully as CDXML", ({ attributes, nativeUsage, count, label }) => {
      const original = openChemDraftPayload(source(attributes, symbolicIds)).document!;
      expect(original).toBeDefined();
      const expected = bracketState(openChemDraftPayload(exportDocumentToCdxml(original, { embedNativePayload: false }).contents).document!);
      expect(expected).toEqual([
        { type: "bracket", kind: "square", side: "open", usage: nativeUsage, repeatUnit: nativeUsage === "sru" ? true : undefined,
          count, label: undefined, members: [0], crossings: [[0, 0]] },
        { type: "bracket", kind: "square", side: "close", usage: nativeUsage, repeatUnit: nativeUsage === "sru" ? true : undefined,
          count, label, members: [0], crossings: [[0, 2]] }
      ]);

      const exported = exportDocumentToCdx(original, { embedNativePayload });
      expect(exported.warnings.filter(warning => warning.code === "cdx.unencodable_data")).toEqual([]);
      const decoded = readCdx(exported.bytes);
      expect(decoded.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] !== undefined).toBe(embedNativePayload);
      const group = elements(decoded, "bracketedgroup")[0];
      expect(group).toBeDefined();
      expect(elements(decoded, "graphic")).toHaveLength(2);
      expect(group.attrs.BracketUsage).toBe(nativeUsage === "sru" ? "SRU" : nativeUsage === "multiple" ? "MultipleGroup" : undefined);
      expect(group.attrs.RepeatCount).toBe(count === undefined ? undefined : String(count));
      expect(group.attrs.SRULabel).toBe(label);
      expect(group.attrs.PolymerRepeatPattern).toBe(nativeUsage === "sru" ? "HeadToTail" : undefined);
      expect(group.attrs.BracketedObjectIDs).toBe(elements(decoded, "fragment")[0].attrs.id);
      const graphics = elements(decoded, "graphic");
      const bonds = elements(decoded, "b");
      const atoms = elements(decoded, "n");
      const attachments = elements(group, "bracketattachment");
      expect(attachments).toHaveLength(2);
      expect(attachments.map(attachment => attachment.attrs.GraphicID)).toEqual(graphics.map(graphic => graphic.attrs.id));
      expect(elements(group, "crossingbond").map(crossing => [crossing.attrs.BondID, crossing.attrs.InnerAtomID]))
        .toEqual([[bonds[0].attrs.id, atoms[1].attrs.id], [bonds[2].attrs.id, atoms[2].attrs.id]]);

      const reopened = importCdx(exported.bytes);
      expect(reopened.conflict).toBeUndefined();
      expect(reopened.source).toBe(embedNativePayload ? "native-payload" : "external-cdxml");
      expect(reopened.warnings.some(warning => warning.code === "cdxml.bracket_group_preserved")).toBe(false);
      expect(bracketState(reopened.document!)).toEqual(expected);
      // Check the actual visible layer even when Save As can restore from the embedded payload.
      delete decoded.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE];
      const visible = openChemDraftPayload(cdxElementToCdxml(decoded));
      expect(bracketState(visible.document!)).toEqual(expected);
    });
  });
});
