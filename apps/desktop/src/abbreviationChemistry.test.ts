// Abbreviation ("nickname") labels as chemistry on the desktop paths: the badge, the bond tool,
// copy and save round trips, and the stereo guard. The table and its chemistry are tested in
// packages/template-library and packages/document-workflow-core; this file covers the app wiring.

import { beforeAll, describe, expect, it } from "vitest";
import type { ChemDraftDocument, MoleculeAtom, MoleculeBond, MoleculeObject, ViewMatrix } from "@chemdraft/chem-core";
import { moleculeSmiles, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import { perceiveStereoCentersFromMolfile } from "@chemdraft/ocl-adapter";
import { createRdkitAdapter } from "@chemdraft/rdkit-adapter/adapter";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";

import {
  analysisFacingStructure,
  applyAnalysisToSelectedMolecule,
  applyNativeAtomElementTarget,
  flattenSpunMolecule,
  validationFacingStructure,
  applyNativeMoleculeDeleteTarget,
  applySingleBondToolAtPoint,
  copyAsMolfile,
  createNativeSavePayload,
  createPhase4Document,
  getSelectedMolecule,
  insertNativeSingleBondMolecule,
  insertNativeTemplateMolecule,
  nativeMoleculeInvalidAtomStates,
  openNativeDocument
} from "./documentWorkflow";

beforeAll(() => {
  installNodeRdkitModuleLoader();
});

function selectedMolecule(document: ChemDraftDocument): MoleculeObject {
  const molecule = getSelectedMolecule(document);
  if (!molecule) throw new Error("Expected a selected molecule.");
  return molecule;
}

function relabel(document: ChemDraftDocument, atomId: string, label: string, options: { literal?: boolean } = {}): ChemDraftDocument {
  const molecule = selectedMolecule(document);
  return applyNativeAtomElementTarget(document, { objectId: molecule.id, kind: "atom", atomId, distanceToPointer: 0 }, label, options);
}

/** Click the single-bond tool just beside an atom, the way a user grows a bond from it. */
function growFrom(document: ChemDraftDocument, atomId: string): ChemDraftDocument {
  const atom = selectedMolecule(document).atoms.find((candidate) => candidate.id === atomId)!;
  return applySingleBondToolAtPoint(document, { x: atom.x + 3, y: atom.y });
}

/**
 * Bonds touching `atomId` in the molecule `objectId` â€” not "the selected molecule", which a refused
 * growth can leave pointing at a fresh standalone bond the tool drew beside the atom instead.
 */
function bondsAt(document: ChemDraftDocument, objectId: string, atomId: string): MoleculeBond[] {
  const molecule = document.pages[0]!.objects.find((object): object is MoleculeObject => object.id === objectId)!;
  return molecule.bonds.filter((bond) => bond.fromAtomId === atomId || bond.toAtomId === atomId);
}

/** Ethane with its second carbon (and the bond) deleted: one lone atom, atom_001. */
function loneAtom(): ChemDraftDocument {
  const ethane = insertNativeSingleBondMolecule(createPhase4Document("Lone Atom"), { x: 300, y: 300 });
  return applyNativeMoleculeDeleteTarget(ethane, {
    objectId: selectedMolecule(ethane).id,
    kind: "bond",
    bondId: "bond_001",
    fromAtomId: "atom_001",
    toAtomId: "atom_002",
    terminalAtomId: "atom_002",
    distanceToPointer: 0
  });
}

const canonical = async (input: MoleculeObject): Promise<string> => {
  const warnings: ExportWarning[] = [];
  return moleculeSmiles(input, 0, warnings, computeStructureIdentifiers);
};

describe("the owner's report: OMe on a ring carbon", () => {
  it("badges OMe placed on a cyclohexane carbon by the O hotkey, and by typing", () => {
    const ring = insertNativeTemplateMolecule(createPhase4Document("OMe On Ring"), { x: 300, y: 300 }, "cyclohexane");
    const ringAtomId = selectedMolecule(ring).atoms[0]!.id;
    for (const options of [{}, { literal: true }]) {
      const labeled = relabel(ring, ringAtomId, "OMe", options);
      const states = nativeMoleculeInvalidAtomStates(selectedMolecule(labeled));
      expect(states).toHaveLength(1);
      expect(states[0]).toMatchObject({ atomId: ringAtomId, expectedFormalCharge: 1 });
      expect(states[0]!.invalidReason).toContain(`"OMe" attaches by 1 bond; atom ${ringAtomId} has 2.`);
    }
  });

  it("badges OMe on an aromatic ring carbon too", () => {
    const benzene = insertNativeTemplateMolecule(createPhase4Document("OMe On Benzene"), { x: 300, y: 300 }, "benzene");
    const ringAtomId = selectedMolecule(benzene).atoms[0]!.id;
    const labeled = relabel(benzene, ringAtomId, "OMe");
    expect(nativeMoleculeInvalidAtomStates(selectedMolecule(labeled)).map((state) => state.atomId)).toContain(ringAtomId);
  });

  it("treats Ome, OME and ome as text, never as methoxy", () => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Case"), { x: 300, y: 300 });
    for (const label of ["Ome", "OME", "ome"]) {
      const molecule = selectedMolecule(relabel(ethane, "atom_002", label, { literal: true }));
      expect(molecule.atoms[1]!.element).toBe(label);
      expect(nativeMoleculeInvalidAtomStates(molecule)).toMatchObject([{ atomId: "atom_002", unrecognizedLabel: true }]);
      expect(molecule.chemistry?.formula).toBe("CH3");
    }
    // ...while OMe on the chain end is valid methyl ether.
    const ether = selectedMolecule(relabel(ethane, "atom_002", "OMe", { literal: true }));
    expect(nativeMoleculeInvalidAtomStates(ether)).toEqual([]);
    expect(ether.chemistry?.formula).toBe("C2H6O");
  });

  it("returns to the exact earlier chemistry when the label is put back", () => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Relabel Back"), { x: 300, y: 300 });
    const original = selectedMolecule(ethane);
    const labeled = relabel(ethane, "atom_002", "OMe");
    const back = selectedMolecule(relabel(labeled, "atom_002", "C"));
    expect(back.chemistry).toEqual(original.chemistry);
    expect(back.structure).toBe(original.structure);
  });
});

