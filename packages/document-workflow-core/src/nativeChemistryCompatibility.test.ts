import { describe, expect, it, vi } from "vitest";
import {
  createEmptyDocument, moleculeToMolfileV2000, moleculeToMolfileV3000,
  readDocument, serializeDocument, UnknownBondOrderError, type MoleculeObject
} from "@chemdraft/chem-core";
import { planPageSvgRender } from "@chemdraft/layout-engine";
import { elementFragments } from "@chemdraft/layout-engine/testing";
import { nativeSingleBondGraphMetadata } from "./atoms";
import { moleculeSmiles } from "./moleculeSmiles";

describe("forward-read unknown chemistry at shared calculation boundaries", () => {
  it.each([undefined, "1.2.0", "1.3.0"])("renders unknown order and declines formula, masses and SMILES with version %s", async version => {
    const raw = JSON.parse(serializeDocument(createEmptyDocument()));
    if (version) Object.assign(raw, { formatVersion: version, minAppVersion: version });
    const base = { x: 0, y: 0, width: 40, height: 40, rotation: 0, style: {} };
    const point = { kind: "point", point: { x: 0, y: 0 } };
    raw.pages[0].objects = [
      { ...base, id: "m", type: "molecule", structureFormat: "smiles", structure: "CC",
        atoms: [{ id: "c1", element: "C", x: 0, y: 0 }, { id: "c2", element: "C", x: 22, y: 0 }],
        bonds: [{ id: "b", fromAtomId: "c1", toAtomId: "c2", order: "future-order" }] },
      { ...base, id: "r", type: "reaction", components: [], mappingState: "future-mapping" },
      { ...base, id: "a", type: "mechanism-arrow", arrowKind: "future-mechanism", source: point,
        target: { kind: "point", point: { x: 30, y: 0 } } }
    ];
    const opened = readDocument(raw);
    expect(opened.warnings).toHaveLength(3);
    const page = opened.document.pages[0]!;
    const molecule = page.objects[0] as MoleculeObject;
    const plan = JSON.stringify(planPageSvgRender(page));
    expect(plan).toContain('"data-bond-order":"unknown"');
    expect(plan).toContain('"data-mechanism-arrow-kind":"unknown"');
    const unknownInk = planPageSvgRender(page).fragments.flatMap(elementFragments).filter(fragment =>
      fragment.attrs["data-bond-order"] === "unknown" &&
      String(fragment.attrs.class).split(" ").includes("native-bond-line"));
    expect(unknownInk).toHaveLength(1);
    expect(unknownInk[0]!.attrs).toMatchObject({ "stroke-linecap": "round" });
    expect(String(unknownInk[0]!.attrs["stroke-dasharray"])).toMatch(/^0 /);
    // Compare to the existing renderer's explicit unknown states, with no preserved future values.
    const baseline = structuredClone(raw);
    baseline.pages[0].objects[0].bonds[0].order = "unknown";
    baseline.pages[0].objects[1].mappingState = "unknown";
    baseline.pages[0].objects[2].arrowKind = "unknown";
    expect(planPageSvgRender(page)).toEqual(planPageSvgRender(readDocument(baseline).document.pages[0]!));

    const metadata = nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds);
    expect(metadata.formula).toBeUndefined();
    expect(metadata.averageMass).toBeUndefined();
    expect(metadata.exactMass).toBeUndefined();
    expect(metadata.warnings).toEqual([expect.objectContaining({ code: "native.unknown_bond_order",
      message: expect.stringContaining("Bond b has an unknown bond order") })]);
    const identifiers = vi.fn();
    await expect(moleculeSmiles(molecule, 0, [], identifiers)).rejects.toThrow(/unknown bond order/);
    expect(identifiers).not.toHaveBeenCalled(); // Stored CC is never a safe shortcut.
    for (const write of [moleculeToMolfileV2000, moleculeToMolfileV3000]) {
      const query = write(molecule, { kekuleBondOrders: new Map() });
      expect(query.warnings).toContainEqual(expect.stringContaining("bond type 8 (any)"));
      expect(() => write(molecule, { kekuleBondOrders: new Map(), unknownBondOrders: "refuse" })).toThrow(UnknownBondOrderError);
    }
    expect(JSON.parse(serializeDocument(opened.document)).pages[0].objects).toMatchObject(raw.pages[0].objects);
  });
});
