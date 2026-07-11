import * as OCL from "openchemlib";

import { estimateProtonShift } from "./functionalGroupFallback";

/**
 * A ChemDraw-style additive-increment ¹H estimator — an *independent* second opinion used only where
 * the HOSE lookup is weak (shallow sphere / sparse reference / no match). It is deliberately simple and
 * transparent: aromatic H = benzene base + Σ tabulated ortho/meta/para substituent increments; aliphatic
 * H = a Shoolery base (by attached-H count) + Σ α-substituent constants; aldehyde/alkene/alkyne reuse the
 * coarse class bases. Increment values are the standard tabulated ones (Pretsch/Bühlmann/Badertscher;
 * Shoolery). Not a spin simulation and not the measured data — a rule estimate, surfaced as such.
 */

const BENZENE_BASE = 7.26;
const HALOGENS: Record<number, string> = { 9: "F", 17: "Cl", 35: "Br", 53: "I" };

/** Aromatic ¹H substituent increments (Δδ from benzene) at ortho / meta / para. */
const AROMATIC_INCREMENTS: Record<string, [number, number, number]> = {
  alkyl: [-0.17, -0.09, -0.18],
  aryl: [0.3, 0.12, 0.1],
  vinyl: [0.06, -0.03, -0.1],
  alkyne: [0.15, -0.02, -0.01],
  F: [-0.29, -0.02, -0.23],
  Cl: [0.03, -0.02, -0.09],
  Br: [0.18, -0.08, -0.04],
  I: [0.39, -0.21, 0.0],
  OH: [-0.5, -0.14, -0.4],
  OR: [-0.48, -0.09, -0.44],
  "OC(=O)R": [-0.25, 0.03, -0.13],
  NR2: [-0.66, -0.18, -0.67],
  "NHC(=O)R": [0.12, -0.07, -0.28],
  NO2: [0.95, 0.17, 0.33],
  CHO: [0.56, 0.22, 0.29],
  "C(=O)R": [0.62, 0.14, 0.21],
  COOH: [0.85, 0.18, 0.27],
  COOR: [0.71, 0.11, 0.21],
  "C(=O)NR2": [0.61, 0.1, 0.17],
  CN: [0.36, 0.18, 0.28]
};

/** Shoolery α-substituent constants (δ_CH2 = 0.23 + Σσ over the two substituents; extended to CH/CH3). */
const SHOOLERY_SIGMA: Record<string, number> = {
  alkyl: 0.47,
  aryl: 1.85,
  vinyl: 1.32,
  alkyne: 1.44,
  CN: 1.7,
  "C(=O)R": 1.7,
  CHO: 1.7,
  COOH: 1.55,
  COOR: 1.55,
  "C(=O)NR2": 1.55,
  OH: 2.56,
  OR: 2.36,
  "OC(=O)R": 3.13,
  NR2: 1.57,
  "NHC(=O)R": 2.27,
  NO2: 3.6,
  F: 3.2,
  Cl: 2.53,
  Br: 2.33,
  I: 2.19
};
const SHOOLERY_BASE = 0.23;

/** Estimate a ¹H shift for the hydrogens on `host` from additive increments; falls back to the coarse
 *  functional-group value for atoms no increment scheme covers. Always returns a number. */
export function incrementProtonShift(molecule: OCL.Molecule, host: number): number {
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  if (molecule.getAtomicNo(host) !== 6 || molecule.getAllHydrogens(host) === 0) {
    return estimateProtonShift(molecule, host);
  }
  if (molecule.isAromaticAtom(host)) {
    const aromatic = aromaticShift(molecule, host);
    if (aromatic !== undefined) return round2(aromatic);
  }
  if (isSp3(molecule, host)) {
    return round2(shooleryShift(molecule, host));
  }
  return estimateProtonShift(molecule, host); // aldehyde / vinyl / alkyne etc.
}

/** Benzene base + Σ increments for each substituted ring carbon at its o/m/p position relative to `host`. */
function aromaticShift(molecule: OCL.Molecule, host: number): number | undefined {
  const ring = smallestAromaticRing(molecule, host);
  if (!ring || ring.length !== 6) return undefined;
  const distance = ringDistances(molecule, ring, host);
  let shift = BENZENE_BASE;
  for (const carbon of ring) {
    if (carbon === host) continue;
    const substituent = ringSubstituentKey(molecule, carbon, ring);
    if (!substituent) continue;
    const increments = AROMATIC_INCREMENTS[substituent];
    if (!increments) continue;
    const d = distance.get(carbon);
    if (d === 1) shift += increments[0];
    else if (d === 2) shift += increments[1];
    else if (d === 3) shift += increments[2];
  }
  return shift;
}

/** Shoolery: δ = 0.23 + Σσ over every heavy substituent on the carbon (alkyl included). */
function shooleryShift(molecule: OCL.Molecule, host: number): number {
  let shift = SHOOLERY_BASE;
  for (let i = 0; i < molecule.getConnAtoms(host); i += 1) {
    const neighbor = molecule.getConnAtom(host, i);
    if (molecule.getAtomicNo(neighbor) === 1) continue;
    const key = substituentKey(molecule, neighbor, host);
    shift += (key && SHOOLERY_SIGMA[key] !== undefined ? SHOOLERY_SIGMA[key] : SHOOLERY_SIGMA.alkyl) as number;
  }
  return shift;
}