describe("the bond tool and abbreviations", () => {
  it("draws exactly the one bond a lone abbreviation is missing, and no second", () => {
    const lone = relabel(loneAtom(), "atom_001", "OMe");
    const objectId = selectedMolecule(lone).id;
    expect(nativeMoleculeInvalidAtomStates(selectedMolecule(lone))).toMatchObject([{ atomId: "atom_001" }]);

    const bonded = growFrom(lone, "atom_001");
    expect(bondsAt(bonded, objectId, "atom_001")).toHaveLength(1);
    const molecule = selectedMolecule(bonded);
    expect(molecule.id).toBe(objectId);
    expect(nativeMoleculeInvalidAtomStates(molecule)).toEqual([]);
    expect(molecule.chemistry?.formula).toBe("C2H6O");

    // The group's valence is full: the tool never draws a second bond to it.
    const again = growFrom(bonded, "atom_001");
    expect(bondsAt(again, objectId, "atom_001")).toHaveLength(1);
  });

  it("still refuses any bond from a label with no free valence to fill", () => {
    for (const label of ["R", "Ome", "CONH2"]) {
      const lone = relabel(loneAtom(), "atom_001", label);
      expect(bondsAt(growFrom(lone, "atom_001"), selectedMolecule(lone).id, "atom_001"), label).toHaveLength(0);
    }
  });
});

