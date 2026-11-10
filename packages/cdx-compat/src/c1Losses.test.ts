import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { cdxElementFromOrderedTree, readCdx, writeCdx, type CdxElement } from "./cdxBinary";
import { exportDocumentToCdxml, exportDocumentToCdx, importCdx, openChemDraftPayload } from "./index";

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, trimValues: false });
const tree = (xml: string) => cdxElementFromOrderedTree(parser.parse(xml));
const page = (content: string) => `<CDXML><page id="1">${content}</page></CDXML>`;
const all = (node: CdxElement, name: string): CdxElement[] => [
  ...(node.name === name ? [node] : []), ...node.kids.flatMap(child => all(child, name))
];
const molecule = '<fragment id="2"><n id="3" p="60 60" Element="6"/><n id="4" p="90 60" Element="8"/><b id="5" B="3" E="4" Order="1"/></fragment>';
const glyph = (id: number, kind = "Round", usage = "") => `<graphic id="${id}" GraphicType="Bracket" BracketType="${kind}" BoundingBox="${id * 5} 40 ${id * 5 + 8} 80" LipSize="60" Z="1" ${usage}/>`;
const attachment = (id: number, graphic: number) => `<bracketattachment id="${id}" GraphicID="${graphic}"><crossingbond id="${id + 1}" BondID="5" InnerAtomID="3"/></bracketattachment>`;

