import { applyPatch, type MoleculeObject } from "@chemdraft/chem-core";
import { describe, expect, it, vi } from "vitest";
import { invalidCarbonMolecule } from "../../../../packages/document-workflow-core/test/invalidStructureFixtures";
import { testContext } from "./tools/testContext";
import { verifyNormalizedAssistantWrite, recheckNormalizedAssistantWrite } from "./normalizedWrite";
import { buildStyleObjects, inspectMolecule } from "./writeBuilder";

function invalidContext() {
  const fixture = testContext();
  const molecule = { ...invalidCarbonMolecule(true), id: fixture.molecule.id };
  const document = structuredClone(fixture.context.getDocument()!);
  document.pages[0]!.objects = [molecule];
  fixture.replace(document);
  fixture.context.chemistry.inspectStructure = vi.fn(async () => ({ valid: false as const, reason: "RDKit could not parse the structure" }));
  return { ...fixture, molecule, document };
}

describe("normalized assistant writes on invalid drawings", () => {
  it("restyles without parsing, preserving every native chemical field", async () => {
    const { context, molecule, document } = invalidContext();
    const built = buildStyleObjects(context, { objectIds: [molecule.id], style: { color: "#123456" } });
    const patched = applyPatch(document, built.patch);
    const verified = await verifyNormalizedAssistantWrite(context, document, patched, new Set([molecule.id]));
    const after = verified.pages[0]!.objects[0] as MoleculeObject;
    expect(after.atoms).toEqual(molecule.atoms);
    expect(after.bonds).toEqual(molecule.bonds);
    expect(after.style).toMatchObject({ bondColor: "#123456" });
    expect(context.chemistry.inspectStructure).not.toHaveBeenCalled();
    expect(recheckNormalizedAssistantWrite(document, patched, new Set([molecule.id]), verified, document)).toEqual(verified);
  });
  it.each(["element", "formalCharge", "isotope", "labelLiteral", "bondOrder"])("still checks a change to %s", async field => {
    const { context, molecule, document } = invalidContext();
    const changed = structuredClone(molecule);
    if (field === "bondOrder") changed.bonds[0]!.order = "double";
    else Object.assign(changed.atoms[0]!, { [field]: field === "element" ? "N" : field === "labelLiteral" ? true : 1 });
    const patched = applyPatch(document, { op: "updateObject", objectId: molecule.id, changes: { atoms: changed.atoms, bonds: changed.bonds } });
    await expect(verifyNormalizedAssistantWrite(context, document, patched, new Set([molecule.id])))
      .rejects.toThrow(/refused|RDKit could not parse/);
  });
  it("still verifies explicit expected SMILES even for an otherwise style-only patch", async () => {
    const { context, molecule, document } = invalidContext();
    const built = buildStyleObjects(context, { objectIds: [molecule.id], style: { color: "#123456" } });
    await expect(verifyNormalizedAssistantWrite(context, document, applyPatch(document, built.patch),
      new Set([molecule.id]), new Map([[molecule.id, "CC"]]))).rejects.toThrow(/refused|RDKit could not parse/);
    expect(context.chemistry.inspectStructure).toHaveBeenCalled();
  });
  it("keeps the parse requirement for explicit chemistry inspection", async () => {
    const { context, molecule } = invalidContext();
    await expect(inspectMolecule(context, molecule)).rejects.toThrow("RDKit could not parse");
    expect(context.chemistry.inspectStructure).toHaveBeenCalled();
  });
});
