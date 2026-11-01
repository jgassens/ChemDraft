import { defaultCases, insertionDocument, expectDrawingDefaults } from "../drawingDefaults.testHelpers";
import { describe, expect, it } from "vitest";
import { DocumentObjectSchema, nativeTextStyleFromObjectStyle, type Anchor } from "@chemdraft/chem-core";
import { documentDrawingDefaults, estimateNativeTextLineWidth } from "@chemdraft/document-workflow-core";
import { reactionArrowHeadDepthPx } from "@chemdraft/layout-engine";
import { callAssistantTool } from "./assistantTools";
import { applyAssistantWrite, buildInsertStructures } from "./writeBuilder";
import { testContext } from "./tools/testContext";
import { objectRect, overlaps } from "./placement";

describe("assistant writes", () => {
  const anchorFields = ["mechanism-source", "mechanism-target", "reaction-start", "reaction-end",
    "superatom", "r-group-label", "molecule-superatoms", "molecule-rGroups"] as const;
  const anchorCases = anchorFields.flatMap(field => (["atom", "object", "bond"] as const).map(kind => ({ field, kind })));
  describe.each(["edit_structure", "delete_objects", "move_objects"])("%s anchors", name => {
    it.each(anchorCases)("refuses $field with a $kind anchor, naming the linked object", async ({ field, kind }) => {
      const { context, molecule, replace } = testContext();
      const anchor: Anchor = { kind, objectId: molecule.id, atomId: molecule.atoms[0]!.id, bondId: molecule.bonds[0]!.id };
      const point: Anchor = { kind: "point", point: { x: 100, y: 100 } };
      const base = { id: "linked_object", x: 100, y: 100, width: 20, height: 20 };
      const attachment = { label: "R", attachmentPoints: [anchor] };
      let linked: unknown;
      switch (field) {
        case "mechanism-source": case "mechanism-target":
          linked = { ...base, type: "mechanism-arrow", arrowKind: "full-headed",
            source: field === "mechanism-source" ? anchor : point, target: field === "mechanism-target" ? anchor : point }; break;
        case "reaction-start": case "reaction-end":
          linked = { ...base, type: "reaction-arrow", arrowKind: "forward",
            start: field === "reaction-start" ? anchor : point, end: field === "reaction-end" ? anchor : point }; break;
        case "superatom": linked = { ...base, type: "superatom", label: "R", metadata: attachment }; break;
        case "r-group-label": linked = { ...base, type: "r-group-label", label: "R", display: attachment }; break;
        case "molecule-superatoms": linked = { ...molecule, id: base.id, superatoms: [attachment] }; break;
        case "molecule-rGroups": linked = { ...molecule, id: base.id, rGroups: [attachment] }; break;
      }
      const document = structuredClone(context.getDocument()!);
      document.pages[0]!.objects.push(DocumentObjectSchema.parse(linked));
      replace(document);
      const input = name === "edit_structure" ? { objectId: molecule.id, smiles: "CC" } :
        name === "move_objects" ? { objectIds: [molecule.id], to: { arrange: "row" } } : { objectIds: [molecule.id] };
      const result = await callAssistantTool(context, name, input);
      expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("linked_object") }] });
      expect(context.getDocument()).toEqual(document);
      expect(context.write).not.toHaveBeenCalled();
      expect(context.chemistry.structureFromSmiles).not.toHaveBeenCalled();
    });
  });
  it.each(["edit_structure", "delete_objects", "move_objects"])("refuses %s on molecules with anchored electron marks", async name => {
    const { context, molecule, replace } = testContext();
    const document = structuredClone(context.getDocument()!);
    document.pages[0]!.objects.push({ id: "mark", type: "electron-mark", markKind: "charge", charge: 1,
      x: 250, y: 250, width: 10, height: 10, rotation: 0, style: {},
      anchor: { kind: "atom", objectId: molecule.id, atomId: molecule.atoms[0]!.id } });
    replace(document);
    const input = name === "edit_structure" ? { objectId: molecule.id, smiles: "CC" } :
      name === "move_objects" ? { objectIds: [molecule.id], to: { arrange: "row" } } : { objectIds: [molecule.id] };
    const result = await callAssistantTool(context, name, input);
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("anchored electron marks") }] });
    expect(context.getDocument()).toEqual(document);
    expect(context.write).not.toHaveBeenCalled();
    expect(context.chemistry.structureFromSmiles).not.toHaveBeenCalled();
  });
  it("allows selection and timestamp changes during canonical verification without widening Send scope", async () => {
    const { context, molecule, text, replace } = testContext();
    const built = await buildInsertStructures(context, { items: [{ kind: "molecule", smiles: "CC" }] });
    const inspect = context.chemistry.inspectStructure;
    context.chemistry.inspectStructure = async (format, value) => {
      replace({ ...context.getDocument()!, selection: { objectIds: [text.id] }, updatedAt: "2026-10-22T01:00:00Z" });
      return inspect(format, value);
    };
    await expect(applyAssistantWrite(context, built)).resolves.toMatchObject({ objectIds: [expect.any(String)] });
    expect(context.write).toHaveBeenCalledOnce();
    expect(context.getSelectionAtSend()).toEqual([molecule.id]);
    expect((await callAssistantTool(context, "delete_objects", { objectIds: [text.id] })).structuredContent?.refused).toBe(true);
  });
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
    const result = await callAssistantTool(context, "insert_reaction", { reactants: ["CC", "CC"], products: ["CC"], above: ["reagent"], below: ["solvent"], reagents: ["catalyst"], conditions: ["heat"], caption: "note" });
    expect(result.isError).not.toBe(true);
    expect(context.write).toHaveBeenCalledTimes(1);
    expect(context.getDocument()!.pages[0]!.objects.some(object => object.type === "reaction-arrow")).toBe(true);
    const objects = context.getDocument()!.pages[0]!.objects;
    const arrow = objects.find(object => object.type === "reaction-arrow")!;
    const above = objects.find(object => object.type === "text" && object.text === "reagent\ncatalyst")!;
    const below = objects.find(object => object.type === "text" && object.text === "solvent\nheat")!;
    if (arrow.type !== "reaction-arrow" || above.type !== "text" || below.type !== "text") throw new Error("reaction objects required");
    expect(above.x + above.width / 2).toBeCloseTo(arrow.x + arrow.width / 2);
    const textStyle = nativeTextStyleFromObjectStyle(above.style);
    const widestLabel = Math.max(...[above, below].flatMap(label => label.text.split("\n")
      .map(line => estimateNativeTextLineWidth(line, textStyle))));
    // Reaction labels reserve each head's depth plus 0.25 em, with a 2.5-bond minimum.
    const labelWithHeadRoom = widestLabel + 2 * (reactionArrowHeadDepthPx(arrow.arrowKind) + 0.25 * textStyle.fontSizePx);
    const bondLength = documentDrawingDefaults(context.getDocument()!).bondLengthPx;
    expect(arrow.width).toBeCloseTo(Math.max(2.5 * bondLength, labelWithHeadRoom), 2);
    expect(objects.some(object => object.type === "text" && object.text === "note")).toBe(true);
  });
  it("rejects a combined reaction label exceeding 2000 characters before chemistry", async () => {
    const { context } = testContext();
    const result = await callAssistantTool(context, "insert_reaction", { reactants: ["CC"], products: ["CC"], above: ["x".repeat(1900)], caption: "y".repeat(101) });
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


describe("assistant document drawing defaults", () => {
  it.each(defaultCases)("keeps every reaction molecule at the $bondLengthPx px document default", async style => {
    const { context, replace } = testContext(false);
    const document = insertionDocument(style);
    document.styles.text = { fontSizePx: 18 };
    const defaults = documentDrawingDefaults(document);
    const existing = structuredClone(document.pages[0]!.objects);
    replace(document);
    const result = await callAssistantTool(context, "insert_reaction", {
      reactants: ["CC", "CC"], products: ["CC"], conditions: ["heat"]
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const objects = context.getDocument()!.pages[0]!.objects;
    const molecules = objects.slice(existing.length).filter(object => object.type === "molecule");
    expect(molecules).toHaveLength(3);
    molecules.forEach(object => expectDrawingDefaults(object, style));
    const arrow = objects.find(object => object.type === "reaction-arrow")!;
    const left = objectRect(molecules[1]!);
    const right = objectRect(molecules[2]!);
    expect(arrow.start.point!.x - left.x - left.width).toBeCloseTo(defaults.bondLengthPx);
    expect(right.x - arrow.end.point!.x).toBeCloseTo(defaults.bondLengthPx);
    const plus = objects.find(object => object.type === "text" && object.text === "+");
    if (!plus || plus.type !== "text") throw new Error("Expected a plus-sign text object.");
    expect(nativeTextStyleFromObjectStyle(plus.style).fontSizePx).toBe(defaults.textStyle.fontSizePx);
    expect(objects.slice(0, existing.length)).toEqual(existing);
  });
  it.each(defaultCases)("uses $bondLengthPx px defaults for structures and group labels", async style => {
    const { context, replace } = testContext(false);
    const document = insertionDocument(style);
    replace(document);
    const existing = structuredClone(document.pages[0]!.objects);
    const result = await callAssistantTool(context, "insert_structures", { items: [
      { kind: "molecule", smiles: "CC", label: "Name" }, { kind: "group", label: "Ph" },
      { kind: "text", text: "Standalone" }, { kind: "text", text: "Explicit", style: { fontSizePx: 25 } }
    ] });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const objects = context.getDocument()!.pages[0]!.objects;
    expect(objects.slice(0, 2)).toEqual(existing);
    expectDrawingDefaults(objects[2], style);
    expectDrawingDefaults(objects[4], style); // Group labels have no bonds; style still carries their size.
    expect(objects[3]).toMatchObject({ type: "text", style: { fontSizePx: style.atomLabelFontSizePx, fontFamily: style.atomLabelFontFamily } });
    expect(objects[5]).toMatchObject({ type: "text", style: { fontSizePx: style.atomLabelFontSizePx } });
    expect(objects[6]).toMatchObject({ type: "text", style: { fontSizePx: 25 } });
    expect(document.pages[0]!.objects).toEqual(existing);
  });
  it("uses custom document text defaults for molecule captions and standalone text with explicit style on top", async () => {
    const { context, replace } = testContext(false);
    const document = insertionDocument(defaultCases[0]!);
    document.styles.text = { fontFamily: "Times", fontSizePx: 21, color: "#123456", fontWeight: 600, fontStyle: "italic" };
    replace(document);
    const existing = structuredClone(document.pages[0]!.objects);
    const result = await callAssistantTool(context, "insert_structures", { items: [
      { kind: "molecule", smiles: "CC", label: "Caption" }, { kind: "text", text: "Standalone" }
    ] });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    for (const index of [3, 4]) expect(context.getDocument()!.pages[0]!.objects[index]).toMatchObject({ style: document.styles.text });
    const explicit = await callAssistantTool(context, "insert_text", { text: "Override", style: { fontSizePx: 25, bold: false, italic: false } });
    expect(explicit.isError, JSON.stringify(explicit)).not.toBe(true);
    expect(context.getDocument()!.pages[0]!.objects.at(-1)).toMatchObject({ style: {
      fontFamily: "Times", fontSizePx: 25, color: "#123456", fontWeight: 400, fontStyle: "normal"
    } });
    expect(context.getDocument()!.pages[0]!.objects.slice(0, 2)).toEqual(existing);
  });
});
