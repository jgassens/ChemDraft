// Abbreviation ("nickname") labels as chemistry on the desktop paths: the badge, the bond tool,
// copy and save round trips, and the stereo guard. The table and its chemistry are tested in
// packages/template-library and packages/document-workflow-core; this file covers the app wiring.

import { beforeAll, describe, expect, it } from "vitest";
import type { ChemDraftDocument, MoleculeAtom, MoleculeBond, MoleculeObject, ViewMatrix } from "@chemdraft/chem-core";
import { moleculeSmiles, nativeLabelBondSideFromGeometry, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import { perceiveStereoCentersFromMolfile } from "@chemdraft/ocl-adapter";
import { createRdkitAdapter } from "@chemdraft/rdkit-adapter/adapter";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";

import { applyPatch } from "@chemdraft/chem-core";
import {
  analysisFacingStructure,
  applyAnalysisToSelectedMolecule,
  applyClipboardPastePayload,
  applyEditorSaveResultToSelectedMolecule,
  applyFreeformSingleBondToolAtPoint,
  applyNativeAtomElementTarget,
  createSelectionClipboardPayload,
  finishNativeAtomLabelEdit,
  normalizeCommittedDocument,
  pasteSelectionClipboardPayload,
  selectDocumentObject,
  flattenSpunMolecule,
  validationFacingStructure,
  applyNativeMoleculeDeleteTarget,
  applySingleBondToolAtPoint,
  copyAsMolfile,
  createNativeSavePayload,
  createPhase4Document,
  flipDocumentObjectsAroundPoint,
  getSelectedMolecule,
  insertNativeSingleBondMolecule,
  insertNativeTemplateMolecule,
  moveDocumentObject,
  nativeMoleculeInvalidAtomStates,
  openNativeDocument,
  rotateDocumentObjectsAroundPoint
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
      // The status line shows the short reason, with no internal atom id (owner's check on #83).
      expect(states[0]!.invalidReason).toBe("OMe attaches by 1 bond; this atom has 2.");
      expect(states[0]!.invalidReason).not.toContain(ringAtomId);
      expect(states[0]!.invalidDetail).toContain(`"OMe" attaches by 1 bond; atom ${ringAtomId} has 2.`);
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
      expect(nativeMoleculeInvalidAtomStates(molecule)).toMatchObject([{
        atomId: "atom_002", unrecognizedLabel: true, invalidReason: `${label} isn't a known group. Did you mean OMe?`
      }]);
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

describe("cyano labels and the side their bond comes from", () => {
  it("reads SCN as a thiocyanate with its bond on the left, and never as one with it on the right", async () => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Cyano Side"), { x: 300, y: 300 });
    const [left, right] = [...selectedMolecule(ethane).atoms].sort((first, second) => first.x - second.x);
    // On the right end the bond reaches SCN's S: methyl thiocyanate.
    const thiocyanate = selectedMolecule(relabel(ethane, right!.id, "SCN", { literal: true }));
    expect(nativeMoleculeInvalidAtomStates(thiocyanate)).toEqual([]);
    expect(thiocyanate.chemistry?.formula).toBe("C2H3NS");
    expect(await canonical(thiocyanate)).toBe("CSC#N");

    // On the left end the bond reaches its N: an isothiocyanate, which the table lacks. It stays a
    // bare formula: the same atoms counted, no badge, and a placeholder rather than a cyano SMILES.
    const reversedDocument = relabel(ethane, left!.id, "SCN", { literal: true });
    const reversed = selectedMolecule(reversedDocument);
    expect(nativeMoleculeInvalidAtomStates(reversed)).toEqual([]);
    expect(reversed.chemistry?.formula).toBe("C2H3NS");
    expect(await canonical(reversed)).not.toContain("#");
    // A bare formula has no free valence for the bond tool to fill.
    expect(bondsAt(growFrom(reversedDocument, left!.id), reversed.id, left!.id)).toHaveLength(1);
  });
});

describe("a cyano label keeps its meaning through layout", () => {
  const objectOf = (document: ChemDraftDocument, objectId: string): MoleculeObject =>
    document.pages[0]!.objects.find((object): object is MoleculeObject => object.id === objectId)!;
  const centreOf = (molecule: MoleculeObject) => ({
    x: molecule.atoms.reduce((sum, atom) => sum + atom.x, 0) / molecule.atoms.length,
    y: molecule.atoms.reduce((sum, atom) => sum + atom.y, 0) / molecule.atoms.length
  });
  const layouts: Record<string, { apply: (document: ChemDraftDocument, objectId: string) => ChemDraftDocument; turnsRound: boolean }> = {
    "a move": { apply: (document, objectId) => moveDocumentObject(document, objectId, { x: 120, y: 80 }), turnsRound: false },
    "a 180° rotation": {
      apply: (document, objectId) => rotateDocumentObjectsAroundPoint(document, [objectId], centreOf(objectOf(document, objectId)), 180),
      turnsRound: true
    },
    "a horizontal flip": {
      apply: (document, objectId) => flipDocumentObjectsAroundPoint(document, [objectId], centreOf(objectOf(document, objectId)), "horizontal"),
      turnsRound: true
    }
  };
  const cases = ["SCN", "NCS", "CN"].flatMap((label) =>
    (["left end", "right end"] as const).flatMap((end) => Object.keys(layouts).map((layout) => [label, end, layout] as const))
  );

  it.each(cases)("%s on the %s of a bond reads the same after %s", async (label, end, layout) => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Cyano Layout"), { x: 300, y: 300 });
    const sorted = [...selectedMolecule(ethane).atoms].sort((first, second) => first.x - second.x);
    const labelAtomId = (end === "left end" ? sorted[0] : sorted[1])!.id;
    const written = relabel(ethane, labelAtomId, label, { literal: true });
    const objectId = selectedMolecule(written).id;
    const before = objectOf(written, objectId);
    const after = objectOf(layouts[layout]!.apply(written, objectId), objectId);

    // The layout really did turn the bond round (or, for a move, did not)...
    const sideNow = (molecule: MoleculeObject) => {
      const labelAtom = molecule.atoms.find((atom) => atom.id === labelAtomId)!;
      return nativeLabelBondSideFromGeometry(labelAtom, molecule.bonds, molecule.atoms);
    };
    expect(sideNow(after) !== sideNow(before)).toBe(layouts[layout]!.turnsRound);
    // ...and the label means what it was written as: same record, badge, formula and SMILES.
    const labelAtomOf = (molecule: MoleculeObject) => molecule.atoms.find((atom) => atom.id === labelAtomId)!;
    expect(labelAtomOf(after).labelBondSide).toEqual(labelAtomOf(before).labelBondSide);
    expect(nativeMoleculeInvalidAtomStates(after)).toEqual(nativeMoleculeInvalidAtomStates(before));
    expect(after.chemistry?.formula).toBe(before.chemistry?.formula);
    expect(await canonical(after)).toBe(await canonical(before));
  });

  it("records the drawn side when opening a file that has none, then keeps it", async () => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Cyano Open"), { x: 300, y: 300 });
    const right = [...selectedMolecule(ethane).atoms].sort((first, second) => first.x - second.x)[1]!;
    const written = relabel(ethane, right.id, "SCN", { literal: true });
    const objectId = selectedMolecule(written).id;
    // As a file from before the record existed: same label, no record.
    const unrecorded: ChemDraftDocument = {
      ...written,
      pages: written.pages.map((page) => ({
        ...page,
        objects: page.objects.map((object) => object.id !== objectId || object.type !== "molecule" ? object : {
          ...object,
          atoms: object.atoms.map(({ labelBondSide: _labelBondSide, ...atom }) => atom)
        })
      }))
    };
    const saved = createNativeSavePayload(unrecorded).contents;
    expect(saved).not.toContain("labelBondSide");
    const opened = openNativeDocument(saved).document!;
    const labelAtom = objectOf(opened, objectId).atoms.find((atom) => atom.id === right.id)!;
    expect(labelAtom.labelBondSide).toMatchObject({ side: "left" });
    const turned = objectOf(rotateDocumentObjectsAroundPoint(opened, [objectId], centreOf(objectOf(opened, objectId)), 180), objectId);
    expect(await canonical(turned)).toBe("CSC#N");
  });

  it("writes SCN on the right end as methyl thiocyanate and keeps it so once turned round", async () => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Cyano Turned"), { x: 300, y: 300 });
    const right = [...selectedMolecule(ethane).atoms].sort((first, second) => first.x - second.x)[1]!;
    const written = relabel(ethane, right.id, "SCN", { literal: true });
    const objectId = selectedMolecule(written).id;
    const turned = objectOf(rotateDocumentObjectsAroundPoint(written, [objectId], centreOf(objectOf(written, objectId)), 180), objectId);
    expect(await canonical(turned)).toBe("CSC#N");
    expect(turned.chemistry?.formula).toBe("C2H3NS");
  });
});