describe.each(["CDXML", "CDX"] as const)("C1 remaining losses in %s", format => {
  const open = (xml: string) => format === "CDX" ? importCdx(writeCdx(tree(xml))) : openChemDraftPayload(xml);
  const output = (document: ChemDraftDocument) => format === "CDX"
    ? readCdx(exportDocumentToCdx(document, { embedNativePayload: false }).bytes)
    : tree(exportDocumentToCdxml(document, { embedNativePayload: false }).contents);
  const roundTrip = (document: ChemDraftDocument) => format === "CDX"
    ? importCdx(exportDocumentToCdx(document, { embedNativePayload: false }).bytes)
    : openChemDraftPayload(exportDocumentToCdxml(document, { embedNativePayload: false }).contents);
  const exportWarnings = (document: ChemDraftDocument) => format === "CDX"
    ? exportDocumentToCdx(document, { embedNativePayload: false }).warnings
    : exportDocumentToCdxml(document, { embedNativePayload: false }).warnings;

  it("names a curly bracket whose glyph cannot be native", () => {
    const imported = open(page(molecule + glyph(10, "Curly", 'Warning="synthetic warning"') + glyph(11, "Square") + glyph(12)));
    expect(imported.document).toBeDefined();
    expect(imported.document!.pages[0].objects.filter(o => o.type === "bracket")).toHaveLength(2);
    expect(imported.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.bracket_type_preserved", sourceObjectId: "10",
      message: expect.stringMatching(/bracket 10.*Curly.*not imported as a native glyph/i) }));
    expect(exportWarnings(imported.document!)).toContainEqual(expect.objectContaining({ code: "cdxml.bracket_type_preserved", sourceObjectId: "10",
      message: expect.stringMatching(/bracket 10.*Curly.*NOT written/i) }));
    expect(all(output(imported.document!), "graphic").filter(n => n.attrs.GraphicType === "Bracket")).toHaveLength(2);
  });

  it("names the four-attachment group's missing native semantics", () => {
    const imported = open(page(molecule + [10, 11, 12, 13].map(id => glyph(id)).join("") +
      `<bracketedgroup id="20" BracketedObjectIDs="3 4" RepeatCount="3">${[10, 11, 12, 13].map((id, i) => attachment(30 + i * 2, id)).join("")}</bracketedgroup>`));
    expect(imported.document!.pages[0].objects.filter(o => o.type === "bracket")).toHaveLength(4);
    expect(imported.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.bracket_group_preserved", sourceObjectId: "20",
      message: expect.stringMatching(/group 20.*4 attachments.*repeat count.*crossing bonds.*not imported/i) }));
    expect(exportWarnings(imported.document!)).toContainEqual(expect.objectContaining({ code: "cdxml.bracket_group_preserved", sourceObjectId: "20",
      message: expect.stringMatching(/group 20.*repeat count.*crossing bonds.*NOT written/i) }));
    expect(all(output(imported.document!), "graphic").filter(n => n.attrs.GraphicType === "Bracket")).toHaveLength(4);
  });

  it("names each nested bracket group that lacks native semantics", () => {
    const imported = open(page(molecule + [10, 11, 12, 13, 14, 15].map(id => glyph(id, "Square", 'BracketUsage="MultipleGroup" Warning="synthetic"')).join("") +
      `<bracketedgroup id="20" BracketUsage="MultipleGroup" BracketedObjectIDs="3 4" RepeatCount="2">${attachment(30, 10)}${attachment(32, 11)}
        <bracketedgroup id="21" BracketUsage="MultipleGroup" BracketedObjectIDs="3" RepeatCount="3">${attachment(34, 12)}${attachment(36, 13)}
          <bracketedgroup id="22" BracketedObjectIDs="4">${attachment(38, 14)}${attachment(40, 15)}</bracketedgroup>
        </bracketedgroup></bracketedgroup>`));
    expect(imported.document).toBeDefined();
    for (const id of ["21", "22"]) expect(imported.warnings).toContainEqual(expect.objectContaining({
      code: "cdxml.bracket_nested_group_preserved", sourceObjectId: id,
      message: expect.stringMatching(new RegExp(`bracket group ${id}.*not imported.*repeat count.*crossing bonds`, "i"))
    }));
    // The outer pair exports its opaque hierarchy; reopening must still name both unsupported
    // native groups rather than silently treating those raw children as native pairs.
    const exported = output(imported.document!);
    expect(all(exported, "bracketedgroup")).toHaveLength(3);
    expect(all(exported, "crossingbond")).toHaveLength(6);
    for (const id of ["21", "22"]) expect(roundTrip(imported.document!).warnings).toContainEqual(expect.objectContaining({
      code: "cdxml.bracket_nested_group_preserved", sourceObjectId: id
    }));
  });

  it.each(["Dashed", "Bold"])("keeps a step's %s line arrow linked through visible export", lineType => {
    let document = open(page(molecule + `<graphic id="10" GraphicType="Line" ArrowType="FullHead" LineType="${lineType}" HeadSize="1000" Z="2" BoundingBox="120 60 180 60"/>
      <scheme id="20"><step id="21" ReactionStepReactants="2" ReactionStepProducts="2" ReactionStepArrows="10"/></scheme>`)).document!;
    for (let cycle = 0; cycle < 3; cycle++) {
      const objects = document.pages[0].objects;
      const reaction = objects.find(o => o.type === "reaction")!;
      expect(reaction.arrowObjectIds).toHaveLength(1);
      const arrow = objects.find(o => o.id === reaction.arrowObjectIds![0]);
      expect(arrow).toMatchObject({ type: "graphic", data: { artToolId: "reactionArrow", markerEnd: { kind: "filled-arrow" } } });
      const exported = output(document);
      const step = all(exported, "step")[0];
      const target = all(exported, "graphic").find(o => o.attrs.id === step.attrs.ReactionStepArrows)!;
      expect(target?.attrs).toMatchObject({ GraphicType: "Line", ArrowType: "FullHead", LineType: lineType });
      document = roundTrip(document).document!;
    }
  });

  it("warns specifically about alternative-group semantics and keeps its label and source expansion", () => {
    let imported = open(page(`<fragment id="2"><n id="3" NodeType="AnonymousAlternativeGroup" GenericNickname="Alt" AS="R" NeedsClean="yes" Z="1" p="60 60">
      <fragment id="4"><n id="5" Element="7" p="60 60"/></fragment><t id="6"><s>Alt</s></t></n></fragment>`));
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(imported.document).toBeDefined();
      expect(imported.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.abbreviation_not_expanded", sourceObjectId: cycle === 0 ? "3" : expect.any(String),
        message: expect.stringMatching(/abbreviation node \d+.*AnonymousAlternativeGroup.*alternative-group semantics/i) }));
      const native = imported.document!.pages[0].objects.find(o => o.type === "molecule")!;
      expect(native.superatoms).toHaveLength(0);
      expect(native.atoms).toMatchObject([{ element: "Alt", labelLiteral: true }]);
      expect(all(output(imported.document!), "n").find(n => n.attrs.NodeType === "AnonymousAlternativeGroup")).toMatchObject({
        attrs: { GenericNickname: "Alt", AS: "R", NeedsClean: "yes" }, kids: expect.arrayContaining([expect.objectContaining({ name: "fragment" }), expect.objectContaining({ name: "t" })])
      });
      imported = roundTrip(imported.document!);
    }
  });

  it.each([0, 1, -1])("preserves a text-only Unspecified label and charge %s without creating a superatom", charge => {
    let imported = open(page(`<fragment id="2"><n id="3" NodeType="Unspecified" AS="R" NeedsClean="yes" Warning="synthetic" Z="1" Charge="${charge}" p="60 60"><t id="4"><s>Qq</s></t></n></fragment>`));
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(imported.document).toBeDefined();
      const molecule = imported.document!.pages[0].objects.find(o => o.type === "molecule")!;
      expect(molecule.atoms).toMatchObject([{ element: "Qq", labelLiteral: true, formalCharge: charge }]);
      expect(molecule.superatoms).toHaveLength(0);
      const exported = all(output(imported.document!), "n")[0];
      expect(exported.attrs).toMatchObject({ NodeType: "Unspecified", Charge: String(charge), AS: "R", NeedsClean: "yes", Warning: "synthetic" });
      imported = roundTrip(imported.document!);
    }
  });

  it.each([[6, "C"], [8, "O"]] as const)("keeps an explicitly stated element %s chemical even with Unspecified node text", (number, symbol) => {
    let imported = open(page(`<fragment id="2"><n id="3" NodeType="Unspecified" Element="${number}" p="60 60"><t id="4"><s>${symbol}</s></t></n></fragment>`));
    for (let cycle = 0; cycle < 3; cycle++) {
      const molecule = imported.document!.pages[0].objects.find(o => o.type === "molecule")!;
      expect(molecule.atoms).toMatchObject([{ element: symbol, formalCharge: 0 }]);
      expect(molecule.atoms[0].labelLiteral).not.toBe(true);
      expect(molecule.superatoms).toHaveLength(0);
      expect(imported.warnings.some(warning => warning.code === "cdxml.abbreviation_not_expanded")).toBe(false);
      imported = roundTrip(imported.document!);
    }
  });
});
