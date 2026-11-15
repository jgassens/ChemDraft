import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import type { ChemDraftDocument, MoleculeAtom, MoleculeObject } from "@chemdraft/chem-core";
import { planNativeArtVisual } from "../../art-engine/src/index";
import { MAGIC, cdxElementFromOrderedTree, cdxElementToCdxml, readCdx, writeCdx, type CdxElement } from "./cdxBinary";
import { exportDocumentToCdxml, exportDocumentToCdx, importCdx, openChemDraftPayload } from "./index";

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false, trimValues: false });
const tree = (xml: string) => cdxElementFromOrderedTree(parser.parse(xml));
const page = (content: string) => `<CDXML><page id="1">${content}</page></CDXML>`;
const all = (node: CdxElement, name: string): CdxElement[] => [
  ...(node.name === name ? [node] : []), ...node.kids.flatMap(child => all(child, name))
];
const withoutIds = (node: CdxElement): CdxElement => ({
  ...node, attrs: Object.fromEntries(Object.entries(node.attrs).filter(([key]) => key !== "id")),
  kids: node.kids.map(withoutIds)
});
const molecule = '<fragment id="2"><n id="3" p="60 60" Element="6"/><n id="4" p="90 60" Element="8"/><b id="5" B="3" E="4" Order="1"/></fragment>';
const glyph = (id: number, kind = "Round", usage = "") => `<graphic id="${id}" GraphicType="Bracket" BracketType="${kind}" BoundingBox="${id * 5} 40 ${id * 5 + 8} 80" LipSize="60" Z="1" ${usage}/>`;
const attachment = (id: number, graphic: number) => `<bracketattachment id="${id}" GraphicID="${graphic}"><crossingbond id="${id + 1}" BondID="5" InnerAtomID="3"/></bracketattachment>`;

// Independent binary records: a CDXML writer cannot hide an enum/property decoding bug here.
const u16 = (value: number) => [value & 255, value >>> 8 & 255];
const u32 = (value: number) => [...u16(value), ...u16(value >>> 16)];
const coord = (value: number) => u32(value * 65536);
const property = (tag: number, bytes: number[]) => [...u16(tag), ...u16(bytes.length), ...bytes];
const record = (tag: number, id: number, ...children: number[][]) => [...u16(tag), ...u32(id), ...children.flat(), 0, 0];
const binaryPage = (...children: number[][]) => new Uint8Array([
  ...new TextEncoder().encode(MAGIC), 4, 3, 2, 1, ...Array(10).fill(0),
  ...record(0x8000, 0, record(0x8001, 1, ...children))
]);
const binaryPageStep = (heads: number[][], lineType?: number) => binaryPage(
  record(0x800e, 41, property(0x0c04, u32(30)), property(0x0c01, [2, 5].flatMap(u32)),
    property(0x0c02, [8, 11, 14, 17, 20].flatMap(u32))),
  ...[2, 5, 8, 11, 14, 17, 20].map((id, index) => record(0x8003, id,
    record(0x8004, id + 1, property(0x0402, u16(index % 2 ? 8 : 6)),
      property(0x0200, [60, 30 + index * 30].flatMap(coord))))),
  record(0x8007, 30, property(0x0a00, u16(1)), ...heads,
    ...(lineType === undefined ? [] : [property(0x0a01, u16(lineType))]),
    property(0x0204, [90, 100, 90, 160].flatMap(coord)),
    property(0x0a20, u16(1000)), property(0x000a, u16(2)))
);
const assertPageStep = (document: ChemDraftDocument, tool = "reactionArrow") => {
  const objects = document.pages[0].objects;
  const reaction = objects.find(object => object.type === "reaction")!;
  expect(reaction).toBeDefined();
  expect(reaction.components.map(component => component.role)).toEqual([
    "reactant", "reactant", "product", "product", "product", "product", "product"
  ]);
  expect(objects.filter(object => object.type === "molecule").map(object => object.atoms.map(atom => atom.element))).toEqual([
    ["C"], ["O"], ["C"], ["O"], ["C"], ["O"], ["C"]
  ]);
  expect(reaction.components.every(component => objects.some(object => object.id === component.objectId && object.type === "molecule"))).toBe(true);
  expect(new Set(reaction.components.map(component => component.objectId)).size).toBe(7);
  expect(reaction.arrowObjectIds).toHaveLength(1);
  const arrow = objects.find(object => object.id === reaction.arrowObjectIds![0]);
  expect(arrow).toMatchObject({ type: "graphic", graphicKind: "path", data: { artToolId: tool } });
  return arrow;
};