describe("every way a cyano label enters the document keeps its meaning when turned round", () => {
  // Each path ends in MainWindow's commit funnel (normalizeCommittedDocument), as every in-app
  // change does; each test then turns the molecule round (rotate 180°, itself committed through the
  // funnel) and checks the reading did not follow the drawing.
  const objectOf = (document: ChemDraftDocument, objectId: string): MoleculeObject =>
    document.pages[0]!.objects.find((object): object is MoleculeObject => object.id === objectId)!;
  const moleculesOf = (document: ChemDraftDocument): MoleculeObject[] =>
    document.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule");
  const turnRound = (document: ChemDraftDocument, objectId: string): ChemDraftDocument => {
    const molecule = objectOf(document, objectId);
    const centre = {
      x: molecule.atoms.reduce((sum, atom) => sum + atom.x, 0) / molecule.atoms.length,
      y: molecule.atoms.reduce((sum, atom) => sum + atom.y, 0) / molecule.atoms.length
    };
    return normalizeCommittedDocument(rotateDocumentObjectsAroundPoint(document, [objectId], centre, 180));
  };
  /** Methyl thiocyanate typed on the right end of a bond (its bond on the left), then turned round. */
  const writtenThenTurned = (): { document: ChemDraftDocument; objectId: string; labelAtomId: string } => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Cyano Ingress"), { x: 300, y: 300 });
    const right = [...selectedMolecule(ethane).atoms].sort((first, second) => first.x - second.x)[1]!;
    const written = normalizeCommittedDocument(relabel(ethane, right.id, "SCN", { literal: true }));
    const objectId = selectedMolecule(written).id;
    return { document: turnRound(written, objectId), objectId, labelAtomId: right.id };
  };

  it("through the commit funnel: a molecule added unrecorded (a plugin's patch, an agent command)", async () => {
    // As a plugin or agent adds it: a chem-core addObject with a typed SCN and no recorded side.
    const molecule = {
      ...selectedMolecule(insertNativeSingleBondMolecule(createPhase4Document("Plugin"), { x: 300, y: 300 })),
      id: "plugin_molecule"
    };
    const sorted = [...molecule.atoms].sort((first, second) => first.x - second.x);
    const unrecorded: MoleculeObject = {
      ...molecule,
      atoms: molecule.atoms.map((atom) => (atom.id === sorted[1]!.id ? { ...atom, element: "SCN", labelLiteral: true } : atom))
    };
    const added = normalizeCommittedDocument(applyPatch(
      createPhase4Document("Plugin Patch"),
      { op: "addObject", pageId: createPhase4Document("Plugin Patch").pages[0]!.id, object: unrecorded }
    ));
    expect(objectOf(added, "plugin_molecule").atoms.find((atom) => atom.element === "SCN")!.labelBondSide)
      .toMatchObject({ side: "left" });
    expect(await canonical(objectOf(turnRound(added, "plugin_molecule"), "plugin_molecule"))).toBe("CSC#N");
  });

  it("through a MOL paste", async () => {
    const molfile = [
      "", "  ChemDraft", "",
      "  0  0  0     0  0            999 V3000",
      "M  V30 BEGIN CTAB",
      "M  V30 COUNTS 2 1 0 0 0",
      "M  V30 BEGIN ATOM",
      "M  V30 1 C 0 0 0 0",
      "M  V30 2 SCN 1 0 0 0",
      "M  V30 END ATOM",
      "M  V30 BEGIN BOND",
      "M  V30 1 1 1 2",
      "M  V30 END BOND",
      "M  V30 END CTAB",
      "M  END"
    ].join("\n");
    const pasted = applyClipboardPastePayload(createPhase4Document("MOL Paste"), {
      kind: "molfile", format: "molfile-v3000", text: molfile, warnings: []
    }, { x: 300, y: 300 });
    const committed = normalizeCommittedDocument(pasted.document);
    const objectId = moleculesOf(committed)[0]!.id;
    expect(await canonical(objectOf(committed, objectId))).toBe("CSC#N");
    expect(await canonical(objectOf(turnRound(committed, objectId), objectId))).toBe("CSC#N");
  });

  it("through a V2000 MOL paste, whose 3-character atom field takes a literal SCN", async () => {
    const atomLine = (x: string, symbol: string) =>
      `${x.padStart(10)}${"0.0000".padStart(10)}${"0.0000".padStart(10)} ${symbol.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`;
    const molfile = [
      "", "  ChemDraft", "",
      "  2  1  0  0  0  0  0  0  0  0999 V2000",
      atomLine("0.0000", "C"),
      atomLine("1.0000", "SCN"),
      "  1  2  1  0",
      "M  END"
    ].join("\n");
    const pasted = applyClipboardPastePayload(createPhase4Document("V2000 Paste"), {
      kind: "molfile", format: "molfile-v2000", text: molfile, warnings: []
    }, { x: 300, y: 300 });
    const committed = normalizeCommittedDocument(pasted.document);
    const objectId = moleculesOf(committed)[0]!.id;
    expect(objectOf(committed, objectId).atoms.map((atom) => atom.element).sort()).toEqual(["C", "SCN"]);
    expect(await canonical(objectOf(committed, objectId))).toBe("CSC#N");
    expect(await canonical(objectOf(turnRound(committed, objectId), objectId))).toBe("CSC#N");
  });

  /** The molecule as the structure editor saves it: a V3000 of its atoms in order, y up. */
  const editorV3000 = (molecule: MoleculeObject): string => [
    "-INDIGO-", "", "  0  0  0  0  0  0  0  0  0  0  0 V3000",
    "M  V30 BEGIN CTAB",
    `M  V30 COUNTS ${molecule.atoms.length} ${molecule.bonds.length} 0 0 0`,
    "M  V30 BEGIN ATOM",
    ...molecule.atoms.map((atom, index) => `M  V30 ${index + 1} ${atom.element} ${(atom.x / 30).toFixed(4)} ${(-atom.y / 30).toFixed(4)} 0.0 0`),
    "M  V30 END ATOM",
    "M  V30 BEGIN BOND",
    ...molecule.bonds.map((bond, index) => {
      const from = molecule.atoms.findIndex((atom) => atom.id === bond.fromAtomId) + 1;
      const to = molecule.atoms.findIndex((atom) => atom.id === bond.toAtomId) + 1;
      return `M  V30 ${index + 1} 1 ${from} ${to}`;
    }),
    "M  V30 END BOND", "M  V30 END CTAB", "M  END"
  ].join("\n");

  it("through a structure-editor save that writes a new SCN label", async () => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Editor Save"), { x: 300, y: 300 });
    const selected = selectedMolecule(ethane);
    const right = [...selected.atoms].sort((first, second) => first.x - second.x)[1]!;
    // The editor hands back the molecule with its right-hand carbon now labelled SCN.
    const edited = { ...selected, atoms: selected.atoms.map((atom) => (atom.id === right.id ? { ...atom, element: "SCN" } : atom)) };
    const saved = normalizeCommittedDocument(applyEditorSaveResultToSelectedMolecule(ethane, {
      object: { ...selected, structureFormat: "molfile-v3000", structure: editorV3000(edited) },
      warnings: []
    }));
    expect(await canonical(objectOf(saved, selected.id))).toBe("CSC#N");
    expect(await canonical(objectOf(turnRound(saved, selected.id), selected.id))).toBe("CSC#N");
  });

  it("through an unchanged structure-editor round trip of a turned-round molecule", async () => {
    const { document, objectId } = writtenThenTurned();
    const turned = objectOf(document, objectId);
    // Opened in the editor and saved without changes: every atom comes back from the V3000, the
    // SCN now drawn with its bond on the right. Its record is carried, so it stays a thiocyanate.
    const selected = selectDocumentObject(document, objectId);
    const saved = normalizeCommittedDocument(applyEditorSaveResultToSelectedMolecule(selected, {
      object: { ...turned, structureFormat: "molfile-v3000", structure: editorV3000(turned) },
      warnings: []
    }));
    expect(await canonical(objectOf(saved, objectId))).toBe("CSC#N");
  });

  it("through a native copy and paste", async () => {
    const { document, objectId } = writtenThenTurned();
    const selected = selectDocumentObject(document, objectId);
    const payload = createSelectionClipboardPayload(selected)!;
    const pasted = normalizeCommittedDocument(pasteSelectionClipboardPayload(selected, payload, { x: 500, y: 500 }));
    const copy = moleculesOf(pasted).find((molecule) => molecule.id !== objectId)!;
    expect(await canonical(copy)).toBe("CSC#N");
    expect(await canonical(objectOf(turnRound(pasted, copy.id), copy.id))).toBe("CSC#N");
  });

  it("through opening a CDXML file with no embedded document", async () => {
    const ethane = insertNativeSingleBondMolecule(createPhase4Document("Cyano CDXML"), { x: 300, y: 300 });
    const right = [...selectedMolecule(ethane).atoms].sort((first, second) => first.x - second.x)[1]!;
    const contents = createNativeSavePayload(relabel(ethane, right.id, "SCN", { literal: true })).contents
      .replace(/<objecttag[^>]*Name="org\.chemdraft\/native-document"[^>]*\/>/g, "");
    const opened = openNativeDocument(contents);
    expect(opened.source).toBe("external-cdxml");
    const committed = normalizeCommittedDocument(opened.document!);
    const objectId = moleculesOf(committed)[0]!.id;
    expect(await canonical(objectOf(turnRound(committed, objectId), objectId))).toBe("CSC#N");
  });

  it("through a bond that merges the molecule into another (its ids are re-minted)", async () => {
    const { document, objectId } = writtenThenTurned();
    const withEthane = insertNativeSingleBondMolecule(document, { x: 120, y: 120 });
    const ethaneId = moleculesOf(withEthane).find((molecule) => molecule.id !== objectId)!.id;
    const ethaneAtom = objectOf(withEthane, ethaneId).atoms[0]!;
    // The methyl carbon of the turned thiocyanate: the label's own neighbour keeps its one bond.
    const methyl = objectOf(withEthane, objectId).atoms.find((atom) => atom.element === "C")!;
    const merged = normalizeCommittedDocument(applyFreeformSingleBondToolAtPoint(withEthane, ethaneId, ethaneAtom.id, { x: methyl.x, y: methyl.y }));
    expect(moleculesOf(merged)).toHaveLength(1);
    const smiles = await canonical(moleculesOf(merged)[0]!);
    expect(smiles).toContain("SC#N");
    expect(smiles).not.toContain("*");
  });

  it("through Copy As MOL of two molecules at once (ids namespaced in the merged copy)", async () => {
    const { document } = writtenThenTurned();
    const withEthane = insertNativeSingleBondMolecule(document, { x: 120, y: 120 });
    const scoped = { ...withEthane, selection: { ...withEthane.selection, objectIds: [] } };
    const smiles = (await computeStructureIdentifiers(copyAsMolfile(scoped, "v3000")!))?.smiles;
    expect(smiles?.split(".").sort()).toEqual(["CC", "CSC#N"]);
  });

  it("through a cancelled label edit", async () => {
    const { document, objectId, labelAtomId } = writtenThenTurned();
    const initial = objectOf(document, objectId).atoms.find((atom) => atom.id === labelAtomId)!;
    expect(initial.labelBondSide).toMatchObject({ side: "left" });
    // A keystroke replaces the label (dropping its record); Escape puts it back as MainWindow does.
    const target = { objectId, kind: "atom" as const, atomId: labelAtomId, distanceToPointer: 0 };
    const typed = normalizeCommittedDocument(applyNativeAtomElementTarget(document, target, "O", { literal: true }));
    const cancelled = normalizeCommittedDocument(applyNativeAtomElementTarget(typed, target, "SCN", {
      literal: true, labelBondSide: initial.labelBondSide
    }));
    expect(objectOf(cancelled, objectId).atoms.find((atom) => atom.id === labelAtomId)!.labelBondSide).toEqual(initial.labelBondSide);
    expect(await canonical(objectOf(cancelled, objectId))).toBe("CSC#N");
  });

  it("through undo and redo: a committed document passes the funnel unchanged", () => {
    const { document } = writtenThenTurned();
    expect(normalizeCommittedDocument(document)).toBe(document);
  });

  it("through one edit session that ends on its starting text (SCN → O → SCN, Enter): unchanged", async () => {
    const { document, objectId, labelAtomId } = writtenThenTurned();
    const initialAtom = objectOf(document, objectId).atoms.find((atom) => atom.id === labelAtomId)!;
    const initial = { element: initialAtom.element, literal: true, labelBondSide: initialAtom.labelBondSide };
    const target = { objectId, kind: "atom" as const, atomId: labelAtomId, distanceToPointer: 0 };
    // Each keystroke is committed through the funnel, as MainWindow's label editor does.
    const typedO = normalizeCommittedDocument(applyNativeAtomElementTarget(document, target, "O", { literal: true }));
    const typedBack = normalizeCommittedDocument(applyNativeAtomElementTarget(typedO, target, "SCN", { literal: true }));
    // Without the finish, the retyped label would be read from the turned-round drawing.
    expect(await canonical(objectOf(typedBack, objectId))).not.toContain("#");
    const finished = normalizeCommittedDocument(finishNativeAtomLabelEdit(typedBack, target, initial));
    expect(objectOf(finished, objectId).atoms.find((atom) => atom.id === labelAtomId)!.labelBondSide).toEqual(initial.labelBondSide);
    expect(await canonical(objectOf(finished, objectId))).toBe("CSC#N");
  });

  it("through two committed edits (SCN → O, Enter; O → SCN, Enter): a newly written label, read from the drawing", async () => {
    const { document, objectId, labelAtomId } = writtenThenTurned();
    const target = { objectId, kind: "atom" as const, atomId: labelAtomId, distanceToPointer: 0 };
    const startOf = (source: ChemDraftDocument) => {
      const atom = objectOf(source, objectId).atoms.find((candidate) => candidate.id === labelAtomId)!;
      return { element: atom.element, literal: atom.labelLiteral === true, labelBondSide: atom.labelBondSide };
    };
    // First session: SCN → O, committed. It ended on other text, so the finish changes nothing.
    const firstStart = startOf(document);
    const toO = normalizeCommittedDocument(applyNativeAtomElementTarget(document, target, "O", { literal: true }));
    const firstDone = normalizeCommittedDocument(finishNativeAtomLabelEdit(toO, target, firstStart));
    expect(firstDone).toBe(toO);
    // Second session: O → SCN, committed. A new label on a drawing whose bond is now on its right:
    // recorded from the drawing, so it is the N-bonded isomer, a bare formula.
    const secondStart = startOf(firstDone);
    const toScn = normalizeCommittedDocument(applyNativeAtomElementTarget(firstDone, target, "SCN", { literal: true }));
    const secondDone = normalizeCommittedDocument(finishNativeAtomLabelEdit(toScn, target, secondStart));
    expect(objectOf(secondDone, objectId).atoms.find((atom) => atom.id === labelAtomId)!.labelBondSide).toMatchObject({ side: "right" });
    expect(await canonical(objectOf(secondDone, objectId))).not.toContain("#");
  });
});

