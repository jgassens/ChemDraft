import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPatches, createImageGraphicObject, type ChemDraftDocument, type DocumentObject, type GroupObject, type TextObject } from "@chemdraft/chem-core";
import {
  copyAsScopeMolecules, copyAsScopeObjects, copyAsScopedDocument, createPhase4Document, exportPhase4Svg,
  groupSelectedDocumentObjects, insertNativeSingleBondMolecule, insertNativeTemplateMolecule
} from "./documentWorkflow";

describe("Copy As grouped artwork", () => {
  it("prepares bundled handwriting before the desktop SVG export wrapper writes Sketch text", async () => {
    const document = createPhase4Document("Sketch clipboard");
    document.pages[0]!.objects = [{ id: "sketch-text", type: "text", x: 100, y: 100,
      width: 100, height: 30, rotation: 0, text: "OH ⇌", spans: [],
      style: { fontFamily: "'Patrick Hand', Arial, Helvetica, sans-serif" } }];
    const result = await exportPhase4Svg(copyAsScopedDocument(document));
    expect(result.contents).toContain("@font-face");
    expect(result.contents).toContain("OH ⇌");
  });

  it("copies a user-made group recursively, in paint order, without unrelated artwork", async () => {
    const document = insertNativeSingleBondMolecule(
      insertNativeSingleBondMolecule(createPhase4Document("Grouped Copy As"), { x: 300, y: 300 }),
      { x: 700, y: 500 }
    );
    const page = document.pages[0]!;
    const molecule = page.objects.find((object) => object.type === "molecule")!;
    const caption: TextObject = {
      id: "caption", type: "text", text: "Grouped artwork", spans: [],
      x: 300, y: 350, width: 120, height: 20, rotation: 0, style: {}
    };
    const unrelated: TextObject = { ...caption, id: "unrelated", text: "Outside", x: 700 };
    const grouped = groupSelectedDocumentObjects(applyPatches(document, [
      { op: "addObject", pageId: page.id, object: caption },
      { op: "addObject", pageId: page.id, object: unrelated },
      { op: "setSelection", pageId: page.id, objectIds: [molecule.id, caption.id] }
    ]));
    const inner = grouped.pages[0]!.objects.find((object): object is GroupObject => object.type === "group")!;
    const outer: GroupObject = { ...inner, id: "outer", childObjectIds: [inner.id, caption.id] };
    const nested = applyPatches(grouped, [
      { op: "addObject", pageId: page.id, object: outer },
      { op: "setSelection", pageId: page.id, objectIds: [outer.id] }
    ]);

    const scope = copyAsScopeObjects(nested);
    expect(scope.map((object) => object.id)).toEqual([molecule.id, caption.id]);
    expect(copyAsScopeMolecules(nested).map((object) => object.id)).toEqual([molecule.id]);
    const scoped = copyAsScopedDocument(nested);
    // Compare with the same user artwork selected directly: geometry translates exactly once.
    const direct = { ...document, pages: [{ ...page, objects: [molecule, caption] }],
      selection: { ...document.selection, objectIds: [molecule.id, caption.id] } };
    expect(scoped.pages).toEqual(copyAsScopedDocument(direct).pages);
    const svg = (await exportPhase4Svg(scoped, { includeWarnings: false })).contents;
    expect(svg).toContain("Grouped artwork");
    expect(svg).toContain('data-object-id="' + molecule.id + '"');
    expect(svg).not.toContain("Outside");

    const deselected = { ...nested, selection: { ...nested.selection, objectIds: [] } };
    expect(copyAsScopeObjects(deselected)).toEqual(nested.pages[0]!.objects.filter((object) => object.type !== "group"));
  });

  it.each(["cholesterol", "morphine"])("copies recipe-11 %s with its molecule, ring letters and fills", async (name) => {
    const script = new URL("../../../skills/chemdraft/scripts/ring-style.mjs", import.meta.url).href;
    const { style } = await import(script) as {
      style(doc: ChemDraftDocument, build: unknown): { carbon: ChemDraftDocument; picture: ChemDraftDocument }
    };
    // Morphine includes the outer-ring path that must travel along with its molecule and letters.
    const fixture = new URL(`../../../tools/agent-skill/fixtures/ring-style/${name}.json`, import.meta.url);
    const buildFixture = new URL(`../../../tools/agent-skill/fixtures/ring-style/${name}-build.jsonl`, import.meta.url);
    const document = JSON.parse(readFileSync(fixture, "utf8")) as ChemDraftDocument;
    const build = JSON.parse(readFileSync(buildFixture, "utf8").trim()).molecules[0];
    const { carbon, picture } = style(document, build);
    for (const drawing of [carbon, picture]) {
      const page = drawing.pages[0]!;
      const group = page.objects.find((object): object is GroupObject => object.type === "group")!;
      const artwork = page.objects.filter((object) => object.type !== "group");
      if (name === "morphine") expect(artwork.some((object) => object.type === "graphic")).toBe(true);
      expect(copyAsScopeObjects(drawing)).toEqual(artwork);
      expect(copyAsScopeObjects(drawing).map((object) => object.id)).toEqual(group.childObjectIds);
      const copied = copyAsScopedDocument(drawing);
      const directlySelected = { ...drawing, pages: [{ ...page, objects: artwork }],
        selection: { ...drawing.selection, objectIds: artwork.map((object) => object.id) } };
      expect(copied.pages).toEqual(copyAsScopedDocument(directlySelected).pages);
      expect(copied.pages[0]!.width).toBeGreaterThan(32);
      expect(copied.pages[0]!.height).toBeGreaterThan(32);
      const svg = (await exportPhase4Svg(copied, { includeWarnings: false })).contents;
      for (const object of artwork) expect(svg).toContain('data-object-id="' + object.id + '"');
      expect(svg).toContain("<path");
      expect(svg).toContain("<text");
      expect(svg).toContain('data-molecule-fill-ring="true"');
    }
  });
});