/** Classify the exocyclic substituent on ring carbon `carbon` (ignoring ring neighbors). */
function ringSubstituentKey(molecule: OCL.Molecule, carbon: number, ring: readonly number[]): string | undefined {
  const ringSet = new Set(ring);
  for (let i = 0; i < molecule.getConnAtoms(carbon); i += 1) {
    const neighbor = molecule.getConnAtom(carbon, i);
    if (ringSet.has(neighbor) || molecule.getAtomicNo(neighbor) === 1) continue;
    // A neighbor in another ring (fused PAH) reads as an aryl substituent.
    if (molecule.isAromaticAtom(neighbor)) return "aryl";
    return substituentKey(molecule, neighbor, carbon);
  }
  return undefined;
}

/** Map the first atom of a substituent (`atom`, bonded to `from`) to an increment-table key. */
function substituentKey(molecule: OCL.Molecule, atom: number, from: number): string | undefined {
  const element = molecule.getAtomicNo(atom);
  if (HALOGENS[element]) return HALOGENS[element];
  if (element === 8) {
    if (molecule.getAllHydrogens(atom) > 0) return "OH";
    return bondedToCarbonyl(molecule, atom, from) ? "OC(=O)R" : "OR";
  }
  if (element === 7) {
    if (countDoubleBondedOxygens(molecule, atom) >= 1) return "NO2";
    if (bondedToCarbonyl(molecule, atom, from)) return "NHC(=O)R";
    return "NR2";
  }
  if (element === 6) {
    if (molecule.isAromaticAtom(atom)) return "aryl";
    if (maxBondOrderTo(molecule, atom, 7) === 3) return "CN";
    if (maxBondOrderTo(molecule, atom, 8) === 2) {
      if (molecule.getAllHydrogens(atom) === 1) return "CHO";
      const oxygens = countBondedTo(molecule, atom, 8);
      if (oxygens >= 2) return "COOR"; // ester/acid (both ~ same increment class here)
      if (countBondedTo(molecule, atom, 7) >= 1) return "C(=O)NR2";
      return "C(=O)R";
    }
    if (maxBondOrderTo(molecule, atom, 6) === 3) return "alkyne";
    if (maxBondOrderTo(molecule, atom, 6) === 2) return "vinyl";
    return "alkyl";
  }
  return undefined;
}

// ---- ring + bond helpers --------------------------------------------------------------------------

function smallestAromaticRing(molecule: OCL.Molecule, atom: number): number[] | undefined {
  const ringSet = molecule.getRingSet();
  let best: number[] | undefined;
  for (let r = 0; r < ringSet.getSize(); r += 1) {
    if (!ringSet.isAromatic(r) || !ringSet.isAtomMember(r, atom)) continue;
    const atoms = Array.from(ringSet.getRingAtoms(r));
    if (!best || atoms.length < best.length) best = atoms;
  }
  return best;
}

/** Shortest in-ring bond distance from `host` to every ring atom (1 = ortho, 2 = meta, 3 = para). */
function ringDistances(molecule: OCL.Molecule, ring: readonly number[], host: number): Map<number, number> {
  const inRing = new Set(ring);
  const distance = new Map<number, number>([[host, 0]]);
  const queue = [host];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    const currentDistance = distance.get(current) as number;
    for (let i = 0; i < molecule.getConnAtoms(current); i += 1) {
      const neighbor = molecule.getConnAtom(current, i);
      if (!inRing.has(neighbor) || distance.has(neighbor)) continue;
      distance.set(neighbor, currentDistance + 1);
      queue.push(neighbor);
    }
  }
  return distance;
}

function isSp3(molecule: OCL.Molecule, atom: number): boolean {
  return maxBondOrderTo(molecule, atom, 6) <= 1 && maxBondOrderTo(molecule, atom, 8) <= 1 && !molecule.isAromaticAtom(atom);
}

function maxBondOrderTo(molecule: OCL.Molecule, atom: number, element: number): number {
  let max = 0;
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    if (molecule.getAtomicNo(molecule.getConnAtom(atom, i)) === element) {
      max = Math.max(max, molecule.getBondOrder(molecule.getConnBond(atom, i)));
    }
  }
  return max;
}

function countBondedTo(molecule: OCL.Molecule, atom: number, element: number): number {
  let count = 0;
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    if (molecule.getAtomicNo(molecule.getConnAtom(atom, i)) === element) count += 1;
  }
  return count;
}

function countDoubleBondedOxygens(molecule: OCL.Molecule, atom: number): number {
  let count = 0;
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    if (molecule.getAtomicNo(molecule.getConnAtom(atom, i)) === 8 && molecule.getBondOrder(molecule.getConnBond(atom, i)) === 2) {
      count += 1;
    }
  }
  return count;
}

/** True when `atom` is bonded (other than to `from`) to a carbonyl carbon — for O/N acyl detection. */
function bondedToCarbonyl(molecule: OCL.Molecule, atom: number, from: number): boolean {
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    const neighbor = molecule.getConnAtom(atom, i);
    if (neighbor === from) continue;
    if (molecule.getAtomicNo(neighbor) === 6 && maxBondOrderTo(molecule, neighbor, 8) === 2) return true;
  }
  return false;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
