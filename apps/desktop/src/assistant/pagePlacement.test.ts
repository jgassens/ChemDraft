import { describe, expect, it } from "vitest";
import { createSmilesMolecule } from "@chemdraft/document-workflow-core";
import { depictSmiles2D } from "@chemdraft/ocl-adapter";
import type { DocumentObject } from "@chemdraft/chem-core";
import { testContext } from "./tools/testContext";
import { callAssistantTool } from "./assistantTools";
import { objectRect, overlaps, pageContentRect } from "./placement";
import { translateObject } from "./writeBuilder";

function setup() {
  const { context } = testContext(false);
  const page = context.getDocument()!.pages[0]!;
  Object.assign(page, { width: 612, height: 792, margin: { top: 36, right: 36, bottom: 36, left: 36 } });
  Object.assign(page.layout, { presetId: "custom", widthPx: 612, heightPx: 792,
    marginTopPx: 36, marginRightPx: 36, marginBottomPx: 36, marginLeftPx: 36 });
  const caffeine = "Cn1c(=O)c2c(ncn2C)n(C)c1=O";
  const existing = createSmilesMolecule(context.getDocument()!, { x: 0, y: 0 }, depictSmiles2D(caffeine), caffeine);
  const bounds = objectRect(existing);
  page.objects = [translateObject(existing, 36 - bounds.x, 36 - bounds.y)];
  let index = 0;
  context.chemistry.structureFromSmiles = async () => {
    // Synthetic 16-member macrocycle; depiction retains the document's 28px bond length.
    const count = index++ % 2 ? 14 : 16;
    const object = createSmilesMolecule(context.getDocument()!, { x: 0, y: 0 }, {
      atoms: Array.from({ length: count }, (_, i) => ({ element: "C", charge: 0,
        x: Math.cos(2 * Math.PI * i / count), y: Math.sin(2 * Math.PI * i / count) })),
      bonds: Array.from({ length: count }, (_, i) => ({ from: i, to: (i + 1) % count, order: "single" as const, wedge: null }))
    }, "CC");
    return { available: true, built: true, object };
  };
  return { context, page };
}

function assertInsideAndClear(objects: DocumentObject[]) {
  const rects = objects.map(objectRect);
  for (const rect of rects) {
    expect(rect.x).toBeGreaterThanOrEqual(36 - 1e-6);
    expect(rect.y).toBeGreaterThanOrEqual(36 - 1e-6);
    expect(rect.x + rect.width).toBeLessThanOrEqual(576 + 1e-6);
    expect(rect.y + rect.height).toBeLessThanOrEqual(756 + 1e-6);
  }
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    expect(overlaps(rects[i]!, rects[j]!)).toBe(false);
  }
}

