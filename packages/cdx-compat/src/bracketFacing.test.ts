import { describe, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { createEmptyDocument, type BracketObject, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { bracketLabelPlan, transformPointForObject } from "@chemdraft/layout-engine";
import { exportDocumentToCdxml, exportDocumentToCdx, importCdx, openChemDraftPayload } from "./index";
import { CDX_NATIVE_ENVELOPE_ATTRIBUTE, cdxElementFromOrderedTree, readCdx, writeCdx, type CdxElement } from "./cdxBinary";

// All documents in this file are constructed synthetic examples, with no external fixtures.
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "",
  parseAttributeValue: false, trimValues: false });
const tree = (xml: string) => cdxElementFromOrderedTree(parser.parse(xml));
const wrap = (xml: string) => `<CDXML><page id="1" BoundingBox="0 0 612 792">${xml}</page></CDXML>`;
const kinds = ["round", "square", "curly"] as const;
const typeName = { round: "Round", square: "Square", curly: "Curly" };
const facings = [
  { name: "+x", rotation: 0, side: "open", box: "87 138 75 90", x: 100, y: 120 },
  { name: "-x", rotation: 0, side: "close", box: "75 90 87 138", x: 100, y: 120 },
  { name: "+y", rotation: 90, side: "open", box: "75 102 123 90", x: 124, y: 96 },
  { name: "-y", rotation: 90, side: "close", box: "123 90 75 102", x: 124, y: 96 }
] as const;
type Facing = typeof facings[number];
const cases = kinds.flatMap(kind => facings.map(facing => ({ kind, facing })));
const glyph = (kind: typeof kinds[number], box: string, id = "20") =>
  `<graphic id="${id}" GraphicType="Bracket" BracketType="${typeName[kind]}" BoundingBox="${box}"/>`;
