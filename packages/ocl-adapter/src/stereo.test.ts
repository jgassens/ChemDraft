import { beforeAll, describe, expect, it } from "vitest";
import * as OCL from "openchemlib";
import { ensureOclResources, generate3DConformerProgressive } from "./index";

beforeAll(async () => { await ensureOclResources(); });

const SEED = 42;
// Per-center stereo diagnostics are useful when debugging a parity failure but noisy in CI.
// Gate them behind an env flag so a normal `vitest run` stays quiet.
const VERBOSE = Boolean((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.OCL_STEREO_VERBOSE);
const log = (message: string): void => {
  if (VERBOSE) console.log(message);
};

/** Signed tetrahedral volume of a center's first three heavy neighbours (Å³). Sign = handedness. */
function signedVolume(coords: Float64Array, center: number, neighbors: number[]): number {
  const v = (i: number) => [coords[i * 3] - coords[center * 3], coords[i * 3 + 1] - coords[center * 3 + 1], coords[i * 3 + 2] - coords[center * 3 + 2]];
  const [a, b, c] = [v(neighbors[0]), v(neighbors[1]), v(neighbors[2])];
  // (a × b) · c
  const cx = a[1] * b[2] - a[2] * b[1];
  const cy = a[2] * b[0] - a[0] * b[2];
  const cz = a[0] * b[1] - a[1] * b[0];
  return cx * c[0] + cy * c[1] + cz * c[2];
}

/** Heavy-atom neighbours of an atom, in OCL connection order (= molfile/original order). */
function heavyNeighbors(mol: OCL.Molecule, atom: number): number[] {
  const out: number[] = [];
  for (let k = 0; k < mol.getConnAtoms(atom); k++) out.push(mol.getConnAtom(atom, k));
  return out;
}

/** Stereocenters of a 2D molecule + their CIP parity (1=R, 2=S per OCL). */
function stereoCenters(mol: OCL.Molecule): { atom: number; cip: number }[] {
  mol.ensureHelperArrays(OCL.Molecule.cHelperCIP);
  const centers: { atom: number; cip: number }[] = [];
  for (let a = 0; a < mol.getAllAtoms(); a++) {
    if (mol.isAtomStereoCenter(a)) centers.push({ atom: a, cip: mol.getAtomCIPParity(a) });
  }
  return centers;
}

// Made-up but valid isomeric SMILES. Each pair is (defined, enantiomer-or-epimer).
const CASES: { name: string; iso: string; ent: string; note: string }[] = [
  { name: "D/L-glyceraldehyde", iso: "OC[C@@H](O)C=O", ent: "OC[C@H](O)C=O", note: "simplest sugar, 1 center" },
  { name: "D/L-alanine", iso: "C[C@@H](N)C(=O)O", ent: "C[C@H](N)C(=O)O", note: "amino acid, 1 center" },
  { name: "L/D-threonine", iso: "C[C@@H](O)[C@@H](N)C(=O)O", ent: "C[C@H](O)[C@H](N)C(=O)O", note: "2 centers, both flip" },
  { name: "a-D-glucopyranose", iso: "OC[C@H]1O[C@H](O)[C@H](O)[C@@H](O)[C@@H]1O", ent: "OC[C@@H]1O[C@@H](O)[C@@H](O)[C@H](O)[C@H]1O", note: "sugar, 5 centers" },
  // made-up peptides (isomeric SMILES of the backbone alpha carbons)
  { name: "peptide L-Ala-L-Ala", iso: "C[C@@H](N)C(=O)N[C@@H](C)C(=O)O", ent: "C[C@H](N)C(=O)N[C@H](C)C(=O)O", note: "dipeptide, both L vs both D" },
  { name: "peptide L-Ala-L-Phe-Gly", iso: "C[C@@H](N)C(=O)N[C@@H](Cc1ccccc1)C(=O)NCC(=O)O", ent: "C[C@H](N)C(=O)N[C@H](Cc1ccccc1)C(=O)NCC(=O)O", note: "tripeptide, Gly achiral" }
];

describe("2D→3D stereochemistry fidelity", () => {
  // ABSOLUTE: the generated 3D geometry, re-perceived by OCL purely from coordinates,
  // must yield the SAME canonical stereo (idCode + per-center CIP) as the input drawing.
  for (const { name, iso, note } of CASES) {
    it(`${name}: 3D geometry re-perceives the input config (${note})`, () => {
      const ref = OCL.Molecule.fromSmiles(iso);
      const refId = ref.getIDCode();
      const refCenters = stereoCenters(ref);

      const work = new OCL.Molecule(0, 0);
      ref.copyMolecule(work);
      const conf = new OCL.ConformerGenerator(SEED).getOneConformerAsMolecule(work)!;
      expect(conf).toBeTruthy();

      // Round-trip through a 3D molfile: fromMolfile re-derives stereo from coordinates,
      // not from any wedge/parity carried along.
      const back = OCL.Molecule.fromMolfile(conf.toMolfile());
      expect(back.is3D()).toBe(true);
      const backId = back.getIDCode();
      const backCenters = stereoCenters(back);

      // eslint-disable-next-line no-console
      log(`${name.padEnd(22)} centers=${refCenters.length} refCIP=[${refCenters.map(c => c.cip)}] 3dCIP=[${backCenters.map(c => c.cip)}] idMatch=${backId === refId}`);

      expect(backCenters.length).toBe(refCenters.length);
      expect(backId).toBe(refId); // canonical stereo identical → absolute config preserved
    });
  }

  // RELATIVE, through the ACTUAL adapter: an enantiomer/epimer must produce mirror-image
  // 3D at every flipped center (opposite signed volume), proving the embed RESPECTS the
  // drawn parity rather than ignoring or randomizing it.
  for (const { name, iso, ent, note } of CASES) {
    it(`${name}: adapter 2D→3D flips handedness for the enantiomer (${note})`, async () => {
      const make = async (smi: string) => {
        const m = OCL.Molecule.fromSmiles(smi);
        const centers = stereoCenters(m).map((c) => ({ ...c, nbrs: heavyNeighbors(m, c.atom) }));
        const molfile = m.toMolfile();
        const prog = await generate3DConformerProgressive({ molfile }, { seed: SEED, optimize: "auto" });
        const refined = prog.refine!(800); // single capped minimise, as the app ships
        return { coords: refined.mapping.coords3dByOriginalAtom, centers };
      };
      const A = await make(iso);
      const B = await make(ent);
      const coordsA = A.coords;
      const coordsB = B.coords;

      expect(A.centers.length).toBeGreaterThan(0);
      let flipped = 0;
      for (let i = 0; i < A.centers.length; i++) {
        const ca = A.centers[i], cb = B.centers[i];
        if (ca.nbrs.length < 3) continue;
        const va = signedVolume(coordsA, ca.atom, ca.nbrs);
        const vb = signedVolume(coordsB, cb.atom, cb.nbrs);
        // eslint-disable-next-line no-console
        log(`  ${name} center#${i} atom${ca.atom}: volA=${va.toFixed(2)} volB=${vb.toFixed(2)} ${Math.sign(va) !== Math.sign(vb) ? "FLIP✓" : "same✗"}`);
        if (Math.sign(va) !== Math.sign(vb) && Math.abs(va) > 0.3 && Math.abs(vb) > 0.3) flipped++;
      }
      // Every defined center that differs between the two SMILES must flip in 3D.
      expect(flipped).toBe(A.centers.length);
    });
  }
});
