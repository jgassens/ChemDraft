/**
 * Regression tests for the flatten stereo read-back guard (`reconcileFlattenedStereo` +
 * `flattenSpunMolecule`'s `perceiveStereo` option).
 *
 * Background: the perspective encoder proved each wedge sound against its own geometric model, but
 * that model mis-read the squished 2D projection of dense fused cages (strychnine, fenchol, …),
 * silently committing a DIFFERENT stereoisomer. The fix asks the real CIP perceiver to read the
 * drawing back and flips any center that reads the wrong hand (or refuses if unfixable). These
 * tests are the tripwire: the fast ones pin the repair ALGORITHM with a scripted fake reader; the
 * slow ones pin the actual CHEMISTRY end-to-end on the historical reproducers.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  moleculeToMolfileV2000,
  type MoleculeAtom,
  type MoleculeBond,
  type MoleculeObject
} from "@chemdraft/chem-core";
import {
  depictSmiles2D,
  ensureOclResources,
  oclConformerGenerator,
  perceiveStereoCentersFromMolfile,
  type Depiction2D
} from "@chemdraft/ocl-adapter";
import { Molecule } from "openchemlib";

import {
  createPhase4Document,
  flattenSpunMolecule,
  insertSmilesMolecule,
  reconcileFlattenedStereo,
  type PastedStructureDepiction,
  type StereoPerceiver
} from "./documentWorkflow";
import { quatFromAxisAngle, quatNormalize, quatToViewMatrix, type Quaternion } from "./interaction/rotation3d";

// --- fast unit tests: the repair algorithm, with a fake reader (no chemistry engine) -----------

type PerceivedAtom = { isStereoCenter: boolean; descriptor: "R" | "S" | "unspecified" };

/** A 4-atom stub: center a0 (index 0) + three neighbours; a0-a1 optionally carries the wedge. */
function stubMolecule(centerWedge?: "wedge" | "hashed", wedgeNarrowAtCenter = true): {
  template: MoleculeObject;
  atoms: MoleculeAtom[];
  bonds: MoleculeBond[];
} {
  const atoms: MoleculeAtom[] = [
    { id: "a0", element: "C", x: 0, y: 0, formalCharge: 0 },
    { id: "a1", element: "N", x: 1, y: 0, formalCharge: 0 },
    { id: "a2", element: "O", x: 0, y: 1, formalCharge: 0 },
    { id: "a3", element: "F", x: -1, y: -1, formalCharge: 0 }
  ];
  const wedgeBond: MoleculeBond = {
    id: "b0",
    fromAtomId: wedgeNarrowAtCenter ? "a0" : "a1",
    toAtomId: wedgeNarrowAtCenter ? "a1" : "a0",
    order: "single",
    ...(centerWedge ? { display: { bondStyle: centerWedge } } : {})
  };
  const bonds: MoleculeBond[] = [
    wedgeBond,
    { id: "b1", fromAtomId: "a0", toAtomId: "a2", order: "single" },
    { id: "b2", fromAtomId: "a0", toAtomId: "a3", order: "single" }
  ];
  const template: MoleculeObject = {
    id: "stub",
    type: "molecule",
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    rotation: 0,
    style: {},
    structureFormat: "molfile-v2000",
    structure: "",
    atoms,
    bonds,
    superatoms: [],
    rGroups: []
  };
  return { template, atoms, bonds };
}

/** A reader that ignores the molfile and returns scripted results, one per call (clamped to last). */
function scriptedReader(script: PerceivedAtom[][]): { read: StereoPerceiver; calls: () => number } {
  let n = 0;
  const read: StereoPerceiver = () => script[Math.min(n++, script.length - 1)];
  return { read, calls: () => n };
}
const center = (descriptor: "R" | "S" | "unspecified", isStereoCenter = true): PerceivedAtom[] => [
  { isStereoCenter, descriptor },
  { isStereoCenter: false, descriptor: "unspecified" },
  { isStereoCenter: false, descriptor: "unspecified" },
  { isStereoCenter: false, descriptor: "unspecified" }
];
const styleOfB0 = (bonds: MoleculeBond[]) => bonds.find((b) => b.id === "b0")?.display?.bondStyle;