const brackets = (document: ChemDraftDocument) => document.pages[0].objects.filter((object): object is BracketObject => object.type === "bracket");
const descendants = (node: CdxElement): CdxElement[] => [node, ...node.kids.flatMap(descendants)];
const graphics = (root: CdxElement) => descendants(root).filter(node => node.name === "graphic");
const oppositeBox = (facing: Facing) => {
  const [x1, y1, x2, y2] = facing.box.split(" ").map(Number);
  const dx = facing.rotation === 0 ? 108 : 0, dy = facing.rotation === 90 ? 108 : 0;
  return [x2 + dx, y2 + dy, x1 + dx, y1 + dy].join(" ");
};
function sourcePair(kind: typeof kinds[number], facing: Facing) {
  return wrap(`<fragment id="10"><n id="11" Element="6" p="110 110"/><n id="12" Element="8" p="140 110"/>
    <b id="13" B="11" E="12" Order="1"/></fragment>
    ${glyph(kind, facing.box)}${glyph(kind, oppositeBox(facing), "21")}
    <bracketedgroup id="30" BracketUsage="SRU" BracketedObjectIDs="10" SRULabel="n" RepeatCount="7">
      <bracketattachment id="31" GraphicID="20"><crossingbond id="32" BondID="13" InnerAtomID="11"/></bracketattachment>
      <bracketattachment id="33" GraphicID="21"/>
    </bracketedgroup>`);
}
function nativePair(kind: typeof kinds[number], facing: Facing, usage: "generic" | "sru" | "multiple" = "sru") {
  const document = createEmptyDocument();
  const molecule: MoleculeObject = { id: "mol", type: "molecule", x: 144, y: 144, width: 40, height: 1,
    rotation: 0, style: {}, structure: "", structureFormat: "unknown", superatoms: [], rGroups: [],
    atoms: [{ id: "a1", element: "C", x: 144, y: 144, formalCharge: 0 },
      { id: "a2", element: "O", x: 184, y: 144, formalCharge: 0 }],
    bonds: [{ id: "bond", fromAtomId: "a1", toAtomId: "a2", order: "single" }] };
  const first: BracketObject = { id: "left", type: "bracket", bracketKind: kind, side: facing.side,
    pairId: "pair", bracketUsage: usage, x: facing.x, y: facing.y, width: 16, height: 64,
    rotation: facing.rotation, style: {}, containedObjectIds: [molecule.id],
    crossingBondIds: [{ objectId: molecule.id, bondId: "bond" }],
    ...(usage === "generic" ? {} : { repeatCount: 7 }),
    ...(usage === "sru" ? { repeatUnit: true, ...(facing.side === "close" ? { label: "n" } : {}) } : {}) };
  const second: BracketObject = { ...first, id: "right", side: facing.side === "open" ? "close" : "open",
    x: first.x + (facing.rotation === 0 ? 144 : 0), y: first.y + (facing.rotation === 90 ? 144 : 0),
    crossingBondIds: [], ...(usage === "sru" ? { label: facing.side === "open" ? "n" : undefined } : {}) };
  document.pages[0].objects = [molecule, first, second];
  return document;
}
function expectFacing(box: string, facing: Pick<Facing, "rotation" | "side">) {
  const [x1, y1, x2, y2] = box.split(/\s+/).map(Number);
  if (facing.rotation === 0) {
    expect(Math.abs(y2 - y1)).toBeGreaterThan(Math.abs(x2 - x1));
    expect(Math.sign(y2 - y1)).toBe(facing.side === "open" ? -1 : 1);
  } else {
    expect(Math.abs(x2 - x1)).toBeGreaterThan(Math.abs(y2 - y1));
    expect(Math.sign(x2 - x1)).toBe(facing.side === "open" ? 1 : -1);
  }
}
function expectPair(document: ChemDraftDocument, kind: typeof kinds[number], facing: Facing, usage: "generic" | "sru" | "multiple") {
  const pair = brackets(document);
  expect(pair).toHaveLength(2);
  expect(pair[0]).toMatchObject({ bracketKind: kind, side: facing.side, rotation: facing.rotation, bracketUsage: usage });
  expect(pair[1]).toMatchObject({ bracketKind: kind, side: facing.side === "open" ? "close" : "open", rotation: facing.rotation, bracketUsage: usage });
  expect(pair[0].pairId).toBeDefined();
  expect(pair[1].pairId).toBe(pair[0].pairId);
  const molecule = document.pages[0].objects.find((object): object is MoleculeObject => object.type === "molecule")!;
  expect(molecule.atoms.map(atom => [atom.element, atom.formalCharge])).toEqual([["C", 0], ["O", 0]]);
  expect(molecule.bonds).toHaveLength(1);
  expect(molecule.bonds[0].order).toBe("single");
  for (const bracket of pair) {
    expect(bracket.containedObjectIds).toEqual([molecule.id]);
    expect(bracket.repeatCount).toBe(usage === "generic" ? undefined : 7);
    expect(Boolean(bracket.repeatUnit)).toBe(usage === "sru");
  }
  expect(pair[0].crossingBondIds).toEqual([{ objectId: molecule.id, bondId: molecule.bonds[0].id }]);
  expect(pair[1].crossingBondIds ?? []).toEqual([]);
  if (usage === "sru") expect(pair.find(bracket => bracket.side === "close")!.label).toBe("n");
  expect(document.pages[0].objects.some(object => object.type === "unknown-compatibility-object")).toBe(false);
}