describe("round trips keep the label", () => {
  function anisole(): ChemDraftDocument {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Anisole"), { x: 300, y: 300 });
    return relabel(relabel(ethane, "atom_001", "Ph"), "atom_002", "OMe");
  }

  it("saves and reopens Phâ€“OMe as two labelled atoms with anisole's formula", () => {
    const document = anisole();
    expect(selectedMolecule(document).chemistry?.formula).toBe("C7H8O");
    const reopened = openNativeDocument(createNativeSavePayload(document).contents).document!;
    const molecule = reopened.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    expect(molecule.atoms.map((atom) => atom.element)).toEqual(["Ph", "OMe"]);
    expect(molecule.chemistry?.formula).toBe("C7H8O");
  });

  it("reads the labels back from the visible CDXML alone, not exploded into atoms", () => {
    const contents = createNativeSavePayload(anisole()).contents
      .replace(/<objecttag[^>]*Name="org\.chemdraft\/native-document"[^>]*\/>/g, "");
    expect(contents).not.toContain("org.chemdraft/native-document");
    const opened = openNativeDocument(contents);
    expect(opened.source).toBe("external-cdxml");
    const molecule = opened.document!.pages[0]!.objects.find((object): object is MoleculeObject => object.type === "molecule")!;
    expect(molecule.atoms.map((atom) => atom.element)).toEqual(["Ph", "OMe"]);
    expect(molecule.bonds).toHaveLength(1);
    expect(nativeMoleculeInvalidAtomStates(molecule)).toEqual([]);
  });

  it("copies Phâ€“OMe as anisole's SMILES and as a molfile RDKit reads as anisole", async () => {
    const document = anisole();
    const scoped = { ...document, selection: { ...document.selection, objectIds: [] } };
    const anisoleSmiles = (await computeStructureIdentifiers(
      copyAsMolfile(scoped, "v3000")!
    ))?.smiles;
    expect(anisoleSmiles).toBe("COc1ccccc1");
    expect((await computeStructureIdentifiers(copyAsMolfile(scoped, "v2000")!))?.smiles).toBe("COc1ccccc1");
    // Copy As SMILES is covered in documentWorkflow.test.ts; it loads the desktop's browser RDKit
    // loader, which would replace the Node one these tests read RDKit through.
  });
});

describe("Validate after a 3D flatten", () => {
  const IDENTITY: ViewMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  it("keeps the expanded formula: the engine reads the live graph, not the flatten's '*' molfile", async () => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Flatten Validate"), { x: 300, y: 300 });
    const labeled = relabel(ethane, "atom_002", "OMe");
    const before = selectedMolecule(labeled);
    expect(before.chemistry?.formula).toBe("C2H6O");

    const coords3d = new Float64Array(before.atoms.flatMap((candidate) => [candidate.x, candidate.y, 0]));
    const outcome = flattenSpunMolecule(labeled, before.id, coords3d, IDENTITY);
    expect(outcome.status, outcome.refusalReasons.join("; ")).toBe("committed");
    const flattened = outcome.document.pages[0]!.objects.find((object): object is MoleculeObject => object.id === before.id)!;
    // The flatten stores a standard molfile with a dummy atom for the label...
    expect(flattened.structure).toMatch(/ \* {2}/);

    // ...but Validate reads the live graph, expanded: dimethyl ether, not C–*.
    const facing = validationFacingStructure(flattened);
    expect(facing.format).toBe("molfile-v3000");
    const analysis = await createRdkitAdapter().analyzeStructure(facing);
    expect(analysis.validation.valid).toBe(true);
    expect(analysis.properties.formula).toBe("C2H6O");
    const validated = applyAnalysisToSelectedMolecule(
      { ...outcome.document, selection: { ...outcome.document.selection, objectIds: [before.id] } },
      analysis
    );
    const after = validated.pages[0]!.objects.find((object): object is MoleculeObject => object.id === before.id)!;
    expect(after.chemistry?.formula).toBe("C2H6O");
  });
});

