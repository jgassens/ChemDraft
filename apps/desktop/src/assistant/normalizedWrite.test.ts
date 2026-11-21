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

describe("normalized assistant writes bind selected ids to their selection page", () => {
  function twoPages() {
    const fixture = testContext();
    const document = structuredClone(fixture.context.getDocument()!);
    const pageA = document.pages[0]!;
    const pageB = { ...pageA, id: "page_b", objects: [structuredClone(fixture.molecule)] };
    document.pages = [pageA, pageB];
    return { ...fixture, document, pageA, pageB, scopePages: new Map([[fixture.molecule.id, pageB.id]]) };
  }
  const refusal = (_id: string, pinned: string, target: string) => {
    const number = (id: string) => (id === "page_b" ? 2 : 1);
    return `Plugin write refused: the change was not applied. The object you selected on page ${number(pinned)} shares its internal ID with an object on page ${number(target)}, so ChemDraft can't tell which one to change safely. To edit it, make the change by hand, or copy the object and paste it as a new object, then try again.`;
  };
  it("the refusal never tells the user to delete anything", () => {
    expect(refusal("x", "page_b", "page_a")).not.toMatch(/delete/i);
  });

  it("refuses a write that changes the same-id object on another page, in verification and in the gate recheck", async () => {
    const { context, molecule, document, pageA, pageB, scopePages } = twoPages();
    // A bare-id patch resolves to the first occurrence: page A's molecule.
    const patched = applyPatch(document, buildStyleObjects(context, { objectIds: [molecule.id], style: { color: "#123456" } }).patch);
    expect(patched.pages[0]!.objects[0]).not.toEqual(pageA.objects[0]);
    const scope = new Set([molecule.id]);
    await expect(verifyNormalizedAssistantWrite(context, document, patched, scope, new Map(), scopePages))
      .rejects.toThrow(refusal(molecule.id, pageB.id, pageA.id));
    expect(() => recheckNormalizedAssistantWrite(document, patched, scope, document, document, scopePages))
      .toThrow(refusal(molecule.id, pageB.id, pageA.id));
  });

  it("accepts a write that changes only the selection page's object", async () => {
    const { context, molecule, document, pageB, scopePages } = twoPages();
    const restyled = { ...structuredClone(molecule), style: { ...molecule.style, bondColor: "#123456" } };
    const patched = { ...document, pages: [document.pages[0]!, { ...pageB, objects: [restyled] }] };
    const verified = await verifyNormalizedAssistantWrite(context, document, patched, new Set([molecule.id]), new Map(), scopePages);
    expect(verified.pages[0]!.objects).toEqual(document.pages[0]!.objects);
  });
});