describe.each(cases)("directed $kind bracket opening $facing.name", ({ kind, facing }) => {
  it("imports the handwritten box through both shared readers, with or without spine thickness", () => {
    const [x1, y1, x2, y2] = facing.box.split(" ").map(Number);
    const thinBox = facing.rotation === 0 ? `${x1} ${y1} ${x1} ${y2}` : `${x1} ${y1} ${x2} ${y1}`;
    for (const box of [facing.box, thinBox]) {
      const xml = wrap(glyph(kind, box));
      for (const result of [openChemDraftPayload(xml), importCdx(writeCdx(tree(xml)))]) {
        expect(brackets(result.document!)[0]).toMatchObject({ bracketKind: kind, rotation: facing.rotation, side: facing.side });
        expect(result.warnings.map(warning => warning.code)).not.toContain("cdxml.bracket_type_preserved");
      }
    }
    const bracket = brackets(openChemDraftPayload(wrap(glyph(kind, facing.box))).document!)[0];
    expect(bracket).toMatchObject({ x: facing.x, y: facing.y, width: 16, height: 64 });
  });

  it("exports native glyphs using the kind and directed corner order in both formats", () => {
    const document = nativePair(kind, facing);
    const xml = exportDocumentToCdxml(document, { embedNativePayload: false });
    const cdx = exportDocumentToCdx(document, { embedNativePayload: false });
    for (const [root, warnings] of [[tree(xml.contents), xml.warnings], [readCdx(cdx.bytes), cdx.warnings]] as const) {
      expect(root.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE]).toBeUndefined();
      expect(descendants(root).some(node => node.name === "objecttag")).toBe(false);
      const exported = graphics(root);
      expect(exported).toHaveLength(2);
      expect(exported[0].attrs).toMatchObject({ GraphicType: "Bracket", BracketType: typeName[kind], BoundingBox: facing.box });
      expectFacing(exported[0].attrs.BoundingBox, facing);
      expectFacing(exported[1].attrs.BoundingBox, { ...facing, side: facing.side === "open" ? "close" : "open" });
      expect(warnings.map(warning => warning.code)).not.toContain("cdxml.bracket_geometry_approximated");
    }
  });

  it("round-trips kind, side, rotation and complete groups without a native payload", () => {
    for (const usage of ["generic", "sru", "multiple"] as const) {
      const native = nativePair(kind, facing, usage);
      const fromXml = openChemDraftPayload(exportDocumentToCdxml(native, { embedNativePayload: false }).contents).document!;
      const fromCdx = importCdx(exportDocumentToCdx(native, { embedNativePayload: false }).bytes).document!;
      for (const reopened of [fromXml, fromCdx]) {
        expectPair(reopened, kind, facing, usage);
        brackets(reopened).forEach((bracket, index) => {
          const original = brackets(native)[index];
          for (const field of ["x", "y", "width", "height"] as const) expect(bracket[field]).toBeCloseTo(original[field], 4);
        });
      }
    }
  });

  it("regenerates the directed box after an imported glyph's kind or facing changes", () => {
    const document = openChemDraftPayload(sourcePair(kind === "square" ? "round" : "square", facings[0])).document!;
    const edited = brackets(document), target = brackets(nativePair(kind, facing));
    edited.forEach((bracket, index) => {
      const { x, y, width, height, side, rotation, bracketKind, label } = target[index];
      Object.assign(bracket, { x, y, width, height, side, rotation, bracketKind, label });
    });
    const xml = exportDocumentToCdxml(document, { embedNativePayload: false }).contents;
    expect(graphics(tree(xml))[0].attrs).toMatchObject({ BracketType: typeName[kind], BoundingBox: facing.box });
    expectPair(openChemDraftPayload(xml).document!, kind, facing, "sru");
    expectPair(importCdx(exportDocumentToCdx(document, { embedNativePayload: false }).bytes).document!, kind, facing, "sru");
  });

  it("retains handwritten pair semantics and original box text through visible interchange", () => {
    const xml = sourcePair(kind, facing).replace(`BoundingBox="${facing.box}"`, `BoundingBox=" ${facing.box.replaceAll(" ", "  ")} "`);
    for (const binary of [false, true]) {
      const imported = binary ? importCdx(writeCdx(tree(xml))) : openChemDraftPayload(xml);
      expectPair(imported.document!, kind, facing, "sru");
      const exported = exportDocumentToCdxml(imported.document!, { embedNativePayload: false }).contents;
      const originalBox = graphics(tree(xml))[0].attrs.BoundingBox;
      const expectedBox = binary ? facing.box : originalBox;
      // CDX normalizes numeric text; CDXML preserves the exact source string, including spaces.
      expect(graphics(tree(exported))[0].attrs.BoundingBox).toBe(expectedBox);
      expectPair(openChemDraftPayload(exported).document!, kind, facing, "sru");
      expectPair(importCdx(exportDocumentToCdx(imported.document!, { embedNativePayload: false }).bytes).document!, kind, facing, "sru");
    }
  });

  it("imports a distinct same-facing pair by position with its group semantics and a named warning", () => {
    const sameFacingBox = facing.box.split(" ").map((value, index) => Number(value) +
      (index % 2 === (facing.rotation === 0 ? 0 : 1) ? 108 : 0)).join(" ");
    const xml = sourcePair(kind, facing).replace(`BoundingBox="${oppositeBox(facing)}"`, `BoundingBox="${sameFacingBox}"`);
    for (const result of [openChemDraftPayload(xml), importCdx(writeCdx(tree(xml)))]) {
      const pair = brackets(result.document!);
      expect(pair).toHaveLength(2);
      expect(pair.map(bracket => bracket.side)).toEqual(["open", "close"]);
      expect(pair[0].pairId).toBeDefined();
      expect(pair[0].pairId).toBe(pair[1].pairId);
      for (const bracket of pair) expect(bracket).toMatchObject({ bracketKind: kind, rotation: facing.rotation,
        bracketUsage: "sru", repeatUnit: true, repeatCount: 7 });
      expect(pair[1].label).toBe("n");
      expect(pair[0].containedObjectIds).toHaveLength(1);
      expect(pair[0].crossingBondIds).toHaveLength(1);
      expect(result.document!.pages[0].objects.some(object => object.type === "unknown-compatibility-object")).toBe(false);
      expect(result.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.bracket_sides_ambiguous",
        message: expect.stringContaining("group 30") }));
    }
  });
});

