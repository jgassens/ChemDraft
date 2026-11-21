// @vitest-environment jsdom
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it, vi } from "vitest";
import {
  ArrowObjectSchema, createEmptyDocument, GroupObjectSchema, MoleculeObjectSchema, TextObjectSchema,
  type DocumentObject
} from "@chemdraft/chem-core";
import { chemicalIdentitySource } from "@chemdraft/document-workflow-core";
import { moleculeLayoutLabelBoxes } from "@chemdraft/layout-engine";
import { PluginRequestLimits, PluginMeasureDepictionResultSchema, PluginRenderRegionResultSchema } from "@chemdraft/plugin-api";
import type { RequestDepictionBinding } from "@chemdraft/plugin-host";
import { measure } from "./measureRegion";
import { createRenderRegion } from "./renderRegion";

const createBinding = (...objects: DocumentObject[]): RequestDepictionBinding => {
  const document = createEmptyDocument();
  return { document: { ...document, pages: [{ ...document.pages[0]!, objects }] },
    signal: new AbortController().signal, revision: () => "revision", check: () => {} };
};
const query = (binding: RequestDepictionBinding) => ({ requestId: "request", pageId: binding.document.pages[0]!.id });

function longLabel() {
  return MoleculeObjectSchema.parse({ id: "compound", type: "molecule", x: 90, y: 95, width: 20, height: 10,
    rotation: 90, structure: "", structureFormat: "unknown", atoms: [
      { id: "long-label", x: 100, y: 100, element: "N(CH3)2[Cu(NH3)4]", labelLiteral: true }
    ] });
}

describe("depiction measurement", () => {
  it("returns a rotated glyph rectangle in page space keyed by the native atom ID", () => {
    const molecule = longLabel();
    const binding = createBinding(molecule);
    const result = measure({ ...query(binding), target: { kind: "objects", objectIds: [molecule.id] } }, binding);
    expect(PluginMeasureDepictionResultSchema.safeParse(result).success).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const atom = result.value.objects[0]?.atomLabels?.[0];
    const unrotated = moleculeLayoutLabelBoxes({ ...molecule, rotation: 0 })[0]!;
    expect(atom?.atomId).toBe("long-label");
    expect(atom?.bounds.width).toBeCloseTo(unrotated.height);
    expect(atom?.bounds.height).toBeCloseTo(unrotated.width);
    expect(atom?.bounds.x).toBeCloseTo(200 - unrotated.y - unrotated.height);
    expect(atom?.bounds.y).toBeCloseTo(unrotated.x);
    expect(result.value.bounds?.height).toBeGreaterThan(molecule.height);
  });

  it("uses arrow ink and resolved condition text, and lists unsupported object kinds", () => {
    const arrow = ArrowObjectSchema.parse({ id: "arrow", type: "reaction-arrow", arrowKind: "forward", x: 100, y: 100, width: 60,
      height: 8, start: { kind: "point", point: { x: 100, y: 104 } }, end: { kind: "point", point: { x: 160, y: 104 } } });
    const conditions = TextObjectSchema.parse({ id: "conditions", type: "text", x: 5, y: 5, width: 10, height: 10, text: "solvent, heat",
      arrowAttachment: { kind: "conditions", parentObjectId: arrow.id, side: "above", placement: "manual",
        frame: { origin: { x: 30, y: 30 }, tangent: { x: 1, y: 0 }, normal: { x: 0, y: -1 } }, offset: { x: 0, y: 30 } } });
    const group = GroupObjectSchema.parse({ id: "group", type: "group", x: 100, y: 100, width: 60, height: 20, childObjectIds: [arrow.id] });
    const binding = createBinding(arrow, conditions, group);
    const result = measure({ ...query(binding), target: { kind: "objects", objectIds: ["arrow", "conditions", "group"] } }, binding);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.unsupported).toEqual([{ objectId: "group", type: "group" }]);
    const [shaft, label] = result.value.objects;
    expect(shaft?.bounds?.x).toBeLessThan(arrow.x);
    expect(label?.labelBounds).toEqual(label?.bounds);
    expect(label?.bounds?.x).toBeGreaterThan(100);
    expect(label?.bounds?.width).toBeGreaterThan(conditions.width);
    expect(label?.bounds?.y).toBeLessThan(arrow.y);
    const region = measure({ ...query(binding), target: { kind: "region",
      bounds: { x: 129, y: 100, width: 2, height: 8 } } }, binding);
    expect(region).toMatchObject({ ok: true, value: { objects: [{ objectId: "arrow" }] } });
  });

  it("applies validated proposed batches to a detached draft and reports new objects by their authored IDs", () => {
    const text = TextObjectSchema.parse({ id: "caption", type: "text", x: 50, y: 50, width: 10, height: 10, text: "a caption" });
    const addition = { ...text, id: "proposed", y: 125 };
    const binding = createBinding(text);
    const original = JSON.stringify(binding.document);
    const input = { ...query(binding), target: { kind: "objects", objectIds: ["caption", "proposed"] } as const };
    const result = measure({ ...input, target: { ...input.target, objectIds: [...input.target.objectIds] },
      preview: { op: "batch", patches: [
        { op: "addObject", pageId: input.pageId, object: addition },
        { op: "moveObject", objectId: text.id, x: 220, y: 210 }
      ] } }, binding);
    expect(result).toMatchObject({ ok: true, value: { objects: [
      { objectId: "caption", bounds: { x: 220 } }, { objectId: "proposed", bounds: { x: 50 } }
    ] } });
    expect(JSON.stringify(binding.document)).toBe(original);
    expect(() => measure({ ...query(binding), target: { kind: "objects", objectIds: ["caption"] },
      preview: { op: "updateObject", objectId: text.id, changes: { text: 42 } as never } }, binding))
      .toThrow("Invalid depiction preview");
  });
});