describe("the analysis molfile keeps every drawn atom at its index", () => {
  it("writes Ph–OMe's drawn atoms first, then the groups' atoms", () => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Index Map"), { x: 300, y: 300 });
    const drawn = selectedMolecule(relabel(relabel(ethane, "atom_001", "Ph"), "atom_002", "OMe"));
    const atomLines = analysisFacingStructure(drawn).structure.split("\n")
      .filter((line) => /^M {2}V30 \d+ \S+ /.test(line) && !line.includes("COUNTS"))
      .slice(0, 8);
    const symbols = atomLines.map((line) => line.split(" ")[4]);
    // Index 1 is the drawn Ph atom (now its attachment carbon), index 2 the drawn OMe atom (its O);
    // the phenyl's five carbons and the methyl carbon follow. A per-atom result for index 1 or 2
    // therefore still belongs to the drawn atom with that index.
    expect(symbols).toEqual(["C", "O", "C", "C", "C", "C", "C", "C"]);
    expect(drawn.atoms.map((candidate) => candidate.id)).toEqual(["atom_001", "atom_002"]);
  });
});

describe("the bond tool and a bonded element spelling", () => {
  it("lets a lone typed Ac take its first bond as actinium, then holds it to acetyl's one", () => {
    const lone = relabel(loneAtom(), "atom_001", "Ac", { literal: true });
    const objectId = selectedMolecule(lone).id;
    const bonded = growFrom(lone, "atom_001");
    expect(bondsAt(bonded, objectId, "atom_001")).toHaveLength(1);
    // Now it is acetyl on a methyl: acetone, C3H6O.
    expect(selectedMolecule(bonded).chemistry?.formula).toBe("C3H6O");
    expect(bondsAt(growFrom(bonded, "atom_001"), objectId, "atom_001")).toHaveLength(1);
  });

  it("treats an Ac placed by the element path (not typed) as actinium on a bond", () => {
    const lone = relabel(loneAtom(), "atom_001", "Ac");
    const bonded = growFrom(lone, "atom_001");
    expect(selectedMolecule(bonded).chemistry?.formula).toBe("CH3Ac");
  });
});

describe("stereo with an abbreviation on the stereocentre", () => {
  // 2-Methoxybutane, wedge to the methyl. Same coordinates both times: once with an "OMe" label,
  // once with the O and its methyl drawn atom by atom.
  function methoxybutane(labelled: boolean): MoleculeObject {
    const atoms: MoleculeAtom[] = [
      { id: "c1", element: "C", x: 100, y: 100, formalCharge: 0 },
      { id: "c2", element: "C", x: 74, y: 115, formalCharge: 0 },
      { id: "c3", element: "C", x: 126, y: 115, formalCharge: 0 },
      { id: "c4", element: "C", x: 152, y: 100, formalCharge: 0 },
      labelled
        ? { id: "o1", element: "OMe", x: 100, y: 70, formalCharge: 0 }
        : { id: "o1", element: "O", x: 100, y: 70, formalCharge: 0 },
      ...(labelled ? [] : [{ id: "c5", element: "C", x: 126, y: 55, formalCharge: 0 }])
    ];
    const bonds: MoleculeBond[] = [
      { id: "b1", fromAtomId: "c1", toAtomId: "c2", order: "single", display: { bondStyle: "wedge" } },
      { id: "b2", fromAtomId: "c1", toAtomId: "c3", order: "single" },
      { id: "b3", fromAtomId: "c3", toAtomId: "c4", order: "single" },
      { id: "b4", fromAtomId: "c1", toAtomId: "o1", order: "single" },
      ...(labelled ? [] : [{ id: "b5", fromAtomId: "o1", toAtomId: "c5", order: "single" as const }])
    ];
    return {
      id: "m1", type: "molecule", x: 60, y: 40, width: 100, height: 80, rotation: 0, style: {},
      structureFormat: "smiles", structure: "", atoms, bonds, superatoms: [], rGroups: []
    };
  }

  it("exports the same stereoisomer as the molecule drawn atom by atom", async () => {
    const labelled = await canonical(methoxybutane(true));
    expect(labelled).toContain("@");
    expect(labelled).toBe(await canonical(methoxybutane(false)));
  });

  it("keeps the centre in the flatten guard's own perception", () => {
    const perceived = perceiveStereoCentersFromMolfile(stereoPerceptionMolfile(methoxybutane(true)));
    expect(perceived[0]).toMatchObject({ isStereoCenter: true });
  });
});
