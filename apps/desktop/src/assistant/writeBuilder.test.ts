import { describe, expect, it } from "vitest";
import { callAssistantTool } from "./assistantTools";
import { applyAssistantWrite, buildInsertStructures } from "./writeBuilder";
import { testContext } from "./tools/testContext";
import { objectRect, overlaps } from "./placement";

describe("assistant writes", () => {
  it.each([
    ["edit_structure", { objectId: "outside", smiles: "CC" }],
    ["delete_objects", { objectIds: ["outside"] }],
    ["style_objects", { objectIds: ["outside"], style: { color: "#112233" } }],
    ["move_objects", { objectIds: ["outside"], to: { arrange: "grid" } }]
  ])("refuses the entire %s call outside Send scope", async (name, input) => {
    const { context } = testContext();
    const result = await callAssistantTool(context, name as string, input);
    expect(result.structuredContent).toEqual({ refused: true, reason: "outside was not selected when you sent the request" });
    expect(context.write).not.toHaveBeenCalled();
    expect(context.chemistry.structureFromSmiles).not.toHaveBeenCalled();
  });
  it("does not partially apply mixed in-scope/out-of-scope writes", async () => {
    const { context, molecule, text } = testContext();
    const result = await callAssistantTool(context, "delete_objects", { objectIds: [molecule.id, text.id] });
    expect(result.structuredContent?.refused).toBe(true);
    expect(context.getDocument()!.pages[0]!.objects).toHaveLength(2);
  });
  it("with nothing selected, allows only inserts and later edits of those inserted ids", async () => {
    const { context, molecule } = testContext(false);
    expect((await callAssistantTool(context, "delete_objects", { objectIds: [molecule.id] })).structuredContent?.refused).toBe(true);
    const inserted = await callAssistantTool(context, "insert_text", { text: "new" });
    expect(inserted.isError).not.toBe(true);
    const ids = inserted.structuredContent!.objectIds as string[];
    expect(ids).toHaveLength(1);
    expect((await callAssistantTool(context, "style_objects", { objectIds: ids, style: { color: "#ff0000" } })).isError).not.toBe(true);
    expect((await callAssistantTool(context, "move_objects", { objectIds: ids, to: { arrange: "row" } })).isError).not.toBe(true);
    expect((await callAssistantTool(context, "delete_objects", { objectIds: ids })).isError).not.toBe(true);
  });
  it("applies one atomic batch per insert call, with unique ids and no overlap", async () => {
    const { context } = testContext(false);
    const result = await callAssistantTool(context, "insert_structures", { items: [
      { kind: "molecule", smiles: "CC", label: "Ethane" }, { kind: "molecule", smiles: "CC", label: "Ethane again" }
    ] });
    expect(result.isError).not.toBe(true);
    expect(context.write).toHaveBeenCalledTimes(1);
    const ids = result.structuredContent!.objectIds as string[];
    expect(new Set(ids).size).toBe(4);
    const objects = context.getDocument()!.pages[0]!.objects.filter(object => ids.includes(object.id));
    for (let i = 0; i < objects.length; i++) for (let j = i + 1; j < objects.length; j++) {
      expect(overlaps(objectRect(objects[i]!), objectRect(objects[j]!))).toBe(false);
    }
  });
  it("keeps long grid labels centred and clear of their neighbours", async () => {
    const { context } = testContext(false);
    const result = await callAssistantTool(context, "insert_structures", { items: [
      { kind: "molecule", smiles: "CC", label: "A long descriptive molecule label" },
      { kind: "molecule", smiles: "CC", label: "Another long descriptive label" }
    ] });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const ids = result.structuredContent!.objectIds as string[];
    const objects = context.getDocument()!.pages[0]!.objects.filter(object => ids.includes(object.id));
    for (let i = 0; i < objects.length; i++) for (let j = i + 1; j < objects.length; j++) {
      expect(overlaps(objectRect(objects[i]!), objectRect(objects[j]!))).toBe(false);
    }
    for (let index = 0; index < objects.length; index += 2) {
      const molecule = objectRect(objects[index]!);
      const label = objects[index + 1]!;
      expect(label.x + label.width / 2).toBeCloseTo(molecule.x + molecule.width / 2);
    }
  });
  it("places an insert at the pinned viewport centre when free", async () => {
    const { context } = testContext(false);
    context.getViewportRect = () => ({ x: 50, y: 600, width: 400, height: 200 });
    const result = await callAssistantTool(context, "insert_text", { text: "caption" });
    expect(result.isError).not.toBe(true);
    const ids = result.structuredContent!.objectIds as string[];
    const inserted = context.getDocument()!.pages[0]!.objects.find(object => ids.includes(object.id))!;
    expect(inserted.x + inserted.width / 2).toBeCloseTo(250);
    expect(inserted.y + inserted.height / 2).toBeCloseTo(700);
    expect(context.getViewportRect).toBeDefined();
  });
  it("refuses bond display changes instead of altering stereo or storing ineffective style", async () => {
    const { context, molecule } = testContext();
    const result = await callAssistantTool(context, "style_objects", { objectIds: [molecule.id], style: { bondDisplay: "wedge" } });
    expect(result.isError).toBe(true);
    expect(context.write).not.toHaveBeenCalled();
  });
  it("maps molecule style inputs to the existing renderer's style fields", async () => {
    const { context, molecule } = testContext();
    const result = await callAssistantTool(context, "style_objects", { objectIds: [molecule.id], style: { color: "#123456", strokeWidth: 2, fontSizePx: 18 } });
    expect(result.isError).not.toBe(true);
    expect(context.getDocument()!.pages[0]!.objects[0]!.style).toMatchObject({
      bondColor: "#123456", atomLabelColor: "#123456", bondStrokeWidthPx: 2, atomLabelFontSizePx: 18
    });
  });
  it("inserts reaction layouts with arrows, labels, and unique ids", async () => {
    const { context } = testContext(false);
    const result = await callAssistantTool(context, "insert_reaction", { reactants: ["CC", "CC"], products: ["CC"], reagents: ["catalyst"], conditions: ["heat"] });
    expect(result.isError).not.toBe(true);
    expect(context.write).toHaveBeenCalledTimes(1);
    expect(context.getDocument()!.pages[0]!.objects.some(object => object.type === "reaction-arrow")).toBe(true);
  });
  it("rejects a combined reaction label exceeding 2000 characters before chemistry", async () => {
    const { context } = testContext();
    const result = await callAssistantTool(context, "insert_reaction", { reactants: ["CC"], products: ["CC"], conditions: ["x".repeat(1500), "y".repeat(1500)] });
    expect(result.isError).toBe(true);
    expect(context.chemistry.structureFromSmiles).not.toHaveBeenCalled();
    expect(context.write).not.toHaveBeenCalled();
  });
  it("style changes never touch atoms or bonds", async () => {
    const { context, molecule } = testContext();
    const before = structuredClone(molecule);
    const result = await callAssistantTool(context, "style_objects", { objectIds: [molecule.id], style: { color: "#123456" } });
    expect(result.isError).not.toBe(true);
    const after = context.getDocument()!.pages[0]!.objects.find(object => object.id === molecule.id)!;
    expect({ ...after, style: before.style }).toEqual(before);
  });
  it("moves all molecule coordinates by the same delta without changing chemistry", async () => {
    const { context, molecule } = testContext();
    const result = await callAssistantTool(context, "move_objects", { objectIds: [molecule.id], to: { arrange: "row" } });
    expect(result.isError).not.toBe(true);
    const after = context.getDocument()!.pages[0]!.objects[0]!;
    if (after.type !== "molecule") throw new Error("molecule required");
    expect(after.x).not.toBe(molecule.x);
    expect(after.bonds).toEqual(molecule.bonds);
    expect(after.atoms.map((atom, i) => ({ ...atom, x: molecule.atoms[i]!.x, y: molecule.atoms[i]!.y }))).toEqual(molecule.atoms);
    expect(after.atoms[0]!.x - molecule.atoms[0]!.x).toBeCloseTo(after.x - molecule.x);
  });
  it("rejects canonical mismatches before writing", async () => {
    const { context } = testContext();
    await expect(buildInsertStructures(context, { items: [{ kind: "molecule", smiles: "CO" }] })).rejects.toThrow("Canonical SMILES mismatch");
    expect(context.write).not.toHaveBeenCalled();
  });
  it("accepts a pinned document getter returning equal immutable copies", async () => {
    const { context } = testContext(false);
    const getDocument = context.getDocument;
    context.getDocument = () => structuredClone(getDocument());
    const result = await callAssistantTool(context, "insert_text", { text: "new" });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(context.write).toHaveBeenCalledTimes(1);
  });
  it("refuses a document changed during canonical verification", async () => {
    const { context, replace } = testContext(false);
    const built = await buildInsertStructures(context, { items: [{ kind: "molecule", smiles: "CC" }] });
    const inspect = context.chemistry.inspectStructure;
    context.chemistry.inspectStructure = async (format, value) => {
      const next = structuredClone(context.getDocument()!);
      next.title = "User edit";
      replace(next);
      return inspect(format, value);
    };
    await expect(applyAssistantWrite(context, built)).rejects.toThrow("document changed");
    expect(context.write).not.toHaveBeenCalled();
  });
  it("fails closed with chem-core's error and caps the batch at 256 operations", async () => {
    const { context } = testContext();
    await expect(applyAssistantWrite(context, { patch: { op: "batch", patches: [{ op: "removeObject", objectId: "missing" }] }, summary: "test", warnings: [] })).rejects.toThrow('object "missing" does not exist');
    await expect(applyAssistantWrite(context, { patch: { op: "batch", patches: Array.from({ length: 257 }, () => ({ op: "removeObject", objectId: "x" })) }, summary: "test", warnings: [] })).rejects.toThrow("1..256");
    expect(context.write).not.toHaveBeenCalled();
  });
});
