import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { createEmptyDocument, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { cdxElementFromOrderedTree, writeCdx } from "./cdxBinary";
import { exportDocumentToCdxml, exportDocumentToCdx, importCdx, openChemDraftPayload } from "./index";

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, trimValues: false });
const binaryFromXml = (xml: string) => writeCdx(cdxElementFromOrderedTree(parser.parse(xml)));
const page = (contents: string) => `<CDXML><page id="1">${contents}</page></CDXML>`;
const fragment = (contents: string) => `<fragment id="2"><n id="3" p="30 30" Element="7"><t id="4"><s>N</s></t></n>${contents}</fragment>`;

function requireDocument(opened: ReturnType<typeof openChemDraftPayload>): ChemDraftDocument {
  expect(opened.document, JSON.stringify(opened.warnings)).toBeDefined();
  return opened.document!;
}

function graph(molecule: MoleculeObject) {
  return {
    atoms: molecule.atoms?.map(({ element, x, y, formalCharge, isotope, markRadicals }) => ({ element, x, y, formalCharge, isotope, markRadicals })),
    bonds: molecule.bonds?.map(({ fromAtomId, toAtomId, order, stereo }) => ({
      from: molecule.atoms?.findIndex(atom => atom.id === fromAtomId),
      to: molecule.atoms?.findIndex(atom => atom.id === toAtomId),
      order,
      stereo
    }))
  };
}