describe("the commit funnel when nothing changes", () => {
  const objectOf = (document: ChemDraftDocument, objectId: string): MoleculeObject =>
    document.pages[0]!.objects.find((object): object is MoleculeObject => object.id === objectId)!;
  const moleculesOf = (document: ChemDraftDocument): MoleculeObject[] =>
    document.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule");

  it("returns the very same document, molecules and atoms, so nothing re-renders or recomputes", () => {
    const first = insertNativeSingleBondMolecule(createPhase4Document("Funnel Identity"), { x: 200, y: 200 });
    const firstId = selectedMolecule(first).id;
    const right = [...selectedMolecule(first).atoms].sort((a, b) => a.x - b.x)[1]!;
    const labelled = normalizeCommittedDocument(relabel(first, right.id, "SCN", { literal: true }));
    const both = normalizeCommittedDocument(insertNativeSingleBondMolecule(labelled, { x: 500, y: 500 }));
    // A committed document passes again untouched.
    expect(normalizeCommittedDocument(both)).toBe(both);
    // An edit to one molecule: the funnel keeps the other molecule, and the edited molecule's
    // atoms, as the very objects the edit produced.
    const otherId = moleculesOf(both).find((molecule) => molecule.id !== firstId)!.id;
    const edited = rotateDocumentObjectsAroundPoint(both, [otherId], { x: 500, y: 500 }, 90);
    const committed = normalizeCommittedDocument(edited);
    expect(committed).toBe(edited);
    expect(objectOf(committed, firstId)).toBe(objectOf(both, firstId));
    objectOf(committed, otherId).atoms.forEach((atom, index) => expect(atom).toBe(objectOf(edited, otherId).atoms[index]));
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
