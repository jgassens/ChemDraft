/**
 * SMILES paste — `insertSmilesMolecule` renders a pasted SMILES into an editable 2D
 * molecule with correct stereochemistry. Proves the depiction→document path keeps
 * chirality: the committed molfile re-parses through OpenChemLib with the same defined
 * stereocenters, and enantiomers land with opposite CIP (no accidental racemization or
 * mirroring through the y-frame negation).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as OCL from "openchemlib";

import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import {
  depictSmiles2D,
  ensureOclResources,
  type Depiction2D
} from "@chemdraft/ocl-adapter";
import { planPageSvgRender, type PageSvgElementFragment, type PageSvgFragment } from "@chemdraft/layout-engine";
import {
  generateSmiles2DMolfile,
  resetRdkitForTesting,
  setRdkitModuleLoader,
  type RdkitMinimalModule
} from "@chemdraft/rdkit-adapter";

import {
  createPhase4Document,
  insertSmilesMolecule,
  pastedStructureDepictionFromMolfile,
  smilesPasteBondLengthPx,
  type PastedStructureDepiction
} from "./documentWorkflow";

const POINT = { x: 200, y: 200 };

// The user's test peptide (a ~30-residue chain, dozens of stereocenters).
const PEPTIDE =
  "CC[C@H](C)[C@@H](C(=O)N[C@@H](C)C(=O)N[C@@H](CC1=CNC2=CC=CC=C21)C(=O)N[C@@H](CC(C)C)C(=O)N[C@@H](C(C)C)C(=O)N[C@@H](CCCCN)C(=O)NCC(=O)N[C@@H](CCCNC(=N)N)C(=O)N)NC(=O)[C@H](CC3=CC=CC=C3)NC(=O)[C@H](CCC(=O)O)NC(=O)[C@H](CCCCN)NC(=O)[C@H](C)NC(=O)[C@H](C)NC(=O)[C@H](CCC(=O)N)NC(=O)CNC(=O)[C@H](CCC(=O)O)NC(=O)[C@H](CC(C)C)NC(=O)[C@H](CC4=CC=C(C=C4)O)NC(=O)[C@H](CO)NC(=O)[C@H](CO)NC(=O)[C@H](C(C)C)NC(=O)[C@H](CC(=O)O)NC(=O)[C@H](CO)NC(=O)[C@H]([C@@H](C)O)NC(=O)[C@H](CC5=CC=CC=C5)NC(=O)[C@H]([C@@H](C)O)NC(=O)CNC(=O)[C@H](CCC(=O)O)NC(=O)[C@H](C)NC(=O)[C@H](CC6=CNC=N6)N";
const CROWDED_STEREO_SMILES =
  "C1CN2CC3=CCO[C@H]4CC(=O)N5[C@H]6[C@H]4[C@H]3C[C@H]2[C@@]61C7=CC=CC=C75";
const REPORTED_POLYETHER_SMILES =
  "C[C@@H]1C[C@H]2[C@@H](C[C@]3([C@H](O2)C[C@H]4[C@H](O3)C(=CC(=O)O4)C)C)O[C@@H]5[C@@H]1O[C@H]6C[C@@H]7[C@](C[C@@H]8[C@@H](O7)C/C=C\\[C@@H]9[C@@H](O8)C[C@@H]1[C@@H](O9)C[C@@H]2[C@@](O1)([C@H](C[C@H](O2)CC(=C)C=O)O)C)(O[C@@]6(CC5)C)C";

function toPasted(depiction: Depiction2D): PastedStructureDepiction {
  return {
    atoms: depiction.atoms.map((atom) => ({
      element: atom.element,
      x: atom.x,
      y: atom.y,
      charge: atom.charge
    })),
    bonds: depiction.bonds.map((bond) => ({
      from: bond.from,
      to: bond.to,
      order: bond.order === "aromatic" || bond.order === "unknown" ? "single" : bond.order,
      wedge: bond.wedge
    }))
  };
}

function pasteSmiles(smiles: string): MoleculeObject {
  const document = createPhase4Document("SMILES paste fixture");
  const fallback = depictSmiles2D(smiles);
  let depiction: PastedStructureDepiction;
  try {
    depiction = pastedStructureDepictionFromMolfile(fallback.molfile);
  } catch {
    depiction = toPasted(fallback);
  }
  const next = insertSmilesMolecule(document, POINT, depiction, smiles);
  const placed = next.pages[0].objects.find((object) => object.type === "molecule");
  if (!placed || placed.type !== "molecule") throw new Error("no molecule placed");
  return placed;
}

function elementFragments(fragment: PageSvgFragment): PageSvgElementFragment[] {
  return fragment.kind === "text" ? [] : [fragment, ...fragment.children.flatMap(elementFragments)];
}

const isWedge = (bond: MoleculeObject["bonds"][number]) =>
  bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed";

/** Defined CIP stereocenters OpenChemLib re-perceives from a committed molfile. */
function definedStereocenters(molfile: string): Array<{ atom: number; cip: number }> {
  const molecule = OCL.Molecule.fromMolfile(molfile);
  molecule.ensureHelperArrays(OCL.Molecule.cHelperCIP);
  const centers: Array<{ atom: number; cip: number }> = [];
  for (let a = 0; a < molecule.getAllAtoms(); a += 1) {
    const cip = molecule.getAtomCIPParity(a);
    if (molecule.isAtomStereoCenter(a) && cip !== 0) centers.push({ atom: a, cip });
  }
  return centers;
}

