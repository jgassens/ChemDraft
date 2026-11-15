import { describe, expect, it } from "vitest";
import { createEmptyDocument, type ElectronMarkObject, type MoleculeObject } from "@chemdraft/chem-core";
import { electronMarkAtomContribution, nativeElectronMarkAssignments, nativeElectronMarkAtomKey } from "../src/electronMarks";

function fixture() {
  const page = createEmptyDocument().pages[0]!;
  const molecule: MoleculeObject = {
    id: "molecule", type: "molecule", x: 100, y: 100, width: 40, height: 0, rotation: 0,
    style: { bondLengthPx: 40 }, structureFormat: "smiles", structure: "O=C",
    atoms: [
      { id: "oxygen", element: "O", x: 100, y: 100, formalCharge: 0 },
      { id: "carbon", element: "C", x: 140, y: 100, formalCharge: 0 }
    ],
    bonds: [{ id: "bond", fromAtomId: "oxygen", toAtomId: "carbon", order: "double" }],
    superatoms: [], rGroups: []
  };
  const mark: ElectronMarkObject = {
    id: "mark", type: "electron-mark", x: 104, y: 94, width: 12, height: 12, rotation: 0,
    style: {}, markKind: "charge", charge: -1, anchor: { kind: "point", point: { x: 110, y: 100 } }
  };
  page.objects = [molecule, mark];
  return { page, molecule, mark };
}

describe("nativeElectronMarkAssignments", () => {
  it("uses the nearest atom even when the charge and radical exceed its valence", () => {
    const { page, molecule, mark } = fixture();
    mark.radical = true;
    const before = structuredClone(page);
    const result = nativeElectronMarkAssignments(page);
    expect(result.anchorByMarkId.get(mark.id)).toEqual({ objectId: molecule.id, atomId: "oxygen" });
    expect([...result.assignedChargeByAtomKey]).toEqual([[nativeElectronMarkAtomKey(molecule.id, "oxygen"), -1]]);
    expect([...result.assignedRadicalsByAtomKey]).toEqual([[nativeElectronMarkAtomKey(molecule.id, "oxygen"), 1]]);
    expect(page).toEqual(before);
  });

  it.each([false, true])("retains a distant atom anchor only when explicit is %s", explicit => {
    const { page, molecule, mark } = fixture();
    mark.x = 494;
    mark.anchor = { kind: "atom", objectId: molecule.id, atomId: "oxygen" };
    if (explicit) mark.atomAssociation = "explicit";
    const result = nativeElectronMarkAssignments(page);
    expect(result.anchorByMarkId.get(mark.id)).toEqual(explicit ? { objectId: molecule.id, atomId: "oxygen" } : undefined);
    expect(result.assignedChargeByAtomKey.get(nativeElectronMarkAtomKey(molecule.id, "oxygen")) ?? 0).toBe(explicit ? -1 : 0);
  });

  it("keeps an in-radius legacy anchor even when another atom is nearer", () => {
    const { page, molecule, mark } = fixture();
    mark.anchor = { kind: "atom", objectId: molecule.id, atomId: "carbon" };
    expect(nativeElectronMarkAssignments(page).anchorByMarkId.get(mark.id))
      .toEqual({ objectId: molecule.id, atomId: "carbon" });
  });

  it.each(["point", "atom"] as const)("suppresses both passes for a floating drop with a %s anchor for this call only", kind => {
    const { page, molecule, mark } = fixture();
    if (kind === "atom") {
      mark.anchor = { kind, objectId: molecule.id, atomId: "oxygen" };
      mark.atomAssociation = "explicit";
    }
    const suppressed = nativeElectronMarkAssignments(page, { floatingElectronMarkIds: new Set([mark.id]) });
    expect(suppressed.anchorByMarkId.has(mark.id)).toBe(true);
    expect(suppressed.anchorByMarkId.get(mark.id)).toBeUndefined();
    expect(suppressed.assignedChargeByAtomKey.size).toBe(0);
    expect(suppressed.assignedRadicalsByAtomKey.size).toBe(0);
    expect(nativeElectronMarkAssignments(page).anchorByMarkId.get(mark.id))
      .toEqual({ objectId: molecule.id, atomId: "oxygen" });
  });

  it("falls back to distance when an explicit anchor references a missing atom", () => {
    const { page, molecule, mark } = fixture();
    mark.anchor = { kind: "atom", objectId: molecule.id, atomId: "missing" };
    mark.atomAssociation = "explicit";
    expect(nativeElectronMarkAssignments(page).anchorByMarkId.get(mark.id))
      .toEqual({ objectId: molecule.id, atomId: "oxygen" });
  });

  it("scales legacy capture with the molecule's drawing style", () => {
    const { page, molecule, mark } = fixture();
    molecule.style.bondLengthPx = 80;
    mark.x = 14; // Centre 20 is 80 px from oxygen: outside the base radius, inside this style's.
    expect(nativeElectronMarkAssignments(page).anchorByMarkId.get(mark.id))
      .toEqual({ objectId: molecule.id, atomId: "oxygen" });
  });

  it("anchors lone pairs without adding chemical contributions", () => {
    const { page, molecule, mark } = fixture();
    mark.markKind = "lone-pair";
    delete mark.charge;
    expect(electronMarkAtomContribution(mark)).toEqual({ charge: 0, radicals: 0 });
    const result = nativeElectronMarkAssignments(page);
    expect(result.anchorByMarkId.get(mark.id)).toEqual({ objectId: molecule.id, atomId: "oxygen" });
    expect(result.assignedChargeByAtomKey.get(nativeElectronMarkAtomKey(molecule.id, "oxygen"))).toBe(0);
    expect(result.assignedRadicalsByAtomKey.get(nativeElectronMarkAtomKey(molecule.id, "oxygen"))).toBe(0);
  });
});