describe("assistant page-aware arrangement", () => {
  it("keeps a rounded full-width A3 caption on the page without requesting growth", async () => {
    const { context, page } = setup();
    Object.assign(page, { width: 297 * 96 / 25.4, height: 420 * 96 / 25.4,
      margin: { top: 72, right: 72, bottom: 72, left: 72 }, objects: [] });
    Object.assign(page.layout, { widthPx: page.width, heightPx: page.height,
      marginTopPx: 72, marginRightPx: 72, marginBottomPx: 72, marginLeftPx: 72 });
    const text = "A descriptive caption ".repeat(30);
    const result = await callAssistantTool(context, "insert_text", { text });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(context.confirmPageGrowth).not.toHaveBeenCalled();
    const objects = context.getDocument()!.pages[0]!.objects;
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({ type: "text", text });
    const rect = objectRect(objects[0]!);
    const content = pageContentRect(page);
    expect(rect.width).toBeLessThanOrEqual(content.width);
    expect(rect.x + rect.width).toBeLessThanOrEqual(content.x + content.width);
    expect(rect.y + rect.height).toBeLessThanOrEqual(content.y + content.height);
  });

  it.each(["row", "grid", "auto"])("keeps a fitting %s batch within the visible viewport", async arrangement => {
    const { context, page } = setup();
    Object.assign(page, { width: 2000, height: 2000,
      margin: { top: 72, right: 72, bottom: 72, left: 72 }, objects: [] });
    Object.assign(page.layout, { widthPx: page.width, heightPx: page.height,
      marginTopPx: 72, marginRightPx: 72, marginBottomPx: 72, marginLeftPx: 72 });
    context.getViewportRect = () => ({ x: 900, y: 900, width: 400, height: 400 });
    const result = await callAssistantTool(context, "insert_structures", { arrangement,
      items: [{ kind: "text", text: "First" }, { kind: "text", text: "Second" }] });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(context.confirmPageGrowth).not.toHaveBeenCalled();
    const objects = context.getDocument()!.pages[0]!.objects;
    expect(objects).toHaveLength(2);
    for (const rect of objects.map(objectRect)) {
      expect(rect.x).toBeGreaterThanOrEqual(900);
      expect(rect.y).toBeGreaterThanOrEqual(900);
      expect(rect.x + rect.width).toBeLessThanOrEqual(1300);
      expect(rect.y + rect.height).toBeLessThanOrEqual(1300);
    }
    expect(overlaps(objectRect(objects[0]!), objectRect(objects[1]!))).toBe(false);
  });

  it("wraps a long caption inside the page without changing its text or molecule size", async () => {
    const { context } = setup();
    const label = "A descriptive macrocycle caption ".repeat(8);
    const result = await callAssistantTool(context, "insert_structures", { items: [{ kind: "molecule", smiles: "CC", label }] });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent?.warnings).toEqual([]);
    expect(context.confirmPageGrowth).not.toHaveBeenCalled();
    const objects = context.getDocument()!.pages[0]!.objects;
    assertInsideAndClear(objects);
    expect(objects[2]).toMatchObject({ type: "text", text: label });
  });
  it.each(["row", "grid", "auto"])("wraps five macrocycles with their labels in %s around existing content", async arrangement => {
    const { context } = setup();
    const result = await callAssistantTool(context, "insert_structures", { arrangement,
      items: Array.from({ length: 5 }, (_, i) => ({ kind: "molecule", smiles: "CC", label: `Ring ${i + 1}` })) });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent?.warnings, JSON.stringify(context.getDocument()!.pages[0]!.objects.map(objectRect))).toEqual([]);
    const objects = context.getDocument()!.pages[0]!.objects;
    assertInsideAndClear(objects);
    for (let i = 1; i < objects.length; i += 2) {
      const molecule = objectRect(objects[i]!);
      const label = objectRect(objects[i + 1]!);
      expect(label.x + label.width / 2).toBeCloseTo(molecule.x + molecule.width / 2);
      expect(label.y - molecule.y - molecule.height).toBeCloseTo(8);
      const object = objects[i]!;
      if (object.type !== "molecule") throw new Error("molecule required");
      expect(Math.hypot(object.atoms[0]!.x - object.atoms[1]!.x, object.atoms[0]!.y - object.atoms[1]!.y)).toBeCloseTo(28);
    }
  });

  it("asks once for a wrapped set running off the bottom and retains only fitting cells on refusal", async () => {
    const { context } = setup();
    const result = await callAssistantTool(context, "insert_structures", { arrangement: "grid", items: [
      ...Array.from({ length: 16 }, (_, i) => ({ kind: "molecule", smiles: "CC", label: `Component ${i + 1}` })),
      { kind: "text", text: "M6L4 cage" }, { kind: "text", text: "Schematic components" }
    ] });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const objects = context.getDocument()!.pages[0]!.objects.slice(1);
    expect(context.confirmPageGrowth).toHaveBeenCalledTimes(1);
    expect(context.confirmPageGrowth).toHaveBeenCalledWith(expect.objectContaining({ height: expect.any(Number) }), expect.any(AbortSignal));
    expect(result.structuredContent).toMatchObject({ declined: expect.arrayContaining([expect.stringMatching(/^Component /)]),
      reason: "declined: the user chose not to enlarge the page", warnings: [] });
    expect(objects.length).toBeGreaterThan(0);
    expect(objects.length).toBeLessThan(34);
    expect(context.getDocument()!.pages[0]!.height).toBe(792);
    assertInsideAndClear(context.getDocument()!.pages[0]!.objects);
  });

  it("keeps labels with molecules when arranging an existing insertion again", async () => {
    const { context } = setup();
    const inserted = await callAssistantTool(context, "insert_structures", { items: Array.from({ length: 5 }, (_, i) => ({ kind: "molecule", smiles: "CC", label: `Ring ${i}` })) });
    const result = await callAssistantTool(context, "move_objects", { objectIds: inserted.structuredContent!.objectIds, to: { arrange: "row" } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent?.warnings).toEqual([]);
    const objects = context.getDocument()!.pages[0]!.objects;
    assertInsideAndClear(objects);
    for (let i = 1; i < objects.length; i += 2) expect(objectRect(objects[i + 1]!).y - objectRect(objects[i]!).y - objectRect(objects[i]!).height).toBeCloseTo(8);
  });
});
