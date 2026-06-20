import { beforeAll, describe, expect, it } from "vitest";
import * as OCL from "openchemlib";
import { ensureOclResources, generate3DConformerProgressive } from "./index";

beforeAll(async () => {
  await ensureOclResources();
});

/**
 * RMS out-of-plane deviation (Å) of a conformer about its best-fit plane. Near 0 for a
 * planar aromatic; large for a puckered/warped one. The plane normal is the smallest-
 * eigenvalue eigenvector of the centered coordinate covariance (Jacobi).
 */
function planarityRms(coords: ArrayLike<number>): number {
  const n = coords.length / 3;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < n; i++) { cx += coords[i * 3]; cy += coords[i * 3 + 1]; cz += coords[i * 3 + 2]; }
  cx /= n; cy /= n; cz /= n;
  const c = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    const dx = coords[i * 3] - cx, dy = coords[i * 3 + 1] - cy, dz = coords[i * 3 + 2] - cz;
    c[0][0] += dx * dx; c[0][1] += dx * dy; c[0][2] += dx * dz;
    c[1][1] += dy * dy; c[1][2] += dy * dz; c[2][2] += dz * dz;
  }
  c[1][0] = c[0][1]; c[2][0] = c[0][2]; c[2][1] = c[1][2];
  const normal = smallestEigenvector(c);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const dx = coords[i * 3] - cx, dy = coords[i * 3 + 1] - cy, dz = coords[i * 3 + 2] - cz;
    const d = dx * normal[0] + dy * normal[1] + dz * normal[2];
    sumSq += d * d;
  }
  return Math.sqrt(sumSq / n);
}

function smallestEigenvector(m: number[][]): number[] {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let p = 0, q = 1, max = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > max) { max = Math.abs(a[0][2]); p = 0; q = 2; }
    if (Math.abs(a[1][2]) > max) { max = Math.abs(a[1][2]); p = 1; q = 2; }
    if (max < 1e-12) break;
    const app = a[p][p], aqq = a[q][q], apq = a[p][q];
    const phi = 0.5 * Math.atan2(2 * apq, aqq - app);
    const cos = Math.cos(phi), sin = Math.sin(phi);
    for (let i = 0; i < 3; i++) { const aip = a[i][p], aiq = a[i][q]; a[i][p] = cos * aip - sin * aiq; a[i][q] = sin * aip + cos * aiq; }
    for (let i = 0; i < 3; i++) { const api = a[p][i], aqi = a[q][i]; a[p][i] = cos * api - sin * aqi; a[q][i] = sin * api + cos * aqi; }
    for (let i = 0; i < 3; i++) { const vip = v[i][p], viq = v[i][q]; v[i][p] = cos * vip - sin * viq; v[i][q] = sin * vip + cos * viq; }
  }
  const vals = [a[0][0], a[1][1], a[2][2]];
  let mi = 0;
  if (vals[1] < vals[mi]) mi = 1;
  if (vals[2] < vals[mi]) mi = 2;
  return [v[0][mi], v[1][mi], v[2][mi]];
}

// Regression for the "flat aromatics come out warped" bug: a chunked/resumed MMFF94
// minimisation only ran ~6 iterations of real work (OCL's minimise() is single-shot, not
// resumable — later calls are no-ops), leaving fused aromatics at their non-planar embed.
// A SINGLE capped refine() — which is what the worker now does — must planarize them.
describe("PAH planarity: a single capped refine flattens fused aromatics", () => {
  const PAHS: Record<string, string> = {
    naphthalene: "c1ccc2ccccc2c1",
    anthracene: "c1ccc2cc3ccccc3cc2c1",
    picene: "c1ccc2ccc3c4ccccc4ccc3c2c1",
    pentacene: "c1ccc2cc3cc4cc5ccccc5cc4cc3cc2c1"
  };

  for (const [name, smiles] of Object.entries(PAHS)) {
    it(`${name} is planar after one refine() call`, async () => {
      const molfile = OCL.Molecule.fromSmiles(smiles).toMolfile();
      const { embedded, refineFromEmbedded } = await generate3DConformerProgressive({ molfile }, { seed: 42, optimize: "auto" });
      expect(embedded.embed.status).toBe("ok");

      // ONE capped call, exactly as the worker drives it (size cap >= 240 here).
      const refined = refineFromEmbedded!(800);
      const rms = planarityRms(refined.mapping.coords3dByOriginalAtom);

      // Flat aromatics should sit essentially in-plane. The old chunked path left
      // pentacene at ~0.67 Å here; a real minimisation brings it well under 0.1 Å.
      expect(rms).toBeLessThan(0.1);
    });
  }
});