beforeAll(async () => {
  await ensureOclResources();
  const glueUrl = new URL("../../../packages/rdkit-adapter/vendor/RDKit_minimal.js", import.meta.url);
  const wasmUrl = new URL("../../../packages/rdkit-adapter/vendor/RDKit_minimal.wasm", import.meta.url);
  const glueSource = readFileSync(glueUrl, "utf8");
  const wasmBinary = new Uint8Array(readFileSync(wasmUrl));
  const factory = new Function("require", "__dirname", `${glueSource}\n;return initRDKitModule;`)(
    createRequire(import.meta.url),
    dirname(fileURLToPath(glueUrl))
  ) as (options: {
    locateFile: (file: string) => string;
    wasmBinary: Uint8Array;
  }) => Promise<RdkitMinimalModule>;
  setRdkitModuleLoader(() => factory({
    locateFile: () => fileURLToPath(wasmUrl),
    wasmBinary
  }));
});

afterAll(() => resetRdkitForTesting());

describe("insertSmilesMolecule — renders pasted SMILES with stereochemistry", () => {
  it("places a chiral molecule with a wedge and a re-perceivable stereocenter", () => {
    const molecule = pasteSmiles("C[C@H](F)Cl");
    expect(molecule.atoms.length).toBe(4);
    expect(molecule.bonds.length).toBe(3);
    expect(molecule.bonds.some(isWedge)).toBe(true);
    expect(definedStereocenters(molecule.structure).length).toBeGreaterThanOrEqual(1);

    // Landed near the paste point.
    const cx = molecule.atoms.reduce((sum, atom) => sum + atom.x, 0) / molecule.atoms.length;
    const cy = molecule.atoms.reduce((sum, atom) => sum + atom.y, 0) / molecule.atoms.length;
    expect(Math.abs(cx - POINT.x)).toBeLessThan(120);
    expect(Math.abs(cy - POINT.y)).toBeLessThan(120);
  });

  it("enantiomers paste with opposite CIP (no racemization / mirror through y-negation)", () => {
    const r = definedStereocenters(pasteSmiles("C[C@H](F)Cl").structure);
    const s = definedStereocenters(pasteSmiles("C[C@@H](F)Cl").structure);
    expect(r).toHaveLength(1);
    expect(s).toHaveLength(1);
    expect(r[0].cip).not.toBe(s[0].cip);
  });

  it("recomputes a drawn side for every double bond (benzene ring interior)", () => {
    const molecule = pasteSmiles("c1ccccc1");
    const doubles = molecule.bonds.filter((bond) => bond.order === "double");
    expect(doubles.length).toBeGreaterThanOrEqual(1);
    expect(doubles.every((bond) => bond.display?.doubleBondSide === "left" || bond.display?.doubleBondSide === "right")).toBe(true);
  });

  it("renders the large peptide SMILES with many preserved stereocenters", () => {
    const molecule = pasteSmiles(PEPTIDE);
    expect(molecule.atoms.length).toBeGreaterThan(100);
    expect(molecule.bonds.filter(isWedge).length).toBeGreaterThan(10);
    // The committed structure round-trips through OCL with most stereocenters intact.
    expect(definedStereocenters(molecule.structure).length).toBeGreaterThan(10);
  });

  it("gives the reported bridged polycycle open bond spacing and restrained stereo marks", () => {
    const molecule = pasteSmiles(CROWDED_STEREO_SMILES);
    expect(molecule.atoms).toHaveLength(25);
    expect(molecule.bonds).toHaveLength(31);
    expect(molecule.bonds.filter(isWedge)).toHaveLength(6);
    // Pin the literal so a regressed constant cannot silently self-validate below.
    expect(smilesPasteBondLengthPx).toBe(28);
    expect(molecule.style.bondLengthPx).toBe(smilesPasteBondLengthPx);

    const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
    const bondLengths = molecule.bonds.map((bond) => {
      const from = atomById.get(bond.fromAtomId);
      const to = atomById.get(bond.toAtomId);
      return from && to ? Math.hypot(to.x - from.x, to.y - from.y) : 0;
    });
    const meanBondLength = bondLengths.reduce((sum, length) => sum + length, 0) / bondLengths.length;
    expect(meanBondLength).toBeCloseTo(smilesPasteBondLengthPx, 6);

    const page = createEmptyDocument({ now: "2026-07-22T00:00:00.000Z" }).pages[0];
    const fragments = planPageSvgRender({ ...page, objects: [molecule] }).fragments.flatMap(elementFragments);
    const wedgePolygons = fragments.filter((fragment) =>
      fragment.tag === "polygon" && fragment.attrs["data-bond-style"] === "wedge"
    );
    expect(wedgePolygons.length).toBeGreaterThan(0);
    wedgePolygons.forEach((wedge) => {
      const points = String(wedge.attrs.points ?? "").split(/\s+/).map((point) => {
        const [x, y] = point.split(",").map(Number);
        return { x, y };
      });
      const [tip, wideLeft, wideRight] = points;
      if (!tip || !wideLeft || !wideRight) {
        throw new Error("Expected a three-point stereo wedge.");
      }
      const wideCenter = {
        x: (wideLeft.x + wideRight.x) / 2,
        y: (wideLeft.y + wideRight.y) / 2
      };
      const length = Math.hypot(wideCenter.x - tip.x, wideCenter.y - tip.y);
      const width = Math.hypot(wideRight.x - wideLeft.x, wideRight.y - wideLeft.y);
      expect(width / length).toBeLessThanOrEqual(0.281);
    });

    const hashedBondIds = molecule.bonds
      .filter((bond) => bond.display?.bondStyle === "hashed")
      .map((bond) => bond.id);
    expect(hashedBondIds.length).toBeGreaterThan(0);
    hashedBondIds.forEach((bondId) => {
      const hashGroup = fragments.find((fragment) =>
        fragment.tag === "g" &&
        fragment.attrs["data-bond-id"] === bondId &&
        fragment.attrs["data-bond-style"] === "hashed"
      );
      expect(hashGroup).toBeDefined();
      const uniqueHashIndices = new Set(
        (hashGroup ? elementFragments(hashGroup) : [])
          .filter((fragment) => fragment.attrs.class === "native-bond-hash")
          .map((fragment) => Number(fragment.attrs["data-bond-hash-index"]))
      );
      expect(uniqueHashIndices.size).toBeGreaterThan(0);
      expect(uniqueHashIndices.size).toBeGreaterThanOrEqual(2);
      expect(uniqueHashIndices.size).toBeLessThanOrEqual(5);

      const hashes = (hashGroup ? elementFragments(hashGroup) : [])
        .filter((fragment) => fragment.attrs.class === "native-bond-hash")
        .sort(
          (left, right) =>
            Number(left.attrs["data-bond-hash-index"]) -
            Number(right.attrs["data-bond-hash-index"])
        );
      const strokeWidth = Number(molecule.style?.bondStrokeWidthPx ?? 2);
      const centers = hashes.map((hash) => ({
        x: (Number(hash.attrs.x1) + Number(hash.attrs.x2)) / 2,
        y: (Number(hash.attrs.y1) + Number(hash.attrs.y2)) / 2
      }));
      const axialWhiteGaps = centers.slice(1).map((center, index) =>
        Math.hypot(
          center.x - centers[index]!.x,
          center.y - centers[index]!.y
        ) - strokeWidth
      );
      expect(Math.min(...axialWhiteGaps)).toBeGreaterThanOrEqual(strokeWidth);
    });
  });

  it("preserves the reported polyether through the full RDKit-to-render production chain", async () => {
    const generatedMolfile = await generateSmiles2DMolfile(REPORTED_POLYETHER_SMILES);
    const depiction = pastedStructureDepictionFromMolfile(generatedMolfile);
    const next = insertSmilesMolecule(
      createPhase4Document("RDKit SMILES production fixture"),
      POINT,
      depiction,
      REPORTED_POLYETHER_SMILES
    );
    const molecule = next.pages[0].objects.find(
      (object): object is MoleculeObject => object.type === "molecule"
    );
    if (!molecule) throw new Error("no molecule placed");

    expect(molecule.atoms).toHaveLength(63);
    expect(molecule.bonds).toHaveLength(73);
    const storedStereo = molecule.bonds.filter(isWedge);
    expect(storedStereo).toHaveLength(23);

    const xs = molecule.atoms.map((atom) => atom.x);
    const ys = molecule.atoms.map((atom) => atom.y);
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    expect(width / height).toBeGreaterThan(2.5);

    expect(OCL.Molecule.fromMolfile(molecule.structure).toIsomericSmiles()).toBe(
      OCL.Molecule.fromSmiles(REPORTED_POLYETHER_SMILES).toIsomericSmiles()
    );

    const page = createEmptyDocument({ now: "2026-07-24T00:00:00.000Z" }).pages[0];
    const fragments = planPageSvgRender({ ...page, objects: [molecule] }).fragments
      .flatMap(elementFragments);
    const renderedStyleByBond = new Map<string, "wedge" | "hashed">();
    fragments.forEach((fragment) => {
      const bondId = fragment.attrs["data-bond-id"];
      const style = fragment.attrs["data-bond-style"];
      if (typeof bondId === "string" && (style === "wedge" || style === "hashed")) {
        renderedStyleByBond.set(bondId, style);
      }
    });
    expect(storedStereo.map((bond) => renderedStyleByBond.get(bond.id))).toEqual(
      storedStereo.map((bond) => bond.display?.bondStyle)
    );
  });
});