describe("independently authored binary CDX arrowed lines", () => {
  it("keeps a binary NoHead line unheaded through three visible CDX cycles", () => {
    let bytes: Uint8Array = binaryPage(record(0x8007, 30, property(0x0a00, u16(1)),
      property(0x0a02, u16(0)), property(0x0204, [90, 100, 90, 160].flatMap(coord))));
    expect(all(readCdx(bytes), "graphic")[0].attrs.ArrowType).toBe("NoHead");
    for (let cycle = 0; cycle <= 3; cycle++) {
      const imported = importCdx(bytes);
      expect(imported.document, JSON.stringify(imported.warnings)).toBeDefined();
      const objects = imported.document!.pages[0].objects;
      expect(objects).toHaveLength(1);
      expect(objects[0]).toMatchObject({ type: "graphic", graphicKind: "line" });
      if (objects[0].type !== "graphic") throw new Error("Expected a plain line");
      expect(objects[0].data.markerStart).toBeUndefined();
      expect(objects[0].data.markerEnd).toBeUndefined();
      expect(objects[0].data.artToolId).toBeUndefined();
      if (cycle < 3) {
        bytes = exportDocumentToCdx(imported.document!, { embedNativePayload: false }).bytes;
        expect(all(readCdx(bytes), "graphic")[0].attrs).toMatchObject({
          GraphicType: "Line", ArrowType: "NoHead", BoundingBox: "100 90 160 90"
        });
      }
    }
  });

  for (const [name, heads, tool, markers] of [
    ["ArrowType FullHead", [property(0x0a02, u16(2))], "reactionArrow", { markerEnd: { kind: "filled-arrow" } }],
    ["separate head", [property(0x0a2f, u16(1)), property(0x0a35, u16(2)), property(0x0a36, u16(1))], "reactionArrow", { markerEnd: { kind: "filled-arrow" } }],
    ["separate tail", [property(0x0a2f, u16(1)), property(0x0a35, u16(1)), property(0x0a36, u16(2))], "reactionArrow", { markerStart: { kind: "filled-arrow" } }],
    ["both ends", [property(0x0a35, u16(2)), property(0x0a36, u16(2))], "resonanceArrow", { markerStart: { kind: "filled-arrow" }, markerEnd: { kind: "filled-arrow" } }],
    ["NoHead with separate head", [property(0x0a02, u16(0)), property(0x0a35, u16(2))], "reactionArrow", { markerEnd: { kind: "filled-arrow" } }],
    ["half head", [property(0x0a35, u16(3))], "fishhookArrow", { markerEnd: { kind: "half-arrow" } }]
  ] as const) {
    it.each([undefined, 0, 1, 8, 9])(`${name} with LineType %s keeps its step target through three CDX cycles`, lineType => {
      let bytes: Uint8Array = binaryPageStep([...heads], lineType);
      const decoded = all(readCdx(bytes), "graphic")[0];
      expect(decoded.attrs).toMatchObject({ GraphicType: "Line", BoundingBox: "100 90 160 90" });
      if (name === "ArrowType FullHead") expect(decoded.attrs.ArrowType).toBe("FullHead");
      for (let cycle = 0; cycle <= 3; cycle++) {
        const imported = importCdx(bytes);
        expect(imported.document, JSON.stringify(imported.warnings)).toBeDefined();
        const arrow = assertPageStep(imported.document!, tool);
        expect(arrow).toMatchObject({ data: markers });
        if (lineType === 1) expect(arrow!.style.strokeDasharray).toBeTruthy();
        if (cycle === 0 && lineType !== undefined && lineType >= 8) {
          expect(imported.warnings).toContainEqual(expect.objectContaining({
            code: "cdxml.arrow_line_type_approximation", sourceObjectId: "30",
            message: expect.stringContaining(`arrow 30 has unmapped LineType="${lineType}"`)
          }));
        }
        expect(imported.warnings.filter(warning => ["cdxml.reaction_step_preserved", "cdxml.reaction_reference_unresolved"].includes(warning.code))).toEqual([]);
        if (cycle < 3) bytes = exportDocumentToCdx(imported.document!, { embedNativePayload: false }).bytes;
      }
    });
  }
});

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

  for (const placement of ["Unspecified label", "Nickname label", "expanded Nickname label", "page caption", "fragment caption"]) {
    it.each(["ABC", "ABCDE"])(`keeps mixed text/run order and run attributes on a ${placement} (%s) through three visible round trips`, expected => {
      const runAttributes = { font: "3", size: "12", face: "1", color: "4" };
      const content = 'A<s font="3" size="12" face="1" color="4">B</s>C' +
        (expected === "ABCDE" ? '<s face="2">D</s>E' : "");
      const caption = `<t id="4" p="60 60">${content}</t>`;
      const source = placement === "page caption" ? caption
        : placement === "fragment caption" ? `<fragment id="2"><n id="3" p="60 60" Element="6"/>${caption}</fragment>`
        : `<fragment id="2"><n id="3" NodeType="${placement === "Unspecified label" ? "Unspecified" : "Nickname"}" p="60 60">${caption}${
          placement === "expanded Nickname label" ? '<fragment id="5"><n id="6" Element="6" p="60 60"/></fragment>' : ""
        }</n></fragment>`;
      let imported = open(page(source));
      for (let cycle = 0; cycle <= 3; cycle++) {
        expect(imported.document, JSON.stringify(imported.warnings)).toBeDefined();
        const document = JSON.parse(JSON.stringify(imported.document)) as ChemDraftDocument;
        if (placement.endsWith("caption")) {
          expect(document.pages[0].objects.filter(object => object.type === "text").map(object => object.text)).toEqual([expected]);
        } else {
          const native = document.pages[0].objects.find(object => object.type === "molecule")!;
          expect(placement === "expanded Nickname label" ? native.superatoms[0].label : native.atoms[0].element).toBe(expected);
        }
        const exported = output(document);
        const texts = all(exported, "t");
        expect(texts).toHaveLength(1);
        // Read serialized XML independently in source order, including raw text between runs.
        const textContent = (nodes: Record<string, unknown>[]): string => nodes.map(node =>
          node["#text"] !== undefined ? String(node["#text"]) : Object.entries(node)
            .filter(([name, value]) => name !== ":@" && Array.isArray(value))
            .map(([, children]) => textContent(children as Record<string, unknown>[])).join("")
        ).join("");
        expect(textContent(parser.parse(cdxElementToCdxml(texts[0])))).toBe(expected);
        expect(all(texts[0], "s").find(run => run.text === "B")?.attrs).toEqual(runAttributes);
        if (expected === "ABCDE") expect(all(texts[0], "s").find(run => run.text === "D")?.attrs).toMatchObject({ face: "2" });
        if (cycle < 3) imported = roundTrip(document);
      }
    });
  }

  it("restores mixed content from an older ordered snapshot instead of its flattened codec tree", () => {
    const label = '<t id="4">A<s face="1">B</s>C</t>';
    const imported = open(page(`<fragment id="2"><n id="3" NodeType="Unspecified" p="60 60">${label}</n></fragment>`));
    const native = imported.document!.pages[0].objects.find(object => object.type === "molecule")!;
    const record = (native.compatibility!.unknown.cdxmlAbbreviations as { source: CdxElement; sourceNode?: unknown }[])[0];
    expect(record.sourceNode).toBeUndefined();
    // Simulate an older native save: its sourceNode is ordered, while source.text is flattened.
    record.sourceNode = { name: "n", attributes: { ...record.source.attrs }, children: parser.parse(label) };
    const text = record.source.kids.find(child => child.name === "t")!;
    text.text = "AC";
    text.kids = text.kids.filter(child => child.name === "s" && child.text === "B");
    const reopened = roundTrip(JSON.parse(JSON.stringify(imported.document)) as ChemDraftDocument);
    expect(reopened.document!.pages[0].objects.find(object => object.type === "molecule")!.atoms[0].element).toBe("ABC");
    expect(all(output(imported.document!), "s").find(run => run.text === "B")?.attrs).toMatchObject({ face: "1" });
  });

  it("replaces an edited mixed-content label without retaining stale raw segments", () => {
    const imported = open(page('<fragment id="2"><n id="3" NodeType="Unspecified" p="60 60"><t id="4">A<s face="1">B</s>C</t></n></fragment>'));
    const native = imported.document!.pages[0].objects.find(object => object.type === "molecule")!;
    native.atoms[0].element = "Xx";
    expect(exportWarnings(imported.document!)).toContainEqual(expect.objectContaining({
      code: "cdxml.atom_snapshot_attribute_not_written", message: expect.stringContaining("run formatting")
    }));
    expect(roundTrip(imported.document!).document!.pages[0].objects.find(object => object.type === "molecule")!.atoms[0].element).toBe("Xx");
  });

  it.each(format === "CDXML" ? ["NoHead", "no head", "NONE", "Unspecified", "0", ""] : ["NoHead", "0"])(
    "keeps ArrowType=%s as a plain line through three visible round trips", arrowType => {
      const source = `<graphic id="30" GraphicType="Line" ArrowType="${arrowType}" BoundingBox="100 90 160 90"/>`;
      let imported = open(page(source));
      const expectedType = format === "CDX" ? "NoHead" : arrowType;
      const original = imported.document!.pages[0].objects[0];
      for (let cycle = 0; cycle <= 3; cycle++) {
        expect(imported.document, JSON.stringify(imported.warnings)).toBeDefined();
        const objects = imported.document!.pages[0].objects;
        expect(objects).toHaveLength(1);
        expect(objects[0]).toMatchObject({ type: "graphic", graphicKind: "line",
          x: original.x, y: original.y, width: original.width, height: original.height, style: original.style });
        if (objects[0].type !== "graphic") throw new Error("Expected a plain graphic");
        expect(objects[0].data.markerStart).toBeUndefined();
        expect(objects[0].data.markerEnd).toBeUndefined();
        expect(objects[0].data.artToolId).toBeUndefined();
        expect(all(output(imported.document!), "graphic")[0].attrs).toMatchObject({
          GraphicType: "Line", ArrowType: expectedType, BoundingBox: "100 90 160 90"
        });
        if (cycle < 3) imported = roundTrip(imported.document!);
      }
    }
  );

  it.each(["ArrowType", "ArrowheadHead", "ArrowheadTail"])("warns about an unmapped line style on the %s path", attribute => {
    // Dotted has no binary enum; unknown bit 8 exercises the same warning in real CDX.
    const lineType = format === "CDX" ? "8" : "Dotted";
    const head = attribute === "ArrowType" ? "FullHead" : "Full";
    const imported = open(page(`<graphic id="30" GraphicType="Line" ${attribute}="${head}"
      LineType="${lineType}" BoundingBox="100 90 160 90"/>`));
    expect(imported.document!.pages[0].objects[0]).toMatchObject({ type: "graphic", graphicKind: "path" });
    const warnings = imported.warnings.filter(warning => warning.code === "cdxml.arrow_line_type_approximation");
    expect(warnings).toEqual([expect.objectContaining({ sourceObjectId: "30",
      message: expect.stringContaining(`arrow 30 has unmapped LineType="${lineType}"`) })]);
    const exported = output(imported.document!);
    expect([...all(exported, "graphic"), ...all(exported, "arrow")][0].attrs.LineType).toBe(lineType);
  });

  it.each(["", 'ReactionStepArrows="999" ReactionStepReactants="998" ReactionStepProducts="997"',
    'ReactionStepObjectsAboveArrow="40" ReactionStepPlusses="40"'])(
    "preserves a scheme-less step with no primary links (%s) instead of inventing a reaction", links => {
      const imported = open(page(`<step id="21" ${links}><scheme id="22"/></step>
        <t id="40" p="100 60"><s>Synthetic conditions</s></t>`));
      const objects = imported.document!.pages[0].objects;
      expect(objects.filter(object => object.type === "reaction")).toEqual([]);
      expect(objects.find(object => object.compatibility?.originalId === "21")).toMatchObject({
        type: "unknown-compatibility-object", sourceObjectType: "step",
        raw: { attributes: { id: "21" }, children: expect.any(Array) }
      });
      expect(imported.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.reaction_step_preserved",
        sourceObjectId: "21", message: expect.stringContaining("step 21") }));
      if (links.includes("999")) expect(imported.warnings.filter(warning => warning.code === "cdxml.reaction_reference_unresolved")).toHaveLength(3);
    }
  );

  it.each(["ReactionStepArrows", "ReactionStepReactants", "ReactionStepProducts"])(
    "imports a scheme-less step with only a resolved %s link", attribute => {
      const target = attribute === "ReactionStepArrows"
        ? '<graphic id="30" GraphicType="Line" ArrowType="FullHead" BoundingBox="100 90 160 90"/>'
        : molecule;
      const imported = open(page(`<step id="21" ${attribute}="${attribute === "ReactionStepArrows" ? "30" : "2"}"/>${target}`));
      const reaction = imported.document!.pages[0].objects.find(object => object.type === "reaction")!;
      expect(reaction).toBeDefined();
      expect(reaction.components.length + (reaction.arrowObjectIds?.length ?? 0)).toBe(1);
      expect(imported.warnings.filter(warning => warning.code === "cdxml.reaction_step_preserved")).toEqual([]);
      expect(roundTrip(imported.document!).document!.pages[0].objects.filter(object => object.type === "reaction")).toHaveLength(1);
    }
  );

  it("names an unsupported curly-pair bracket whose glyph cannot be native", () => {
    const imported = open(page(molecule + glyph(10, "CurlyPair", 'Warning="synthetic warning"') + glyph(11, "Square") + glyph(12)));
    expect(imported.document).toBeDefined();
    expect(imported.document!.pages[0].objects.filter(o => o.type === "bracket")).toHaveLength(2);
    expect(imported.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.bracket_type_preserved", sourceObjectId: "10",
      message: expect.stringMatching(/bracket 10.*CurlyPair.*not imported as a native glyph/i) }));
    expect(exportWarnings(imported.document!)).toContainEqual(expect.objectContaining({ code: "cdxml.bracket_type_preserved", sourceObjectId: "10",
      message: expect.stringMatching(/bracket 10.*CurlyPair.*NOT written/i) }));
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
    const nestedWarnings = exportWarnings(imported.document!).filter(warning => warning.code === "cdxml.bracket_nested_group_preserved");
    expect(nestedWarnings.map(warning => warning.sourceObjectId).sort()).toEqual(["21", "22"]);
    for (const warning of nestedWarnings) expect(warning.message).toMatch(/native.*repeat count.*crossing bonds.*source compatibility data/i);
    // The outer pair exports its opaque hierarchy; reopening must still name both unsupported
    // native groups rather than silently treating those raw children as native pairs.
    const exported = output(imported.document!);
    expect(all(exported, "bracketedgroup")).toHaveLength(3);
    expect(all(exported, "crossingbond")).toHaveLength(6);
    for (const id of ["21", "22"]) expect(roundTrip(imported.document!).warnings).toContainEqual(expect.objectContaining({
      code: "cdxml.bracket_nested_group_preserved", sourceObjectId: id
    }));
  });

  it.each(["Dashed", "Bold", "Wavy", "Solid", undefined, "8", "9", ...(format === "CDXML" ? ['Synthetic "line"', ""] : [])])("keeps a step's %s line arrow linked through three visible round trips", lineType => {
    // Numeric values exercise unknown binary bits (alone and alongside Dashed); CDXML also
    // accepts arbitrary source text, including quotes that must be escaped again on export.
    const lineAttribute = lineType === undefined ? "" : `LineType="${lineType.replace(/"/g, "&quot;")}"`;
    let imported = open(page(molecule + `<graphic id="10" GraphicType="Line" ArrowType="FullHead" ${lineAttribute} HeadSize="1000" Z="2" BoundingBox="120 60 180 60"/>
      <scheme id="20"><step id="21" ReactionStepReactants="2" ReactionStepProducts="2" ReactionStepArrows="10"/></scheme>`));
    for (let cycle = 0; cycle <= 3; cycle++) {
      expect(imported.document, JSON.stringify(imported.warnings)).toBeDefined();
      const document = imported.document!;
      const objects = document.pages[0].objects;
      const reaction = objects.find(o => o.type === "reaction")!;
      expect(reaction).toBeDefined();
      expect(reaction.arrowObjectIds).toHaveLength(1);
      expect(reaction.components.map(component => component.role)).toEqual(["reactant", "product"]);
      const arrow = objects.find(o => o.id === reaction.arrowObjectIds![0]);
      expect(arrow).toMatchObject({ type: "graphic", data: { artToolId: "reactionArrow", markerEnd: { kind: "filled-arrow" } } });
      if (lineType !== undefined) expect(arrow?.compatibility?.unknown.cdxmlLineType).toBe(lineType);
      if (lineType === "Dashed") expect(arrow?.style.strokeDasharray).toBeTruthy();
      if (lineType === "Bold") expect(arrow?.style.strokeWidth).toBeGreaterThan(1);
      if (lineType === "Wavy") expect(arrow).toMatchObject({ data: { artPathKind: "wavy" } });
      if (lineType !== undefined && !["Dashed", "Bold", "Wavy", "Solid"].includes(lineType)) {
        expect(imported.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.arrow_line_type_approximation",
          message: expect.stringContaining(`LineType="${lineType}"`) }));
      }
      expect(imported.warnings.filter(warning => ["cdxml.object_import_unsupported", "cdxml.reaction_reference_unresolved"].includes(warning.code))).toEqual([]);
      if (cycle === 3) break;
      const exported = output(document);
      const step = all(exported, "step")[0];
      const target = all(exported, "graphic").find(o => o.attrs.id === step.attrs.ReactionStepArrows)!;
      expect(target?.attrs).toMatchObject({ GraphicType: "Line", ArrowType: "FullHead" });
      expect(target?.attrs.LineType).toBe(lineType);
      imported = roundTrip(document);
    }
  });

  it.each([
    ["HalfHead", "fishhookArrow"], ["Resonance", "resonanceArrow"],
    ["Equilibrium", "equilibriumArrow"], ["Retrosynthetic", "retroArrow"]
  ])("imports %s heads independently of line style", (head, tool) => {
    for (const lineType of ["Solid", undefined, "8"]) {
      const lineAttribute = lineType === undefined ? "" : `LineType="${lineType}"`;
      const imported = open(page(molecule + `<graphic id="10" GraphicType="Line" ArrowType="${head}" ${lineAttribute} BoundingBox="120 60 180 60"/>
        <scheme id="20"><step id="21" ReactionStepReactants="2" ReactionStepProducts="2" ReactionStepArrows="10"/></scheme>`));
      expect(imported.document, JSON.stringify(imported.warnings)).toBeDefined();
      const objects = imported.document!.pages[0].objects;
      const reaction = objects.find(object => object.type === "reaction")!;
      expect(reaction.arrowObjectIds).toHaveLength(1);
      expect(objects.find(object => object.id === reaction.arrowObjectIds![0])).toMatchObject({
        type: "graphic", data: { artToolId: tool }
      });
    }
  });

  it.each([
    ["ReactionStepArrows", "arrow"], ["ReactionStepReactants", "reactants"],
    ["ReactionStepProducts", "products"], ["ReactionStepObjectsAboveArrow", "conditions"],
    ["ReactionStepObjectsBelowArrow", "conditions"]
  ])("names the step and its unresolved %s link", (attribute, link) => {
    const imported = open(page(molecule + `<scheme id="20"><step id="21" ${attribute}="999"/></scheme>`));
    expect(imported.document).toBeDefined();
    expect(imported.warnings).toContainEqual(expect.objectContaining({
      code: "cdxml.reaction_reference_unresolved",
      message: expect.stringMatching(new RegExp(`step 21:.*${attribute} id "999".*${link} link`, "i"))
    }));
  });

  for (const [head, tool] of [["FullHead", "reactionArrow"], ["HalfHead", "fishhookArrow"],
    ["Resonance", "resonanceArrow"], ["Equilibrium", "equilibriumArrow"], ["Retrosynthetic", "retroArrow"]]) {
    it.each([undefined, "Solid", "Dashed", "Bold", "Wavy"])(
      `keeps a standalone ${head} line's %s appearance and geometry without a reaction step`, lineType => {
        const lineAttribute = lineType === undefined ? "" : `LineType="${lineType}"`;
        let imported = open(page(`<graphic id="10" GraphicType="Line" ArrowType="${head}" ${lineAttribute}
          BoundingBox="60 60 180 100" Tail3D="60 60 0" Head3D="180 100 0"/>`));
        const arrow = imported.document!.pages[0].objects[0];
        expect(arrow).toMatchObject({ type: "graphic", graphicKind: "path", data: { artToolId: tool } });
        if (arrow.type !== "graphic") throw new Error("Expected an editable art arrow");
        const geometry = { x: arrow.x, y: arrow.y, width: arrow.width, height: arrow.height };
        const appearance = planNativeArtVisual(arrow);
        const style = { ...arrow.style };
        for (let cycle = 0; cycle < 3; cycle++) {
          expect(all(output(imported.document!), "step")).toEqual([]);
          imported = roundTrip(imported.document!);
          expect(imported.document!.pages[0].objects).toHaveLength(1);
          const reopened = imported.document!.pages[0].objects[0];
          expect(reopened).toMatchObject({
            type: "graphic", graphicKind: "path", ...geometry, style, data: { artToolId: tool }
          });
          if (reopened.type !== "graphic") throw new Error("Expected an editable art arrow");
          expect(planNativeArtVisual(reopened)).toEqual(appearance);
        }
      }
    );
  }

  it("resolves a scheme-less step and names only its unresolved links", () => {
    const imported = open(page(molecule + `<step id="21" ReactionStepArrows="999" ReactionStepReactants="2"
      ReactionStepProducts="2" ReactionStepObjectsAboveArrow="998" ReactionStepObjectsBelowArrow="997"/>`));
    const reaction = imported.document!.pages[0].objects.find(object => object.type === "reaction")!;
    expect(reaction.components.map(component => component.role)).toEqual(["reactant", "product"]);
    for (const attribute of ["ReactionStepArrows", "ReactionStepObjectsAboveArrow", "ReactionStepObjectsBelowArrow"]) {
      expect(imported.warnings).toContainEqual(expect.objectContaining({
        code: "cdxml.reaction_reference_unresolved",
        message: expect.stringMatching(new RegExp(`step 21:.*${attribute}.*could not be resolved`, "i"))
      }));
    }
    expect(imported.warnings).not.toContainEqual(expect.objectContaining({ code: "cdxml.reaction_step_preserved" }));
    expect(imported.warnings.filter(warning => warning.code === "cdxml.object_import_unsupported")).toEqual([]);
  });

  it.each(["page", "group", "objectdefinition"])("keeps a scheme-less step under %s linked through three visible round trips", container => {
    const step = '<step id="41" ReactionStepArrows="30" ReactionStepReactants="2 5" ReactionStepProducts="8 11 14 17 20"/>';
    let imported = open(page((container === "page" ? step : `<${container} id="40">${step}</${container}>`) +
      [2, 5, 8, 11, 14, 17, 20].map((id, index) => `<fragment id="${id}"><n id="${id + 1}" Element="${index % 2 ? 8 : 6}" p="${30 + index * 30} 60"/></fragment>`).join("") +
      '<graphic id="30" GraphicType="Line" ArrowType="FullHead" LineType="Solid" BoundingBox="100 90 160 90"/>'));
    for (let cycle = 0; cycle <= 3; cycle++) {
      expect(imported.document, JSON.stringify(imported.warnings)).toBeDefined();
      assertPageStep(imported.document!);
      expect(imported.warnings).not.toContainEqual(expect.objectContaining({ code: "cdxml.reaction_step_preserved" }));
      if (cycle < 3) imported = roundTrip(imported.document!);
    }
  });

  it("keeps standalone and scheme steps in source order", () => {
    let imported = open(page('<step id="40" ReactionStepArrows="30"/>' +
      '<scheme id="41"><step id="42" ReactionStepArrows="30 31"/></scheme>' +
      '<step id="43" ReactionStepArrows="31"/>' +
      [30, 31].map(id => `<graphic id="${id}" GraphicType="Line" ArrowType="FullHead" BoundingBox="60 ${id * 3} 120 ${id * 3}"/>`).join("")));
    for (let cycle = 0; cycle <= 3; cycle++) {
      expect(imported.document!.pages[0].objects.filter(object => object.type === "reaction")
        .map(reaction => reaction.arrowObjectIds?.length)).toEqual([1, 2, 1]);
      if (cycle < 3) imported = roundTrip(imported.document!);
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

  const nativeMolecule = (document: ChemDraftDocument) => document.pages[0].objects.find(o => o.type === "molecule")!;
  // Include absent values: partial matching previously missed lost literal and H semantics.
  const atomState = (native: MoleculeObject) => {
    const atom = native.atoms[0];
    return {
      element: atom.element, isotope: atom.isotope, formalCharge: atom.formalCharge,
      markRadicals: atom.markRadicals, hydrogenCount: atom.hydrogenCount, labelLiteral: atom.labelLiteral,
      stereo: (native.chemistry?.stereochemistry ?? []).map(value => value.slice(value.indexOf(":") + 1))
    };
  };
  const plainState = {
    isotope: undefined, formalCharge: 0, markRadicals: undefined, hydrogenCount: undefined,
    labelLiteral: true, stereo: []
  };
  const normalizedSource = (xml: string) => format === "CDX" ? readCdx(writeCdx(tree(xml))) : tree(xml);

  it.each([
    { name: "D", attrs: 'NodeType="Unspecified" Isotope="2"', label: "H", element: "D", nested: "" },
    { name: "T", attrs: 'NodeType="Unspecified" Isotope="3"', label: "H", element: "T", nested: "" },
    { name: "Unspecified label", attrs: 'NodeType="Unspecified"', label: "Qq", element: "Qq", nested: "" },
    { name: "unexpandable abbreviation", attrs: 'NodeType="AnonymousAlternativeGroup"', label: "Alt", element: "Alt",
      nested: '<fragment id="5"><n id="6" Element="7" p="60 60"/></fragment>' }
  ])("restores an unedited $name source node byte-identically apart from ids without warnings", ({ attrs, label, element, nested }) => {
    const xml = page(`<fragment id="2"><n id="3" ${attrs} NeedsClean="yes" Warning="synthetic" Z="1" p="60 60"><t id="4" p="60 60"><s face="1">${label}</s></t>${nested}</n></fragment>`);
    const expected = cdxElementToCdxml(withoutIds(all(normalizedSource(xml), "n")[0]));
    let imported = open(xml);
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(atomState(nativeMolecule(imported.document!))).toEqual({ ...plainState, element });
      expect(exportWarnings(imported.document!)).toEqual([]);
      expect(cdxElementToCdxml(withoutIds(all(output(imported.document!), "n")[0]))).toBe(expected);
      imported = roundTrip(imported.document!);
    }
  });

  it.each([[2, "D"], [3, "T"]] as const)("keeps literal %s/%s and NumHydrogens after editing charge", (isotope, element) => {
    const xml = page(`<fragment id="2"><n id="3" NodeType="Unspecified" Isotope="${isotope}" NumHydrogens="1" p="60 60"><t id="4"><s>H</s></t></n></fragment>`);
    const imported = open(xml);
    const native = nativeMolecule(imported.document!);
    expect(atomState(native)).toEqual({ ...plainState, element, hydrogenCount: 1 });
    native.atoms[0].formalCharge = -1;
    const expected = withoutIds(all(normalizedSource(xml), "n")[0]);
    expected.attrs.Charge = "-1";
    expect(withoutIds(all(output(imported.document!), "n")[0])).toEqual(expected);
    expect(exportWarnings(imported.document!)).toEqual([]);
    expect(atomState(nativeMolecule(roundTrip(imported.document!).document!))).toEqual({
      ...plainState, element, hydrogenCount: 1, formalCharge: -1
    });
  });

  it("keeps an untouched nonliteral charged Nickname and its explicit NumHydrogens", () => {
    const xml = page('<fragment id="2"><n id="3" NodeType="Nickname" Element="6" Charge="1" NumHydrogens="1" p="60 60"><fragment id="4"><n id="5" Element="7" p="60 60"/></fragment></n></fragment>');
    let imported = open(xml);
    const expected = withoutIds(all(normalizedSource(xml), "n")[0]);
    for (let cycle = 0; cycle < 3; cycle++) {
      expect(atomState(nativeMolecule(imported.document!))).toEqual({
        ...plainState, element: "C", formalCharge: 1, labelLiteral: undefined, hydrogenCount: 1
      });
      expect(exportWarnings(imported.document!)).toEqual([]);
      expect(withoutIds(all(output(imported.document!), "n")[0])).toEqual(expected);
      imported = roundTrip(imported.document!);
    }
  });

  it("keeps AS=R when only charge changes on an Unspecified label", () => {
    const xml = page('<fragment id="2"><n id="3" NodeType="Unspecified" AS="R" p="60 60"><t id="4"><s>Qq</s></t></n></fragment>');
    const imported = open(xml);
    nativeMolecule(imported.document!).atoms[0].formalCharge = -1;
    const expected = withoutIds(all(normalizedSource(xml), "n")[0]);
    expected.attrs.Charge = "-1";
    expect(withoutIds(all(output(imported.document!), "n")[0])).toEqual(expected);
    expect(exportWarnings(imported.document!)).toEqual([]);
    expect(atomState(nativeMolecule(roundTrip(imported.document!).document!))).toEqual({
      ...plainState, element: "Qq", formalCharge: -1, stereo: ["R"]
    });
  });

  for (const kind of ["Unspecified", "Nickname", "AnonymousAlternativeGroup"]) {
    it.each([
      { name: "charge", edit: { formalCharge: -1 }, attribute: "Charge", value: "-1" },
      { name: "neutral charge", edit: { formalCharge: 0 }, attribute: "Charge", value: "0" },
      { name: "isotope", edit: { isotope: 14 }, attribute: "Isotope", value: "14" },
      { name: "removed isotope", edit: { isotope: undefined }, attribute: "Isotope", value: undefined },
      { name: "radical", edit: { markRadicals: 2 }, attribute: "Radical", value: "Triplet" },
      { name: "removed radical", edit: { markRadicals: undefined }, attribute: "Radical", value: undefined },
      { name: "hydrogen count", edit: { hydrogenCount: 2 }, attribute: "NumHydrogens", value: "2" },
      { name: "zero hydrogen count", edit: { hydrogenCount: 0 }, attribute: "NumHydrogens", value: "0" },
      { name: "removed hydrogen count", edit: { hydrogenCount: undefined }, attribute: "NumHydrogens", value: undefined },
      { name: "label text", edit: { element: "N" }, attribute: undefined, value: undefined }
    ] satisfies { name: string; edit: Partial<MoleculeAtom>; attribute?: string; value?: string }[])(
      `merges only edited $name on ${kind}, retaining stereo, annotations and children`, ({ edit, attribute, value }) => {
        const nested = kind === "Unspecified" ? "" : '<fragment id="5"><n id="6" Element="7" p="60 60"/></fragment>';
        const xml = page(`<fragment id="2"><n id="3" NodeType="${kind}" Isotope="13" Charge="1" Radical="Doublet" NumHydrogens="1" AS="R" Geometry="Tetrahedral" NeedsClean="yes" Warning="synthetic" Z="1" p="60 60"><t id="4" p="60 60"><s face="1">C</s></t>${nested}</n></fragment>`);
        const imported = open(xml);
        expect(imported.document, JSON.stringify(imported.warnings)).toBeDefined();
        const native = nativeMolecule(imported.document!);
        const before = { element: "C", isotope: 13, formalCharge: 1, markRadicals: 1,
          hydrogenCount: 1, labelLiteral: true, stereo: ["R"] };
        expect(atomState(native)).toEqual(before);
        Object.assign(native.atoms[0], edit);
        const expected = withoutIds(all(normalizedSource(xml), "n")[0]);
        if (attribute) {
          if (value === undefined) delete expected.attrs[attribute]; else expected.attrs[attribute] = value;
        } else expected.kids.find(kid => kid.name === "t")!.kids[0].text = "N";
        expect(withoutIds(all(output(imported.document!), "n")[0])).toEqual(expected);
        expect(exportWarnings(imported.document!)).toEqual([]);
        expect(atomState(nativeMolecule(roundTrip(imported.document!).document!))).toEqual({ ...before, ...edit });
      }
    );
  }

  it.each([2, 3])("merges an edited isotopic H label of mass %s without dropping its literal semantics", isotope => {
    for (const element of ["Qq", "H", isotope === 2 ? "T" : "D"]) {
      const imported = open(page(`<fragment id="2"><n id="3" NodeType="Unspecified" Isotope="${isotope}" NumHydrogens="1" AS="R" p="60 60"><t id="4"><s>H</s></t></n></fragment>`));
      nativeMolecule(imported.document!).atoms[0].element = element;
      expect(exportWarnings(imported.document!)).toEqual([]);
      expect(all(output(imported.document!), "n")[0].attrs.NodeType).toBe("Unspecified");
      expect(atomState(nativeMolecule(roundTrip(imported.document!).document!))).toEqual({
        ...plainState, element, hydrogenCount: 1, stereo: ["R"]
      });
    }
  });

  it("merges an edited source AS assignment without discarding the label", () => {
    const imported = open(page('<fragment id="2"><n id="3" NodeType="Unspecified" AS="R" p="60 60"><t id="4"><s>Qq</s></t></n></fragment>'));
    const native = nativeMolecule(imported.document!);
    native.chemistry!.stereochemistry = [`${native.atoms[0].id}:S`];
    expect(all(output(imported.document!), "n")[0].attrs.AS).toBe("S");
    expect(exportWarnings(imported.document!)).toEqual([]);
    expect(atomState(nativeMolecule(roundTrip(imported.document!).document!))).toEqual({
      ...plainState, element: "Qq", stereo: ["S"]
    });
  });

  it("merges Element on a nonliteral unexpandable atom without treating its explicit H count as an edit", () => {
    const xml = page('<fragment id="2"><n id="3" NodeType="Nickname" Element="6" Charge="1" NumHydrogens="1" AS="R" p="60 60"><fragment id="4"><n id="5" Element="7" p="60 60"/></fragment></n></fragment>');
    const imported = open(xml);
    nativeMolecule(imported.document!).atoms[0].element = "N";
    const expected = withoutIds(all(normalizedSource(xml), "n")[0]);
    expected.attrs.Element = "7";
    expect(withoutIds(all(output(imported.document!), "n")[0])).toEqual(expected);
    expect(exportWarnings(imported.document!)).toEqual([]);
    expect(atomState(nativeMolecule(roundTrip(imported.document!).document!))).toEqual({
      ...plainState, element: "N", formalCharge: 1, labelLiteral: undefined, hydrogenCount: 1, stereo: ["R"]
    });
  });

  it("retains multiple source label runs on a charge edit and names formatting lost on a text edit", () => {
    const xml = page('<fragment id="2"><n id="3" NodeType="Unspecified" AS="R" p="60 60"><t id="4"><s face="1">Q</s><s face="32">q</s></t></n></fragment>');
    const imported = open(xml);
    const atom = nativeMolecule(imported.document!).atoms[0];
    atom.formalCharge = -1;
    const expected = withoutIds(all(normalizedSource(xml), "n")[0]);
    expected.attrs.Charge = "-1";
    expect(withoutIds(all(output(imported.document!), "n")[0])).toEqual(expected);
    expect(exportWarnings(imported.document!)).toEqual([]);
    expect(atomState(nativeMolecule(roundTrip(imported.document!).document!))).toEqual({
      ...plainState, element: "Qq", formalCharge: -1, stereo: ["R"]
    });
    atom.element = "Xx";
    expect(exportWarnings(imported.document!)).toEqual([expect.objectContaining({
      code: "cdxml.atom_snapshot_attribute_not_written", sourceObjectId: "3",
      message: expect.stringMatching(/node 3:.*run.*formatting/)
    })]);
    expect(atomState(nativeMolecule(roundTrip(imported.document!).document!))).toEqual({
      ...plainState, element: "Xx", formalCharge: -1, stereo: ["R"]
    });
  });

  it.each([0, 2, undefined])("merges a nonliteral snapshot's edited hydrogen count %s", hydrogenCount => {
    const xml = page('<fragment id="2"><n id="3" NodeType="Nickname" Element="6" Charge="1" NumHydrogens="1" AS="R" p="60 60"><fragment id="4"><n id="5" Element="7" p="60 60"/></fragment></n></fragment>');
    const imported = open(xml);
    nativeMolecule(imported.document!).atoms[0].hydrogenCount = hydrogenCount;
    const expected = withoutIds(all(normalizedSource(xml), "n")[0]);
    if (hydrogenCount === undefined) delete expected.attrs.NumHydrogens;
    else expected.attrs.NumHydrogens = String(hydrogenCount);
    expect(withoutIds(all(output(imported.document!), "n")[0])).toEqual(expected);
    expect(exportWarnings(imported.document!)).toEqual([]);
    expect(atomState(nativeMolecule(roundTrip(imported.document!).document!))).toEqual({
      ...plainState, element: "C", formalCharge: 1, labelLiteral: undefined, hydrogenCount, stereo: ["R"]
    });
  });

  it("merges snapshots from older native documents without a recorded native baseline", () => {
    const imported = open(page('<fragment id="2"><n id="3" NodeType="Nickname" Element="6" Charge="1" NumHydrogens="1" AS="R" p="60 60"><fragment id="4"><n id="5" Element="7" p="60 60"/></fragment></n></fragment>'));
    const native = nativeMolecule(imported.document!);
    const records = native.compatibility!.unknown.cdxmlAbbreviations as { nativeState?: unknown }[];
    records.forEach(record => { delete record.nativeState; });
    delete native.atoms[0].hydrogenCount; // The older importer kept this source constraint opaque.
    expect(exportWarnings(imported.document!)).toEqual([]);
    native.atoms[0].formalCharge = -1;
    expect(all(output(imported.document!), "n")[0].attrs.NumHydrogens).toBe("1");
    expect(exportWarnings(imported.document!)).toEqual([]);
    expect(atomState(nativeMolecule(roundTrip(imported.document!).document!))).toEqual({
      ...plainState, element: "C", formalCharge: -1, labelLiteral: undefined, hydrogenCount: 1, stereo: ["R"]
    });
  });

  it("keeps inner atom attributes and unchanged wrapper label runs when rebuilding a superatom", () => {
    const xml = page('<fragment id="2"><n id="3" NodeType="Nickname" NeedsClean="yes" Warning="wrapper" p="60 60"><fragment id="4"><n id="5" Element="6" AS="R" NumHydrogens="1" Warning="body" p="60 60"/></fragment><t id="6"><s face="1">M</s><s face="2">e</s></t></n></fragment>');
    const imported = open(xml);
    const native = nativeMolecule(imported.document!);
    expect(native.superatoms).toHaveLength(1);
    native.atoms[0].formalCharge = -1;
    const source = all(normalizedSource(xml), "n");
    const nodes = all(output(imported.document!), "n");
    expect(withoutIds(nodes[0]).attrs).toEqual(withoutIds(source[0]).attrs);
    expect(withoutIds(nodes[0]).kids.find(kid => kid.name === "t")).toEqual(withoutIds(source[0]).kids.find(kid => kid.name === "t"));
    const body = withoutIds(source[1]);
    body.attrs.Charge = "-1";
    expect(withoutIds(nodes[1])).toEqual(body);
    expect(exportWarnings(imported.document!)).toEqual([]);
    expect(atomState(nativeMolecule(roundTrip(imported.document!).document!))).toEqual({
      ...plainState, element: "C", formalCharge: -1, labelLiteral: undefined, hydrogenCount: 1, stereo: ["R"]
    });
  });

  it("keeps an edited charge in an ordinary expanded superatom", () => {
    const imported = open(page(`<fragment id="2"><n id="3" NodeType="Nickname" p="60 60">
      <fragment id="4"><n id="5" Element="6" p="60 60"/></fragment><t id="6"><s>Me</s></t></n></fragment>`));
    const native = imported.document!.pages[0].objects.find(o => o.type === "molecule")!;
    expect(native.superatoms).toHaveLength(1);
    native.atoms[0].formalCharge = -1;
    expect(all(output(imported.document!), "n").find(n => n.attrs.Charge === "-1")).toBeDefined();
    expect(roundTrip(imported.document!).document!.pages[0].objects.find(o => o.type === "molecule")!.atoms[0])
      .toMatchObject({ element: "C", formalCharge: -1 });
  });

  it.each([0, 1, 2])("imports a label-only node's explicit hydrogen count %s into its native atom", hydrogenCount => {
    let imported = open(page(`<fragment id="2"><n id="3" NodeType="Unspecified" NumHydrogens="${hydrogenCount}" p="60 60"><t id="4"><s>Qq</s></t></n></fragment>`));
    for (let cycle = 0; cycle < 3; cycle++) {
      const molecule = imported.document!.pages[0].objects.find(o => o.type === "molecule")!;
      expect(molecule.atoms).toMatchObject([{ element: "Qq", labelLiteral: true, hydrogenCount }]);
      expect(all(output(imported.document!), "n")[0].attrs.NumHydrogens).toBe(String(hydrogenCount));
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