describe("bounded PNG region", () => {
  const rasterize = vi.fn(async (svg: string) => {
    const rendered = new Resvg(svg).render();
    return { bytes: rendered.asPng(), width: rendered.width, height: rendered.height, warnings: [] };
  });
  const render = createRenderRegion(rasterize);

  it("refuses invalid rectangles and excessive pixel requests before reaching the rasterizer", async () => {
    rasterize.mockClear();
    const binding = createBinding();
    const request = { ...query(binding), widthPx: 10, heightPx: 10 };
    for (const bounds of [
      { x: 0, y: 0, width: 0, height: 1 }, { x: 0, y: 0, width: 1, height: -1 },
      { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1 }
    ]) {
      const target = { kind: "region" as const, bounds };
      await expect(render({ ...request, target }, binding)).rejects.toMatchObject({ code: "invalid" });
      expect(() => measure({ ...query(binding), target }, binding)).toThrow("finite rectangle");
    }
    await expect(render({ ...request, widthPx: 3000, heightPx: 3000,
      target: { kind: "region", bounds: { x: 0, y: 0, width: 10, height: 10 } } }, binding))
      .rejects.toMatchObject({ code: "limit" });
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("crops the exported draft, preserves requested pixel dimensions, and filters unrequested object ink", async () => {
    const molecule = longLabel();
    const other = TextObjectSchema.parse({ id: "unselected", type: "text", x: 90, y: 95, width: 10, height: 10, text: "excluded" });
    const binding = createBinding(molecule, other);
    const input = { ...query(binding), widthPx: 44, heightPx: 87 };
    const rendered = await render({ ...input, target: { kind: "objects", objectIds: [molecule.id] },
      preview: { op: "updateObject", objectId: molecule.id, changes: { rotation: 0 } } }, binding);
    expect(PluginRenderRegionResultSchema.safeParse(rendered).success).toBe(true);
    expect(rendered).toMatchObject({ ok: true, value: { widthPx: 44, heightPx: 87, mimeType: "image/png" } });
    const svg = rasterize.mock.lastCall?.[0];
    expect(svg).toContain('data-object-id="compound"');
    expect(svg).not.toContain('data-object-id="unselected"');
    expect(svg).not.toContain('transform="rotate(90');
    expect(binding.document.pages[0]!.objects[0]).toBe(molecule);
  });

  it("renders a small crop without serializing the stored molfile on every bond", async () => {
    const atoms = Array.from({ length: 40 }, (_, i) => ({ id: String(i), element: "C", x: 10 * i, y: 20 }));
    const bonds = atoms.slice(1).map((atom, i) => ({ id: `bond-${i}`, fromAtomId: atoms[i]!.id, toAtomId: atom.id, order: "single" }));
    const molecule = MoleculeObjectSchema.parse({ ...longLabel(), atoms, bonds, rotation: 0, structureFormat: "molfile-v3000" });
    const lines = chemicalIdentitySource(molecule, [], "v3000").molfile.split("\n");
    lines[0] = "stored molfile";
    lines[2] = "long annotation ".repeat(40_000);
    const binding = createBinding({ ...molecule, structure: lines.join("\n") });
    const result = await render({ ...query(binding), widthPx: 12, heightPx: 8,
      target: { kind: "region", bounds: { x: 0, y: 16, width: 12, height: 8 } } }, binding);
    expect(result.ok).toBe(true);
    expect(rasterize).toHaveBeenLastCalledWith(expect.any(String), "png",
      expect.objectContaining({ maxPngBytes: PluginRequestLimits.pngBytes }));
    expect(rasterize.mock.lastCall?.[0]).not.toContain("stored molfile");
  });

  it("rejects a result with valid dimensions and a bad PNG chunk CRC", async () => {
    const binding = createBinding(longLabel());
    const corrupted = createRenderRegion(async svg => {
      const png = await rasterize(svg);
      png.bytes[png.bytes.length - 1] ^= 1;
      return png;
    });
    await expect(corrupted({ ...query(binding), widthPx: 40, heightPx: 40,
      target: { kind: "region", bounds: { x: 70, y: 70, width: 60, height: 60 } } }, binding)).rejects.toThrow("CRC");
  });
});
