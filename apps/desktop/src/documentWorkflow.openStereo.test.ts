import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPatches, deserializeDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import {
  applyEditorSaveResultWithLabelWarnings, conformerGraphSignature, copyAsMergedMolecule,
  copyAsMolfile, createPhase4Document, createSelectionClipboardPayload, getSelectedMolecule,
  insertNativeMolfileMolecule
} from "./documentWorkflow";

const fixture = (name: string) => readFileSync(new URL(`../../../packages/fixtures/open-double-bonds/${name}`, import.meta.url), "utf8");

describe("desktop open double-bond builders", () => {
  it.each(["v2000", "v3000"] as const)("preserves either through %s MOL paste", flavor => {
    const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 200, y: 200 },
      fixture(`open.${flavor}.mol`), `molfile-${flavor}`);
    const molecule = getSelectedMolecule(document)!;
    expect(molecule.atoms).toHaveLength(4);
    expect(molecule.bonds).toHaveLength(3);
    expect(molecule.bonds.filter(bond => bond.stereo === "either")).toHaveLength(1);
    expect(parseMolfileGraph(copyAsMolfile(document, flavor)!).bonds.filter(bond => bond.stereo === "either")).toHaveLength(1);
  });

  it("V3000 editor save decodes CFG=2 only on a double bond and clears removed intent", () => {
    const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 200, y: 200 },
      fixture("e.v3000.mol"), "molfile-v3000");
    const original = getSelectedMolecule(document)!;
    const save = (structure: string) => getSelectedMolecule(applyEditorSaveResultWithLabelWarnings(document, {
      object: { ...original, structure, structureFormat: "molfile-v3000" }, warnings: []
    }).document)!;
    const open = save(fixture("open.v3000.mol"));
    expect(open.bonds.filter(bond => bond.stereo === "either")).toHaveLength(1);
    expect(save(fixture("e.v3000.mol")).bonds.every(bond => bond.stereo === undefined)).toBe(true);
    const single = fixture("open.v3000.mol").replace("M  V30 2 2 2 3 CFG=2", "M  V30 2 1 2 3 CFG=2");
    expect(single).not.toBe(fixture("open.v3000.mol"));
    expect(save(single).bonds.every(bond => bond.order === "double" || bond.stereo === undefined)).toBe(true);
  });

  it("fragment copy, merged copy and group-label expansion retain either", () => {
    const document = insertNativeMolfileMolecule(createPhase4Document(), { x: 200, y: 200 },
      fixture("open.v2000.mol"), "molfile-v2000");
    const original = getSelectedMolecule(document)!;
    const deselected = applyPatches(document, [{ op: "setSelection", pageId: document.pages[0].id, objectIds: [] }]);
    const fragment = createSelectionClipboardPayload(deselected, [{ objectId: original.id,
      atomIds: original.atoms.map(atom => atom.id), bondIds: original.bonds.map(bond => bond.id) }])!;
    const copied = fragment.objects[0] as MoleculeObject;
    expect(copied.bonds).toEqual(original.bonds);
    expect(copyAsMergedMolecule([original, copied])!.bonds.filter(bond => bond.stereo === "either")).toHaveLength(2);
    const labelled = applyPatches(document, [{ op: "updateObject", objectId: original.id, changes: {
      atoms: original.atoms.map((atom, i) => i === 0 ? { ...atom, element: "Me" } : atom)
    } }]);
    for (const flavor of ["v2000", "v3000"] as const) {
      const graph = parseMolfileGraph(copyAsMolfile(labelled, flavor)!);
      expect(graph.bonds.filter(bond => bond.stereo === "either")).toHaveLength(1);
      expect(graph.atoms).toHaveLength(4);
      expect(graph.bonds).toHaveLength(3);
    }
  });

  it("conformer cache distinguishes open, E, Z and tetrahedral stereo intent", () => {
    const molecule = (name: string) => deserializeDocument(fixture(`${name}.json`)).pages[0].objects[0] as MoleculeObject;
    expect(new Set(["open", "e", "z"].map(name => conformerGraphSignature(molecule(name)))).size).toBe(3);
    const open = molecule("open");
    expect(conformerGraphSignature({ ...open, bonds: open.bonds.map(({ stereo: _stereo, ...bond }) => bond) }))
      .not.toBe(conformerGraphSignature(open));
    for (const name of ["open", "e", "z", "neighboring-centers"]) {
      const original = molecule(name);
      expect(conformerGraphSignature({ ...original, atoms: original.atoms.map(atom => ({ ...atom, x: atom.x + 100, y: atom.y - 100 })) }))
        .toBe(conformerGraphSignature(original));
    }
    const assigned = molecule("neighboring-centers");
    const marker = assigned.bonds.find(bond => ["wedge", "hashed"].includes(bond.display?.bondStyle ?? ""))!;
    const inverted = { ...assigned, bonds: assigned.bonds.map(bond => bond.id === marker.id
      ? { ...bond, display: { ...bond.display, bondStyle: marker.display!.bondStyle === "wedge" ? "hashed" as const : "wedge" as const } } : bond) };
    expect(conformerGraphSignature(inverted)).not.toBe(conformerGraphSignature(assigned));
  });
});
