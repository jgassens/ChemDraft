import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPatches, type ChemDraftDocument, type GroupObject, type TextObject } from "@chemdraft/chem-core";
import {
  copyAsScopeMolecules, copyAsScopeObjects, copyAsScopedDocument, createPhase4Document, exportPhase4Svg,
  groupSelectedDocumentObjects, insertNativeSingleBondMolecule
} from "./documentWorkflow";

describe("Copy As grouped artwork", () => {
  it("copies a user-made group recursively, in paint order, without unrelated artwork", () => {
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
    const svg = exportPhase4Svg(scoped, { includeWarnings: false }).contents;
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
      const svg = exportPhase4Svg(copied, { includeWarnings: false }).contents;
      for (const object of artwork) expect(svg).toContain('data-object-id="' + object.id + '"');
      expect(svg).toContain("<path");
      expect(svg).toContain("<text");
      expect(svg).toContain('data-molecule-fill-ring="true"');
    }
  });
});