// Independent corner rotation: expected bounds must not reuse the crop's geometry helpers.
function rotatedFrameBounds(object: DocumentObject) {
  const cx = object.x + object.width / 2, cy = object.y + object.height / 2;
  const radians = object.rotation * Math.PI / 180;
  const corners = [[object.x, object.y], [object.x + object.width, object.y],
    [object.x + object.width, object.y + object.height], [object.x, object.y + object.height]];
  const points = corners.map(([x, y]) => ({
    x: cx + (x! - cx) * Math.cos(radians) - (y! - cy) * Math.sin(radians),
    y: cy + (x! - cx) * Math.sin(radians) + (y! - cy) * Math.cos(radians)
  }));
  return { left: Math.min(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)),
    right: Math.max(...points.map(p => p.x)), bottom: Math.max(...points.map(p => p.y)) };
}

function picture(rotation: number) {
  return { ...createImageGraphicObject({
    id: "picture", mimeType: "image/svg+xml", center: { x: 400, y: 400 },
    dataBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200"/></svg>').toString("base64")
  }), rotation };
}

function expectPaddedFrames(document: ChemDraftDocument) {
  const objects = copyAsScopeObjects(document);
  const bounds = objects.map(rotatedFrameBounds);
  const left = Math.min(...bounds.map(b => b.left)), top = Math.min(...bounds.map(b => b.top));
  const right = Math.max(...bounds.map(b => b.right)), bottom = Math.max(...bounds.map(b => b.bottom));
  const copied = copyAsScopedDocument(document);
  const page = copied.pages[0]!;
  // Graphic visual bounds round to three decimal places.
  expect(page.width).toBeCloseTo(right - left + 32, 2);
  expect(page.height).toBeCloseTo(bottom - top + 32, 2);
  for (const object of page.objects) {
    const original = objects.find(candidate => candidate.id === object.id)!;
    expect(object.x).toBeCloseTo(original.x + 16 - left, 2);
    expect(object.y).toBeCloseTo(original.y + 16 - top, 2);
    expect(object.rotation).toBe(original.rotation);
    const box = rotatedFrameBounds(object);
    expect(box.left).toBeGreaterThanOrEqual(16 - 0.001);
    expect(box.top).toBeGreaterThanOrEqual(16 - 0.001);
    expect(box.right).toBeLessThanOrEqual(page.width - 16 + 0.001);
    expect(box.bottom).toBeLessThanOrEqual(page.height - 16 + 0.001);
  }
  return copied;
}

