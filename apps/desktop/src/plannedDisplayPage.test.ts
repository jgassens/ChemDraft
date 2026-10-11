import { describe, expect, it } from "vitest";
import type { MoleculeObject } from "@chemdraft/chem-core";
import { applyNativeAtomElementTarget, commitNativeAtomLabelTarget, createPhase4Document, insertNativeTemplateMolecule, insertNativeTextObject } from "./documentWorkflow";
import { planDisplayPage } from "./plannedDisplayPage";

function fixture() {
  const document = insertNativeTextObject(insertNativeTemplateMolecule(
    insertNativeTemplateMolecule(createPhase4Document(), { x: 300, y: 300 }, "cyclohexane"),
    { x: 500, y: 300 }, "benzene"), { x: 100, y: 100 }, "Unchanged text");
  const page = document.pages[0];
  const molecule = page.objects[0] as MoleculeObject;
  const target = { objectId: molecule.id, kind: "atom" as const, atomId: molecule.atoms[0]!.id, distanceToPointer: 0 };
  return { document, page, molecule, target };
}

describe("display page identity", () => {
  it("returns the exact page with no edit or double-bond hover", () => {
    const { page } = fixture();
    expect(planDisplayPage(page)).toBe(page);
  });
  it("returns the exact page for an ordinary relabel draft", () => {
    const { document, molecule, target } = fixture();
    const draft = applyNativeAtomElementTarget(document, target, "NMe", { literal: true });
    const page = draft.pages[0];
    const preview = commitNativeAtomLabelTarget(draft, target, "NMe", {
      literal: true, beforeAtom: molecule.atoms[0], beforeMolecule: molecule
    });
    expect(preview.target).toBe(target);
    expect(planDisplayPage(page, preview)).toBe(page);
  });
  it("changes only the edited molecule for a substituent preview", () => {
    const { document, page, target } = fixture();
    const preview = commitNativeAtomLabelTarget(document, target, "OMe", { literal: true });
    const display = planDisplayPage(page, preview);
    expect(display).not.toBe(page);
    expect(display.objects[0]).not.toBe(page.objects[0]);
    expect((display.objects[0] as MoleculeObject).atoms).toHaveLength(7);
    for (let i = 1; i < page.objects.length; i++) expect(display.objects[i]).toBe(page.objects[i]);
    expect((page.objects[0] as MoleculeObject).atoms).toHaveLength(6);
  });
});
