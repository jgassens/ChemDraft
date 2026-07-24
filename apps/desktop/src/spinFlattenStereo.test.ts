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
import { planPageSvgRender } from "@chemdraft/layout-engine";
import { elementFragments } from "@chemdraft/layout-engine/testing";
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
const stereoBondCodes = (molfile: string): Array<{ from: number; to: number; stereo: number }> => {
  const lines = molfile.split(/\r?\n/);
  const countsIndex = lines.findIndex((line) => /\bV2000\b/.test(line));
  const atomCount = Number.parseInt((lines[countsIndex] ?? "").slice(0, 3).trim(), 10);
  const bondCount = Number.parseInt((lines[countsIndex] ?? "").slice(3, 6).trim(), 10);
  const bondStart = countsIndex + 1 + atomCount;
  return lines.slice(bondStart, bondStart + bondCount).map((line) => ({
    from: Number.parseInt(line.slice(0, 3).trim(), 10) - 1,
    to: Number.parseInt(line.slice(3, 6).trim(), 10) - 1,
    stereo: Number.parseInt(line.slice(9, 12).trim(), 10) || 0
  }));
};

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
    expect(result.reason).toBe("stereochemistry");
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

  it("refuses with a legibility reason when a repeated glyph has no CIP-safe relocation", () => {
    const { template, atoms, bonds } = stubMolecule("wedge");
    // Second wedge from the same center: a repeated glyph the relocator must try to move.
    bonds[2] = { ...bonds[2]!, display: { bondStyle: "wedge" } };
    template.bonds = bonds;
    // Only the exact starting configuration (two solid wedges, no hash) reads back correctly, so
    // every relocation trial fails CIP revalidation and the collision cannot be resolved.
    const perceive: StereoPerceiver = (molfile) => {
      const codes = stereoBondCodes(molfile);
      const matchesInitial =
        codes.filter((code) => code.stereo === 1).length === 2 &&
        codes.every((code) => code.stereo !== 6);
      return center(matchesInitial ? "R" : "S");
    };
    const result = reconcileFlattenedStereo(template, atoms, bonds, new Map([[0, "R"]]), perceive);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("legibility");
    expect(result.unresolved).toEqual([]);
  });

  it("uses depth to rank CIP-valid wedge/hash alternatives", () => {
    const { template, atoms, bonds } = stubMolecule("wedge");
    const reader = scriptedReader([center("R")]);
    const result = reconcileFlattenedStereo(
      template,
      atoms,
      bonds,
      new Map([[0, "R"]]),
      reader.read,
      {
        depthByAtomId: new Map([
          ["a0", 0],
          ["a1", -1],
          ["a2", 1],
          ["a3", 0]
        ])
      }
    );
    expect(result.ok).toBe(true);
    // The starting solid wedge points to the farther a1. With every trial declared CIP-valid by
    // this scripted reader, the depth ranker chooses the validated away cue on that bond.
    expect(styleOfB0(result.bonds)).toBe("hashed");
  });

  it("relocates a repeated wedge only through the one whole-molecule-valid trial", () => {
    const atoms: MoleculeAtom[] = [
      { id: "a0", element: "C", x: 0, y: 0, formalCharge: 0 },
      { id: "a1", element: "C", x: 1, y: 0, formalCharge: 0 },
      { id: "a2", element: "N", x: -2, y: 0, formalCharge: 0 },
      { id: "a3", element: "O", x: 0, y: 1, formalCharge: 0 },
      { id: "a4", element: "C", x: 2, y: 0, formalCharge: 0 },
      { id: "a5", element: "F", x: 3, y: 1, formalCharge: 0 },
      { id: "a6", element: "Cl", x: 3, y: -1, formalCharge: 0 }
    ];
    const bonds: MoleculeBond[] = [
      { id: "b0", fromAtomId: "a0", toAtomId: "a1", order: "single", display: { bondStyle: "wedge" } },
      { id: "b1", fromAtomId: "a4", toAtomId: "a1", order: "single", display: { bondStyle: "wedge" } },
      { id: "b2", fromAtomId: "a0", toAtomId: "a2", order: "single" },
      { id: "b3", fromAtomId: "a0", toAtomId: "a3", order: "single" },
      { id: "b4", fromAtomId: "a4", toAtomId: "a5", order: "single" },
      { id: "b5", fromAtomId: "a4", toAtomId: "a6", order: "single" }
    ];
    const template: MoleculeObject = {
      id: "two-center-collision",
      type: "molecule",
      x: 0,
      y: 0,
      width: 6,
      height: 2,
      rotation: 0,
      style: {},
      structureFormat: "molfile-v2000",
      structure: "",
      atoms,
      bonds,
      superatoms: [],
      rGroups: []
    };
    let perceptionCalls = 0;
    const perceive: StereoPerceiver = (molfile) => {
      perceptionCalls += 1;
      const encoded = stereoBondCodes(molfile);
      const initial =
        encoded[0]?.from === 0 && encoded[0]?.to === 1 && encoded[0]?.stereo === 1 &&
        encoded[1]?.from === 4 && encoded[1]?.to === 1 && encoded[1]?.stereo === 1;
      const onlyValidRelocation =
        encoded[0]?.stereo === 0 &&
        encoded[1]?.from === 4 && encoded[1]?.to === 1 && encoded[1]?.stereo === 1 &&
        encoded[2]?.from === 0 && encoded[2]?.to === 2 && encoded[2]?.stereo === 6;
      return atoms.map((_, index): PerceivedAtom => {
        if (index === 0) {
          return {
            isStereoCenter: true,
            descriptor: initial || onlyValidRelocation ? "R" : "S"
          };
        }
        if (index === 4) return { isStereoCenter: true, descriptor: "S" };
        return { isStereoCenter: false, descriptor: "unspecified" };
      });
    };

    const result = reconcileFlattenedStereo(
      template,
      atoms,
      bonds,
      new Map([[0, "R"], [4, "S"]]),
      perceive
    );

    expect(result.ok).toBe(true);
    expect(result.bonds.find((bond) => bond.id === "b0")?.display?.bondStyle).toBeUndefined();
    expect(result.bonds.find((bond) => bond.id === "b2")).toMatchObject({
      fromAtomId: "a0",
      toAtomId: "a2",
      display: { bondStyle: "hashed" }
    });
    expect(perceptionCalls).toBeLessThanOrEqual(6);
  });

  it("rejects a depth-favored sub-pixel marker bond in favor of a readable bond", () => {
    const { template, atoms, bonds } = stubMolecule("wedge");
    atoms[1] = { ...atoms[1]!, x: 1, y: 0 };
    atoms[2] = { ...atoms[2]!, x: 0.001, y: 0 };
    atoms[3] = { ...atoms[3]!, x: -2, y: 0 };
    template.atoms = atoms;
    template.bonds = bonds;
    let perceptionCalls = 0;
    const perceive: StereoPerceiver = () => {
      perceptionCalls += 1;
      return center("R");
    };

    const result = reconcileFlattenedStereo(
      template,
      atoms,
      bonds,
      new Map([[0, "R"]]),
      perceive,
      {
        depthByAtomId: new Map([
          ["a0", 0],
          ["a1", -1],
          ["a2", 10],
          ["a3", 1]
        ])
      }
    );

    expect(result.ok).toBe(true);
    expect(result.bonds.find((bond) => bond.id === "b1")?.display?.bondStyle).toBeUndefined();
    expect(result.bonds.find((bond) => bond.id === "b2")).toMatchObject({
      fromAtomId: "a0",
      toAtomId: "a3",
      display: { bondStyle: "wedge" }
    });
    expect(perceptionCalls).toBeLessThanOrEqual(6);
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
function renderedStereoStyleByBond(
  document: ReturnType<typeof insertSmilesMolecule>
): Map<string, "wedge" | "hashed"> {
  const styles = new Map<string, "wedge" | "hashed">();
  planPageSvgRender(document.pages[0]).fragments
    .flatMap(elementFragments)
    .forEach((fragment) => {
      const bondId = fragment.attrs["data-bond-id"];
      const style = fragment.attrs["data-bond-style"];
      if (
        typeof bondId === "string" &&
        (style === "wedge" || style === "hashed")
      ) {
        styles.set(bondId, style);
      }
    });
  return styles;
}

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
      let depthCueChecks = 0;
      const centerIds = new Set(
        start.atoms.filter((_, i) => perceiveStereoCentersFromMolfile(mf(start))[i]?.isStereoCenter).map((a) => a.id)
      );
      const coords = (await oclConformerGenerator.generate3DConformer({ molfile: mf(start) }, { optimize: "auto" })).mapping
        .coords3dByOriginalAtom;

      let committed = 0;
      for (let attempt = 0; attempt < 40 && committed < 6; attempt += 1) {
        const viewMatrix = quatToViewMatrix(randomQuat());
        const outcome = flattenSpunMolecule(document, molId, coords, viewMatrix, {
          stereoCenterAtomIds: centerIds,
          perceiveStereo: perceiveStereoCentersFromMolfile
        });
        if (outcome.status !== "committed") continue;
        committed += 1;
        const flattened = molOf(outcome.document, molId);
        expect(isoSmiles(flattened), `${name} committed view #${committed} changed stereo`).toBe(startIso);
        const visualStyleByBond = renderedStereoStyleByBond(outcome.document);
        for (const atom of flattened.atoms) {
          const incidentStyles = flattened.bonds
            .filter((bond) =>
              bond.fromAtomId === atom.id || bond.toAtomId === atom.id
            )
            .map((bond) => visualStyleByBond.get(bond.id))
            .filter((style): style is "wedge" | "hashed" => style !== undefined);
          expect(
            incidentStyles.filter((style) => style === "wedge").length,
            `${name} committed view #${committed} rendered duplicate wedges at ${atom.id}`
          ).toBeLessThanOrEqual(1);
          expect(
            incidentStyles.filter((style) => style === "hashed").length,
            `${name} committed view #${committed} rendered duplicate hashes at ${atom.id}`
          ).toBeLessThanOrEqual(1);
        }
        if (name === "strychnine") {
          const benzylicBonds = flattened.bonds
            .filter((bond) => bond.fromAtomId === "a12" || bond.toAtomId === "a12")
            .filter((bond) => visualStyleByBond.has(bond.id));
          if (benzylicBonds.length > 1) {
            depthCueChecks += 1;
            // A two-mark benzylic center must read as one toward-cue and one away-cue. The strict
            // near-bond-gets-the-wedge preference is NOT asserted here: CIP revalidation outranks
            // the depth ranker, and on these committed views the only assignments that read back
            // as strychnine put the wedge on the farther bond. The depth preference itself is
            // pinned by the scripted-reader unit test "uses depth to rank CIP-valid alternatives".
            expect(new Set(benzylicBonds.map((bond) => visualStyleByBond.get(bond.id))))
              .toEqual(new Set(["wedge", "hashed"]));
          }
        }
      }
      expect(committed, `${name}: expected some legible committing orientation`).toBeGreaterThan(0);
      if (name === "strychnine") {
        // The depth-cue assertions above are conditional on the benzylic center rendering two
        // stereo marks. The orientation sweep is a seeded PRNG, so this is deterministic: if no
        // committed view ever exercises the check, fail loudly instead of silently passing.
        expect(
          depthCueChecks,
          "strychnine: no committed view exercised the benzylic depth-cue assertions"
        ).toBeGreaterThan(0);
      }
    }, 180_000);
  }
});