describe("Copy As rotated content crop", () => {
  it.each([90, 30])("contains a 2:1 picture rotated %s degrees beside a ring with 16-unit padding", async rotation => {
    const document = insertNativeTemplateMolecule(createPhase4Document(), { x: 110, y: 350 }, "cyclohexane");
    const image = picture(rotation);
    expect(image.width).toBe(400);
    expect(image.height).toBe(200);
    const page = document.pages[0]!;
    const withImage = applyPatches(document, [
      { op: "addObject", pageId: page.id, object: image },
      { op: "setSelection", pageId: page.id, objectIds: [...document.selection.objectIds, image.id] }
    ]);
    const before = structuredClone(withImage);
    const copied = expectPaddedFrames(withImage);
    expect(withImage).toEqual(before);
    const svg = (await exportPhase4Svg(copied, { includeWarnings: false })).contents;
    expect(svg).toContain("<image");
    expect(svg).toContain(`rotate(${rotation} `);
    expect(svg).toContain('data-object-id="' + page.objects[0]!.id + '"');
    // Content crop also calls this function with the selection cleared.
    expect(copyAsScopedDocument({ ...withImage, selection: { ...withImage.selection, objectIds: [] } }).pages)
      .toEqual(copied.pages);
  });

  it.each([90, 30])("contains text rotated %s degrees around its stored frame centre", rotation => {
    const document = createPhase4Document();
    const text: TextObject = { id: "rotated-text", type: "text", text: "Rotated caption", spans: [],
      x: 250, y: 300, width: 240, height: 24, rotation, style: {} };
    expectPaddedFrames(applyPatches(document, [{ op: "addObject", pageId: document.pages[0]!.id, object: text }]));
  });

  it("contains a molecule with stored rotation and translates its atoms by the same delta", () => {
    const document = insertNativeSingleBondMolecule(createPhase4Document(), { x: 300, y: 300 });
    const molecule = document.pages[0]!.objects.find(object => object.type === "molecule")!;
    const rotated = applyPatches(document, [{ op: "updateObject", objectId: molecule.id, changes: { rotation: 90 } }]);
    const copied = expectPaddedFrames(rotated);
    const moved = copied.pages[0]!.objects.find(object => object.type === "molecule")!;
    expect(moved.bonds).toEqual(molecule.bonds);
    expect(moved.atoms).toEqual(molecule.atoms.map(atom => ({ ...atom,
      x: atom.x + moved.x - molecule.x, y: atom.y + moved.y - molecule.y })));
  });

  it("keeps the exact legacy page size and translation for zero-degree objects", () => {
    const document = insertNativeTemplateMolecule(createPhase4Document(), { x: 110, y: 350 }, "cyclohexane");
    const page = document.pages[0]!;
    const text: TextObject = { id: "caption", type: "text", text: "Unrotated", spans: [],
      x: 180, y: 560, width: 240, height: 24, rotation: 0, style: {} };
    const source = applyPatches(document, [
      { op: "addObject", pageId: page.id, object: picture(0) },
      { op: "addObject", pageId: page.id, object: text },
      { op: "setSelection", pageId: page.id, objectIds: [] }
    ]);
    const objects = source.pages[0]!.objects;
    const minX = Math.min(...objects.map(o => o.x)), minY = Math.min(...objects.map(o => o.y));
    const maxX = Math.max(...objects.map(o => o.x + o.width)), maxY = Math.max(...objects.map(o => o.y + o.height));
    const copied = copyAsScopedDocument(source).pages[0]!;
    expect(copied.width).toBe(maxX - minX + 32);
    expect(copied.height).toBe(maxY - minY + 32);
    expect(copied.objects).toEqual(objects.map(object => ({ ...object,
      x: object.x + (16 - minX), y: object.y + (16 - minY),
      ...(object.type === "molecule" ? { atoms: object.atoms.map(atom => ({ ...atom,
        x: atom.x + (16 - minX), y: atom.y + (16 - minY) })) } : {})
    })));
  });
});