describe.each(["CDXML", "CDX"] as const)("C1 visible %s regressions", format => {
  const open = (xml: string) => format === "CDX" ? importCdx(binaryFromXml(xml)) : openChemDraftPayload(xml);
  const roundTrip = (document: ChemDraftDocument) => format === "CDX"
    ? importCdx(exportDocumentToCdx(document, { embedNativePayload: false }).bytes)
    : openChemDraftPayload(exportDocumentToCdxml(document, { embedNativePayload: false }).contents);

  it("keeps an unannotated native R1 label, unknown semantics and graph through visible round trips", () => {
    const molecule: MoleculeObject = {
      id: "molecule", type: "molecule", x: 40, y: 40, width: 40, height: 1, rotation: 0, style: {},
      structure: "", structureFormat: "unknown", superatoms: [], rGroups: [],
      atoms: [{ id: "r", element: "R1", x: 40, y: 40, formalCharge: 0 }, { id: "c", element: "C", x: 80, y: 40, formalCharge: 0 }],
      bonds: [{ id: "bond", fromAtomId: "r", toAtomId: "c", order: "single" }]
    };
    let document = createEmptyDocument();
    document.pages[0].objects = [molecule];
    const expectedGraph = graph(molecule);
    for (let cycle = 0; cycle < 2; cycle++) {
      const opened = roundTrip(document);
      document = requireDocument(opened);
      const imported = document.pages[0].objects.find(object => object.type === "molecule")!;
      expect(graph(imported)).toEqual(expectedGraph);
      expect(imported.rGroups).toEqual([expect.objectContaining({ label: "R1", querySemantics: "unknown" })]);
      expect(imported.rGroups[0].attachmentPoints).toEqual([{ kind: "atom", objectId: imported.id, atomId: imported.atoms![0].id }]);
      expect(opened.warnings.filter(warning => /r.?group|query/i.test(warning.code))).toEqual([]);
      expect(document.pages[0].objects.filter(object => object.type === "text")).toEqual([]);
    }
  });

  it("imports a direct fragment caption and retains it without a native payload", () => {
    let document = requireDocument(open(page(fragment('<t id="10" p="30 60"><s>Fragment caption</s></t>'))));
    for (let cycle = 0; cycle < 2; cycle++) {
      const texts = document.pages[0].objects.filter(object => object.type === "text");
      expect(texts).toHaveLength(1);
      expect(texts[0]).toMatchObject({ text: "Fragment caption", x: 40, y: 80 });
      document = requireDocument(roundTrip(document));
    }
  });

  it("imports a fragment-local group with text and graphics exactly once and retains the group", () => {
    let document = requireDocument(open(page(fragment(`<group id="20">
      <t id="21" p="30 60"><s>Grouped caption</s></t>
      <t id="22" p="30 90"><s>Second caption</s></t>
      <graphic id="23" GraphicType="Oval" BoundingBox="60 60 80 80"/>
    </group>`))));
    for (let cycle = 0; cycle < 2; cycle++) {
      const objects = document.pages[0].objects;
      const texts = objects.filter(object => object.type === "text");
      expect(texts.map(text => text.text)).toEqual(["Grouped caption", "Second caption"]);
      const graphics = objects.filter(object => object.type === "graphic");
      expect(graphics).toHaveLength(1);
      const groups = objects.filter(object => object.type === "group");
      expect(groups).toHaveLength(1);
      expect(groups[0].childObjectIds).toEqual([...texts, ...graphics].map(object => object.id));
      document = requireDocument(roundTrip(document));
    }
  });

  it("keeps node-label text on its atom without importing standalone text", () => {
    const document = requireDocument(open(page(fragment(""))));
    expect(document.pages[0].objects).toHaveLength(1);
    expect(document.pages[0].objects[0]).toMatchObject({ type: "molecule", atoms: [expect.objectContaining({ element: "N" })] });
    expect(requireDocument(roundTrip(document)).pages[0].objects.filter(object => object.type === "text")).toEqual([]);
  });

  it("names the text and source graphic when a graphic caption cannot become native text", () => {
    const opened = open(page(fragment(`<graphic id="40" GraphicType="Oval" BoundingBox="30 60 80 90">
      <t id="41" p="30 60"><s>Graphic caption</s></t>
    </graphic>`)));
    const document = requireDocument(opened);
    expect(document.pages[0].objects.filter(object => object.type === "text")).toEqual([]);
    expect(opened.warnings).toContainEqual(expect.objectContaining({
      code: "cdxml.graphic_text_not_imported", sourceObjectId: "40",
      message: expect.stringMatching(new RegExp(`${format}.*text.*41.*graphic.*40`, "i"))
    }));
    expect(document.compatibility.warnings).toContainEqual(expect.objectContaining({
      code: "cdxml.graphic_text_not_imported", objectId: "40"
    }));
  });

  it("uses the source format in every empty-page refusal without changing warning codes", () => {
    const opened = open(page(""));
    expect(opened.document).toBeUndefined();
    expect(opened.warnings).toEqual([
      { code: "cdxml.external_import_not_implemented", message: `This ${format} file does not contain a ChemDraft payload and no supported visible objects were found.` },
      { code: "cdxml.no_supported_visible_objects", message: `No supported visible ${format} objects were found.` }
    ]);
  });

  it("uses the source format for missing-page diagnostics", () => {
    const opened = open("<CDXML/>");
    expect(opened.document).toBeUndefined();
    expect(opened.warnings).toContainEqual({ code: "cdxml.no_pages", message: `The ${format} file contains no page elements.` });
  });

  it("preserves quoted source values while labelling shared-path diagnostics", () => {
    const opened = openChemDraftPayload(page(fragment('<n id="5" p="60 30"/><b id="6" B="3" E="5" Order="CDXML"/>')), format);
    requireDocument(opened);
    expect(opened.warnings).toContainEqual(expect.objectContaining({
      code: "cdxml.bond_order_import_unsupported",
      message: `Unsupported ${format} bond order "CDXML" was imported as unknown; the original order value is preserved for ${format} export.`
    }));
  });

  it("uses the source format for subset diagnostics and native compatibility messages", () => {
    const opened = open(page(fragment("") + '<unsupported id="50"/>'));
    const document = requireDocument(opened);
    expect(document.title).toBe(`Imported ${format}.chemdraft`);
    expect(opened.warnings).toContainEqual(expect.objectContaining({
      code: "cdxml.external_subset_imported", message: expect.stringContaining(`external ${format} subset`)
    }));
    const messages = [
      ...opened.warnings.map(warning => warning.message),
      ...document.compatibility.warnings.map(warning => warning.message),
      ...document.pages[0].objects.flatMap(object => [
        ...(object.compatibility?.warnings.map(warning => warning.message) ?? []),
        ...(object.type === "unknown-compatibility-object" ? [object.warning] : [])
      ])
    ];
    expect(messages.every(message => message.includes(format))).toBe(true);
    if (format === "CDX") expect(messages.some(message => message.includes("CDXML"))).toBe(false);
  });
});