describe("reconcileFlattenedStereo — repair algorithm", () => {
  it("leaves a depiction that already reads correctly untouched", () => {
    const { template, atoms, bonds } = stubMolecule("wedge");
    const reader = scriptedReader([center("R")]);
    const result = reconcileFlattenedStereo(template, atoms, bonds, new Map([[0, "R"]]), reader.read);
    expect(result.ok).toBe(true);
    expect(styleOfB0(result.bonds)).toBe("wedge"); // unchanged
    expect(reader.calls()).toBe(1);
  });

  it("flips a center that reads the wrong hand, then confirms", () => {
    const { template, atoms, bonds } = stubMolecule("wedge");
    const reader = scriptedReader([center("S"), center("R")]); // wrong, then correct after the flip
    const result = reconcileFlattenedStereo(template, atoms, bonds, new Map([[0, "R"]]), reader.read);
    expect(result.ok).toBe(true);
    expect(styleOfB0(result.bonds)).toBe("hashed"); // wedge → hashed
  });

  it("refuses (ok:false) when no flip ever reads correctly", () => {
    const { template, atoms, bonds } = stubMolecule("wedge");
    const reader = scriptedReader([center("S")]); // always wrong
    const result = reconcileFlattenedStereo(template, atoms, bonds, new Map([[0, "R"]]), reader.read);
    expect(result.ok).toBe(false);
    expect(result.unresolved).toContain(0);
  });

  it("does nothing (and never reads) when no center was specified before the flatten", () => {
    const { template, atoms, bonds } = stubMolecule("wedge");
    const reader = scriptedReader([center("S")]);
    const result = reconcileFlattenedStereo(template, atoms, bonds, new Map(), reader.read);
    expect(result.ok).toBe(true);
    expect(reader.calls()).toBe(0);
  });

  it("refuses a wrong center that has no own wedge to flip", () => {
    const { template, atoms, bonds } = stubMolecule("wedge", /* wedgeNarrowAtCenter */ false);
    const reader = scriptedReader([center("S")]);
    const result = reconcileFlattenedStereo(template, atoms, bonds, new Map([[0, "R"]]), reader.read);
    expect(result.ok).toBe(false);
    expect(result.unresolved).toContain(0);
  });
});

// --- slow end-to-end tests: real chemistry on the historical reproducers -----------------------

const molOf = (document: ReturnType<typeof insertSmilesMolecule>, id: string): MoleculeObject => {
  const found = document.pages[0].objects.find((object) => object.id === id);
  if (!found || found.type !== "molecule") throw new Error("molecule missing");
  return found;
};
const mf = (mol: MoleculeObject) => moleculeToMolfileV2000(mol, { fromDocFrame: true });
const isoSmiles = (mol: MoleculeObject) => Molecule.fromMolfile(mf(mol)).toIsomericSmiles();

function placeSmiles(smiles: string) {
  const dep: Depiction2D = depictSmiles2D(smiles);
  const pasted: PastedStructureDepiction = {
    atoms: dep.atoms.map((a) => ({ element: a.element, x: a.x, y: a.y, charge: a.charge })),
    bonds: dep.bonds.map((b) => ({ from: b.from, to: b.to, order: b.order === "unknown" ? "single" : b.order, wedge: b.wedge }))
  };
  const document = insertSmilesMolecule(createPhase4Document("stereo-fixture"), { x: 400, y: 320 }, pasted, smiles);
  const mol = document.pages[0].objects.find((o): o is MoleculeObject => o.type === "molecule");
  if (!mol) throw new Error("placement produced no molecule");
  return { document, molId: mol.id, start: mol };
}

let seed = 0x51117;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 0xffffffff);
function randomQuat(): Quaternion {
  const a: [number, number, number] = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
  const l = Math.hypot(...a) || 1;
  return quatNormalize(quatFromAxisAngle([a[0] / l, a[1] / l, a[2] / l], 0.3 + rand() * Math.PI));
}

describe("flattenSpunMolecule — stereo preserved end-to-end (real perceiver)", () => {
  beforeAll(async () => {
    await ensureOclResources();
  }, 120_000);

  // strychnine + fenchol historically corrupted on 100% of committed views; menthol is a control.
  for (const [name, smiles] of Object.entries({
    strychnine: "O=C1C[C@H]2OCC=C3CN4CC[C@]56[C@H]4C[C@H]3[C@@H]2[C@@H]5N1c1ccccc16",
    fenchol: "CC1(C)[C@@H]2CC[C@]1(C)[C@@H](O)C2",
    menthol: "CC(C)[C@@H]1CC[C@@H](C)C[C@H]1O"
  })) {
    it(`${name}: no committed flatten changes the stereoisomer`, async () => {
      const { document, molId, start } = placeSmiles(smiles);
      const startIso = isoSmiles(start);
      const centerIds = new Set(
        start.atoms.filter((_, i) => perceiveStereoCentersFromMolfile(mf(start))[i]?.isStereoCenter).map((a) => a.id)
      );
      const coords = (await oclConformerGenerator.generate3DConformer({ molfile: mf(start) }, { optimize: "auto" })).mapping
        .coords3dByOriginalAtom;

      let committed = 0;
      for (let attempt = 0; attempt < 40 && committed < 6; attempt += 1) {
        const outcome = flattenSpunMolecule(document, molId, coords, quatToViewMatrix(randomQuat()), {
          stereoCenterAtomIds: centerIds,
          perceiveStereo: perceiveStereoCentersFromMolfile
        });
        if (outcome.status !== "committed") continue;
        committed += 1;
        expect(isoSmiles(molOf(outcome.document, molId)), `${name} committed view #${committed} changed stereo`).toBe(startIso);
      }
      expect(committed, `${name}: expected some legible committing orientation`).toBeGreaterThan(0);
    }, 180_000);
  }
});
