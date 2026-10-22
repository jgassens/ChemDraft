import { describe, expect, it } from "vitest";
import {
  applyFreeformSingleBondToolAtPoint, applySingleBondToolAtPoint, createPhase4Document,
  getSelectedMolecule, nativeBondOrderForToolCommand, nativeBondStyleForToolCommand,
  createNativeSavePayload, openNativeDocument
} from "./documentWorkflow";

describe.each(["double", "triple"] as const)("%s bond drawing", order => {
  it("maps the tool and inserts the requested chemistry", () => {
    expect(nativeBondOrderForToolCommand(`tool.${order}Bond`)).toBe(order);
    expect(nativeBondStyleForToolCommand(`tool.${order}Bond`)).toBe("solid");
    const document = applySingleBondToolAtPoint(createPhase4Document("Multiple bond"), { x: 300, y: 300 }, { bondOrder: order });
    const molecule = getSelectedMolecule(document)!;
    expect(molecule.bonds).toHaveLength(1);
    expect(molecule.bonds[0].order).toBe(order);
    expect(molecule.structure).toBe(order === "double" ? "C=C" : "C#C");
    expect(openNativeDocument(createNativeSavePayload(document).contents).document).toEqual(document);
  });
  it("grows the requested order from an atom without changing the old bond", () => {
    const document = applySingleBondToolAtPoint(createPhase4Document("Growth"), { x: 300, y: 300 });
    const before = getSelectedMolecule(document)!;
    const atom = before.atoms[1];
    const next = applyFreeformSingleBondToolAtPoint(document, before.id, atom.id, { x: atom.x + 40, y: atom.y }, { bondOrder: order });
    const after = getSelectedMolecule(next)!;
    expect(after.bonds[0]).toEqual(before.bonds[0]);
    expect(after.atoms.slice(0, 2)).toEqual(before.atoms);
    expect(after.bonds[1].order).toBe(order);
  });
  it("refuses growth that would exceed carbon valence", () => {
    const document = applySingleBondToolAtPoint(createPhase4Document("Valence"), { x: 300, y: 300 }, { bondOrder: "triple" });
    const molecule = getSelectedMolecule(document)!;
    const atom = molecule.atoms[1];
    expect(applyFreeformSingleBondToolAtPoint(document, molecule.id, atom.id, { x: atom.x + 40, y: atom.y }, { bondOrder: order })).toBe(document);
    expect(applySingleBondToolAtPoint(document, atom, { bondOrder: order })).toBe(document);
  });
});