it("uses the renderer's clockwise rotation about the frame centre", () => {
  const object = brackets(nativePair("square", facings[0]))[0];
  const centre = { x: object.x + object.width / 2, y: object.y + object.height / 2 };
  for (const [rotation, expectedX, expectedY] of [[0, 1, 0], [90, 0, 1], [180, -1, 0], [270, 0, -1]]) {
    const point = transformPointForObject({ ...object, rotation }, { x: centre.x + 1, y: centre.y });
    expect(point.x - centre.x).toBeCloseTo(expectedX, 8);
    expect(point.y - centre.y).toBeCloseTo(expectedY, 8);
  }
});

it.each(["horizontal", "vertical", "identical"])("uses pair positions only for %s degenerate boxes", mode => {
  const secondBox = mode === "horizontal" ? "100 90 100 90" : mode === "vertical" ? "75 120 75 120" : "75 90 75 90";
  const xml = wrap(`${glyph("curly", "75 90 75 90")}${glyph("curly", secondBox, "21")}
    <bracketedgroup id="30"><bracketattachment id="31" GraphicID="21"/><bracketattachment id="32" GraphicID="20"/></bracketedgroup>`);
  for (const result of [openChemDraftPayload(xml), importCdx(writeCdx(tree(xml)))]) {
    const pair = brackets(result.document!);
    expect(pair.map(bracket => bracket.side)).toEqual(mode === "identical" ? ["open", "open"] : ["open", "close"]);
    if (mode === "identical") expect(result.warnings.map(warning => warning.code)).toContain("cdxml.bracket_sides_ambiguous");
    else expect(pair[0].pairId).toBe(pair[1].pairId);
  }
});

it("uses a degenerate half's pair position without overwriting its directed partner", () => {
  const xml = wrap(`${glyph("round", "75 90 75 90")}${glyph("round", "183 90 195 138", "21")}
    <bracketedgroup id="30"><bracketattachment id="31" GraphicID="21"/><bracketattachment id="32" GraphicID="20"/></bracketedgroup>`);
  const pair = brackets(openChemDraftPayload(xml).document!);
  expect(pair.map(bracket => bracket.side)).toEqual(["open", "close"]);
  expect(pair[0].pairId).toBeDefined();
  expect(pair[0].pairId).toBe(pair[1].pairId);
});

it.each(["RoundPair", "SquarePair", "CurlyPair"])("keeps unsupported %s graphics opaque in both formats", kind => {
  const xml = wrap(`<graphic id="20" GraphicType="Bracket" BracketType="${kind}" BoundingBox="75 138 75 90"/>`);
  for (const result of [openChemDraftPayload(xml), importCdx(writeCdx(tree(xml)))]) {
    expect(result.document!.pages[0].objects[0].type).toBe("unknown-compatibility-object");
    expect(result.warnings.map(warning => warning.code)).toContain("cdxml.bracket_type_preserved");
  }
});

it.each(["square", "round", "curly"] as const)("exports %s at every cardinal rotation without an approximation warning", kind => {
  for (const rotation of [0, 90, 180, 270]) for (const side of ["open", "close"] as const) {
    const document = createEmptyDocument();
    const original = { ...brackets(nativePair(kind, facings[0]))[0], rotation, side, pairId: undefined,
      bracketUsage: undefined, repeatCount: undefined, repeatUnit: undefined, crossingBondIds: undefined, containedObjectIds: [] };
    document.pages[0].objects = [original];
    const xml = exportDocumentToCdxml(document, { embedNativePayload: false });
    const cdx = exportDocumentToCdx(document, { embedNativePayload: false });
    for (const [result, warnings] of [[openChemDraftPayload(xml.contents), xml.warnings], [importCdx(cdx.bytes), cdx.warnings]] as const) {
      expect(brackets(result.document!)[0]).toMatchObject({ bracketKind: kind, side, rotation });
      expect(warnings.map(warning => warning.code)).not.toContain("cdxml.bracket_geometry_approximated");
    }
  }
});

