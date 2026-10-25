import { describe, expect, it, vi } from "vitest";
import { cloneDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { atomDisplayLabel } from "@chemdraft/layout-engine";
import { nativeAtomLabelReading } from "@chemdraft/document-workflow-core";
import { commitNativeAtomLabelTarget } from "../documentWorkflow";
import { callAssistantTool } from "./assistantTools";
import { testContext } from "./tools/testContext";
import { objectRect, overlaps, pageContentRect } from "./placement";

describe("assistant native group labels", () => {
  it.each(["CH3", "Me", "Et", "Ph", "Bn", "Boc", "OTs", "OMe", "NO2", "CF3", "CONH2"])(
    "inserts and renders %s with the exact semantics of typing the label on the canvas", async label => {
    const { context } = testContext(false);
    const result = await callAssistantTool(context, "insert_structures", { items: [{ kind: "group", label }] });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const document = context.getDocument()!;
    const molecule = document.pages[0]!.objects.at(-1)! as MoleculeObject;
    expect(molecule).toMatchObject({ type: "molecule", atoms: [{ element: label, labelLiteral: true, formalCharge: 0 }], bonds: [], rGroups: [], superatoms: [] });
    expect(molecule.atoms).toHaveLength(1);
    expect(context.chemistry.structureFromSmiles).not.toHaveBeenCalled();
    expect(context.chemistry.inspectStructure).not.toHaveBeenCalled();
    expect(atomDisplayLabel(molecule.atoms[0]!, molecule.bonds, undefined, molecule.atoms)).toBe(label);

    // Exercise the canvas label commit, starting from an unbonded carbon in the same place.
    const reference = cloneDocument(document);
    const source = reference.pages[0]!.objects.at(-1)! as MoleculeObject;
    source.atoms[0] = { ...source.atoms[0]!, element: "C", labelLiteral: false };
    const typed = commitNativeAtomLabelTarget(reference, { kind: "atom", objectId: source.id, atomId: source.atoms[0]!.id, distanceToPointer: 0 }, label, { literal: true })
      .document.pages[0]!.objects.at(-1)! as MoleculeObject;
    expect(molecule.atoms).toEqual(typed.atoms);
    expect(molecule.chemistry).toEqual(typed.chemistry);
    expect(molecule.structure).toEqual(typed.structure);
    if (label === "CH3") expect(molecule.chemistry?.formula).toBe("CH3");
    expect(result.structuredContent?.warnings).toEqual(molecule.chemistry?.warnings.map(warning => warning.message));

    const rendered = await callAssistantTool(context, "render", { target: "objects", objectIds: [molecule.id] });
    expect(rendered.isError, JSON.stringify(rendered)).not.toBe(true);
    expect(vi.mocked(context.render).mock.calls[0]![0]).toContain(`data-atom-label="${label}"`);
    const summary = await callAssistantTool(context, "get_document", { includeSmiles: false });
    expect(summary.structuredContent?.objects).toContainEqual(expect.objectContaining({
      id: molecule.id, type: "molecule", atomCount: 1, atomLabels: [{ atomId: molecule.atoms[0]!.id, label, literal: true }]
    }));
  });

  it.each(["methyl", "not-a-group", "Ome", "R", "R1", "*", "Ac", "C"])("refuses %s without inventing a structure or inserting part of the call", async label => {
    const { context } = testContext();
    if (label === "Ac") expect(nativeAtomLabelReading(label, { bonded: false, typed: true }).kind).toBe("element");
    const before = cloneDocument(context.getDocument()!);
    const result = await callAssistantTool(context, "insert_structures", { items: [{ kind: "group", label: "CH3" }, { kind: "group", label }] });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("CH3, Me, Ph, Boc, OTs or OMe") });
    expect(context.getDocument()).toEqual(before);
    expect(context.write).not.toHaveBeenCalled();
  });

  it.each(["row", "grid", "auto"])("places groups alongside molecules and text in %s without overlap or losing SMILES verification", async arrangement => {
    const { context } = testContext(false);
    const result = await callAssistantTool(context, "insert_structures", { arrangement, items: [
      { kind: "group", label: "CH3" }, { kind: "molecule", smiles: "CC", label: "Ethane" },
      { kind: "group", label: "OTs" }, { kind: "text", text: "Caption" }
    ] });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(context.confirmPageGrowth).not.toHaveBeenCalled();
    const page = context.getDocument()!.pages[0]!;
    const bounds = pageContentRect(page);
    const rects = page.objects.map(objectRect);
    for (const [index, rect] of rects.entries()) {
      expect(rect.x).toBeGreaterThanOrEqual(bounds.x);
      expect(rect.y).toBeGreaterThanOrEqual(bounds.y);
      expect(rect.x + rect.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1e-6);
      expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1e-6);
      for (const other of rects.slice(index + 1)) expect(overlaps(rect, other)).toBe(false);
    }
    expect(page.objects.filter(object => object.type === "molecule")).toHaveLength(4);
    expect(context.chemistry.inspectStructure).toHaveBeenCalledWith("smiles", "CC");
  });
});