describe.each(kinds)("%s rotated SRU label and frame", kind => {
  it.each([180, 270])("retains the label's glyph, page position and drawn frame at %s degrees", rotation => {
    for (const side of ["open", "close"] as const) {
      const native = nativePair(kind, facings.find(facing => facing.rotation === rotation % 180 && facing.side === side)!);
      brackets(native).forEach(bracket => { bracket.rotation = rotation; });
      const labelPosition = (bracket: BracketObject) => {
        const label = bracketLabelPlan(bracket)!;
        return transformPointForObject(bracket, { x: bracket.x + label.x, y: bracket.y + label.y });
      };
      const drawnFrame = (bracket: BracketObject) => [
        { x: bracket.x, y: bracket.y }, { x: bracket.x + bracket.width, y: bracket.y },
        { x: bracket.x + bracket.width, y: bracket.y + bracket.height }, { x: bracket.x, y: bracket.y + bracket.height }
      ].map(point => transformPointForObject(bracket, point));
      for (const binary of [false, true]) {
        let document = native;
        for (let pass = 0; pass < 2; pass++) {
          document = (binary
            ? importCdx(exportDocumentToCdx(document, { embedNativePayload: false }).bytes)
            : openChemDraftPayload(exportDocumentToCdxml(document, { embedNativePayload: false }).contents)).document!;
          const reopened = brackets(document);
          expect(reopened).toHaveLength(2);
          reopened.forEach((bracket, index) => {
            const original = brackets(native)[index];
            expect(bracket).toMatchObject({ bracketKind: kind, side: original.side, rotation, bracketUsage: "sru" });
            drawnFrame(bracket).forEach((point, corner) => {
              expect(point.x).toBeCloseTo(drawnFrame(original)[corner].x, 4);
              expect(point.y).toBeCloseTo(drawnFrame(original)[corner].y, 4);
            });
            if (original.side === "close") {
              expect(bracket.label).toBe("n");
              expect(labelPosition(bracket).x).toBeCloseTo(labelPosition(original).x, 4);
              expect(labelPosition(bracket).y).toBeCloseTo(labelPosition(original).y, 4);
            } else expect(bracketLabelPlan(bracket)).toBeUndefined();
          });
          expect(reopened[0].pairId).toBeDefined();
          expect(reopened[0].pairId).toBe(reopened[1].pairId);
        }
      }
    }
  });
});

it("updates frame hints after a rotation edit and ignores hints for a different box axis", () => {
  const native = nativePair("square", facings[0]);
  brackets(native).forEach(bracket => { bracket.rotation = 180; });
  const source = exportDocumentToCdxml(native, { embedNativePayload: false }).contents;
  expect(source).toContain("attrib4346=");
  const document = openChemDraftPayload(source).document!;
  brackets(document).forEach(bracket => { bracket.rotation = 90; });
  const edited = exportDocumentToCdxml(document, { embedNativePayload: false }).contents;
  expect(edited).not.toContain("attrib4346=");
  const staleHint = graphics(tree(source))[0].attrs.attrib4346;
  const inconsistent = edited.replaceAll('GraphicType="Bracket"', `GraphicType="Bracket" attrib4346="${staleHint}"`);
  for (const imported of [openChemDraftPayload(inconsistent), importCdx(writeCdx(tree(inconsistent)))]) {
    expect(brackets(imported.document!).map(bracket => [bracket.rotation, bracket.side])).toEqual([[90, "open"], [90, "close"]]);
  }
});

it.each(["square", "round", "curly"] as const)("keeps the approximation warning for non-cardinal %s rotations", kind => {
  const document = nativePair(kind, facings[0]);
  brackets(document)[0].rotation = 30;
  for (const result of [exportDocumentToCdxml(document, { embedNativePayload: false }), exportDocumentToCdx(document)]) {
    expect(result.warnings.map(warning => warning.code)).toContain("cdxml.bracket_geometry_approximated");
  }
});

it.each(["polymer", "unknown"] as const)("retains the square approximation and warning for native %s kinds", kind => {
  const document = nativePair("square", facings[0]);
  brackets(document)[0].bracketKind = kind;
  const xml = exportDocumentToCdxml(document, { embedNativePayload: false });
  const cdx = exportDocumentToCdx(document, { embedNativePayload: false });
  for (const [root, warnings] of [[tree(xml.contents), xml.warnings], [readCdx(cdx.bytes), cdx.warnings]] as const) {
    expect(graphics(root)[0].attrs.BracketType).toBe("Square");
    expect(warnings.map(warning => warning.code)).toContain("cdxml.bracket_geometry_approximated");
  }
});
