import * as OCL from "openchemlib";

import type { NmrEstimateProvenance } from "../../domain/contracts";
import { aromaticComponentIsCarbocyclic, countBondedTo, isAldehyde, maxBondOrderTo } from "./oclTopology";
import {
  ALIPHATIC_BASE_PPM_BY_HYDROGEN_COUNT,
  ALIPHATIC_INCREMENT_PPM,
  type AliphaticIncrementKey
} from "./protonIncrementTable";

/**
 * A deliberately bounded additive-increment ¹H estimator. Aliphatic sp3 C-H values use published
 * methyl/methylene/methine bases plus alpha/beta/gamma substituent corrections through three carbons;
 * aromatic values use the separate benzene ortho/meta/para table. The API never turns an unsupported
 * environment into a plausible-looking number: every call says whether the scheme applies and
 * identifies the exact rule method/version used.
 */

export const PROTON_INCREMENT_ESTIMATOR_ID = "chemdraft.h1-additive-increment";
export const PROTON_INCREMENT_ESTIMATOR_VERSION = "1.3.0";

export type ProtonIncrementUnavailableReason =
  | "non-carbon-host"
  | "no-attached-hydrogen"
  | "charged-structure"
  | "isotopically-labeled-structure"
  | "radical-structure"
  | "heteroaromatic-ring"
  | "unsupported-aromatic-ring"
  | "unsupported-aliphatic-ring"
  | "unsupported-substituent"
  | "unsupported-bonding-environment";

export type ProtonIncrementEstimate =
  | {
      applicable: true;
      ppm: number;
      estimator: NmrEstimateProvenance;
    }
  | {
      applicable: false;
      reason: ProtonIncrementUnavailableReason;
      estimator: NmrEstimateProvenance;
    };

const BENZENE_BASE = 7.26;
/** ChemDraft-owned representative values within standard teaching ranges. These are deliberately
 * identified as functional-class heuristics rather than values from the alpha/beta/gamma table. */
const FUNCTIONAL_CLASS_REPRESENTATIVE_PPM = {
  aldehyde: 9.7,
  alkynyl: 2.4,
  vinylic: 5.7
} as const;
const HALOGENS: Readonly<Record<number, AliphaticIncrementKey>> = { 9: "F", 17: "Cl", 35: "Br", 53: "I" };

/** Aromatic ¹H substituent increments (Δδ from benzene) at ortho / meta / para. ChemDraft
 * consolidates the standard teaching-table values cited in THIRD_PARTY_NOTICES.md. */
const AROMATIC_INCREMENTS: Readonly<
  Partial<Record<AliphaticIncrementKey, readonly [number, number, number]>>
> = {
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

/** Return a tabulated ¹H estimate only when the molecule and local environment fit the scheme. */
export function estimateProtonIncrement(molecule: OCL.Molecule, host: number): ProtonIncrementEstimate {
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);

  if (molecule.getAtomicNo(host) !== 6) {
    return unavailable("non-carbon-host");
  }
  if (molecule.getAllHydrogens(host) === 0) {
    return unavailable("no-attached-hydrogen");
  }
  const unsafe = moleculeApplicabilityFailure(molecule);
  if (unsafe) {
    return unavailable(unsafe);
  }

  if (molecule.isAromaticAtom(host)) {
    return aromaticEstimate(molecule, host);
  }
  if (isSp3Carbon(molecule, host)) {
    return shooleryEstimate(molecule, host);
  }
  if (isAldehyde(molecule, host) && onlyDirectElements(molecule, host, new Set([6, 8]))) {
    return applicable(FUNCTIONAL_CLASS_REPRESENTATIVE_PPM.aldehyde, "functional-class-aldehyde");
  }
  if (maxBondOrderTo(molecule, host, 6) === 3 && onlyDirectElements(molecule, host, new Set([6]))) {
    return applicable(FUNCTIONAL_CLASS_REPRESENTATIVE_PPM.alkynyl, "functional-class-alkynyl");
  }
  if (maxBondOrderTo(molecule, host, 6) === 2 && onlyDirectElements(molecule, host, new Set([6]))) {
    return applicable(FUNCTIONAL_CLASS_REPRESENTATIVE_PPM.vinylic, "functional-class-vinylic");
  }
  // In particular, C=N imines land here: the Shoolery sp³ constants do not apply to them.
  return unavailable("unsupported-bonding-environment");
}

function aromaticEstimate(molecule: OCL.Molecule, host: number): ProtonIncrementEstimate {
  const ring = smallestAromaticRing(molecule, host);
  if (!ring || ring.length !== 6) {
    return unavailable("unsupported-aromatic-ring");
  }
  if (ring.some((atom) => molecule.getAtomicNo(atom) !== 6)) {
    return unavailable("heteroaromatic-ring");
  }
  if (!aromaticComponentIsCarbocyclic(molecule, host)) {
    return unavailable("heteroaromatic-ring");
  }

  const distance = ringDistances(molecule, ring, host);
  let shift = BENZENE_BASE;
  for (const carbon of ring) {
    if (carbon === host) continue;
    const substituents = ringSubstituentKeys(molecule, carbon, ring);
    if (!substituents) {
      return unavailable("unsupported-substituent");
    }
    for (const substituent of substituents) {
      const increments = AROMATIC_INCREMENTS[substituent];
      if (!increments) {
        return unavailable("unsupported-substituent");
      }
      const d = distance.get(carbon);
      if (d === 1) shift += increments[0];
      else if (d === 2) shift += increments[1];
      else if (d === 3) shift += increments[2];
    }
  }
  return applicable(shift, "aromatic-substituent-increment");
}

function shooleryEstimate(molecule: OCL.Molecule, host: number): ProtonIncrementEstimate {
  const base = ALIPHATIC_BASE_PPM_BY_HYDROGEN_COUNT[molecule.getAllHydrogens(host)];
  if (base === undefined) {
    return unavailable("unsupported-bonding-environment");
  }

  let shift = base;
  const carbonDistances = saturatedCarbonDistances(molecule, host, 2);
  if ([...carbonDistances.keys()].some((carbon) => molecule.isRingAtom(carbon))) {
    return unavailable("unsupported-aliphatic-ring");
  }
  for (const [carbon, distance] of carbonDistances) {
    for (let i = 0; i < molecule.getConnAtoms(carbon); i += 1) {
      const neighbor = molecule.getConnAtom(carbon, i);
      if (molecule.getAtomicNo(neighbor) === 1 || carbonDistances.has(neighbor)) continue;

      // A saturated carbon just outside the gamma traversal is the ordinary alkyl skeleton (R),
      // whose correction is zero. Functionalized, unsaturated, and aromatic carbons are classified.
      if (isSaturatedCarbonSkeletonBond(molecule, carbon, neighbor)) continue;
      const key = aliphaticSubstituentKey(molecule, neighbor, carbon);
      if (!key) {
        return unavailable("unsupported-substituent");
      }
      shift += ALIPHATIC_INCREMENT_PPM[key][distance];
    }
  }
  return applicable(shift, "shoolery-alpha-beta-gamma");
}

/** Shortest saturated-carbon distance from the proton host through alpha/beta/gamma positions. */
function saturatedCarbonDistances(molecule: OCL.Molecule, host: number, maxDistance: number): Map<number, number> {
  const distances = new Map<number, number>([[host, 0]]);
  const queue = [host];
  while (queue.length > 0) {
    const carbon = queue.shift() as number;
    const distance = distances.get(carbon) as number;
    if (distance >= maxDistance) continue;
    for (let i = 0; i < molecule.getConnAtoms(carbon); i += 1) {
      const neighbor = molecule.getConnAtom(carbon, i);
      if (distances.has(neighbor) || !isSaturatedCarbonSkeletonBond(molecule, carbon, neighbor)) continue;
      distances.set(neighbor, distance + 1);
      queue.push(neighbor);
    }
  }
  return distances;
}

function isSaturatedCarbonSkeletonBond(molecule: OCL.Molecule, from: number, atom: number): boolean {
  if (molecule.getAtomicNo(atom) !== 6 || molecule.isAromaticAtom(atom) || !isSp3Carbon(molecule, atom)) {
    return false;
  }
  for (let i = 0; i < molecule.getConnAtoms(from); i += 1) {
    if (molecule.getConnAtom(from, i) === atom) {
      return molecule.getBondOrder(molecule.getConnBond(from, i)) === 1;
    }
  }
  return false;
}

function aliphaticSubstituentKey(
  molecule: OCL.Molecule,
  atom: number,
  from: number
): AliphaticIncrementKey | undefined {
  const element = molecule.getAtomicNo(atom);
  if (element === 7) {
    const key = substituentKey(molecule, atom, from);
    if (key === "NO2") return key;
    if (!key || connectedHeavyAtomsExcept(molecule, atom, from).some((neighbor) => molecule.getAtomicNo(neighbor) !== 6)) {
      return undefined;
    }
    if (key === "NHC(=O)R") return key;
    return key === "NR2" && molecule.getAllHydrogens(atom) === 2 ? key : undefined;
  }
  if (element !== 8) {
    const key = substituentKey(molecule, atom, from);
    if (key === "C(=O)NR2" && !carbonylHasPrimaryAmideNitrogen(molecule, atom)) return undefined;
    return key === "C(=O)R" && carbonylHasArylSubstituent(molecule, atom, from) ? "ArCO" : key;
  }
  if (molecule.getAtomCharge(atom) !== 0 || !allConnectedBondsSingle(molecule, atom)) return undefined;
  if (molecule.getAllHydrogens(atom) > 0) {
    return connectedHeavyAtomsExcept(molecule, atom, from).length === 0 ? "OH" : undefined;
  }
  if (oxygenParticipatesInRing(molecule, atom)) return undefined;
  const otherCarbon = singleOtherCarbon(molecule, atom, from);
  if (otherCarbon === undefined) return undefined;
  const carbonyl = maxBondOrderTo(molecule, otherCarbon, 8) === 2 ? otherCarbon : undefined;
  if (carbonyl !== undefined) {
    return acyloxyIncrementKey(molecule, carbonyl, atom);
  }
  if (molecule.isAromaticAtom(otherCarbon)) return "ArO";
  if (maxBondOrderTo(molecule, otherCarbon, 6) === 2) return "vinylO";
  if (!allConnectedBondsSingle(molecule, otherCarbon)) return undefined;
  return "OR";
}

/** Classify every exocyclic substituent on a ring carbon. `undefined` means at least one is outside
 * the table; an empty array means that carbon is unsubstituted. */
function ringSubstituentKeys(
  molecule: OCL.Molecule,
  carbon: number,
  ring: readonly number[]
): AliphaticIncrementKey[] | undefined {
  const ringSet = new Set(ring);
  const keys: AliphaticIncrementKey[] = [];
  for (let i = 0; i < molecule.getConnAtoms(carbon); i += 1) {
    const neighbor = molecule.getConnAtom(carbon, i);
    if (ringSet.has(neighbor) || molecule.getAtomicNo(neighbor) === 1) continue;
    const key = molecule.isAromaticAtom(neighbor) ? "aryl" : substituentKey(molecule, neighbor, carbon);
    if (!key) return undefined;
    keys.push(key);
  }
  return keys;
}

/** Map the first atom of a substituent (`atom`, bonded to `from`) to a table key. */
function substituentKey(molecule: OCL.Molecule, atom: number, from: number): AliphaticIncrementKey | undefined {
  const element = molecule.getAtomicNo(atom);
  if (HALOGENS[element]) return HALOGENS[element];
  if (element === 8) {
    if (molecule.getAtomCharge(atom) !== 0) return undefined;
    if (!allConnectedBondsSingle(molecule, atom)) return undefined;
    if (molecule.getAllHydrogens(atom) > 0) {
      return connectedHeavyAtomsExcept(molecule, atom, from).length === 0 ? "OH" : undefined;
    }
    const otherCarbon = singleOtherCarbon(molecule, atom, from);
    if (otherCarbon === undefined) return undefined;
    if (maxBondOrderTo(molecule, otherCarbon, 8) === 2) {
      return acyloxyIncrementKey(molecule, otherCarbon, atom) ? "OC(=O)R" : undefined;
    }
    return allConnectedBondsSingle(molecule, otherCarbon) ? "OR" : undefined;
  }
  if (element === 7) {
    if (isNitroNitrogen(molecule, atom)) return "NO2";
    if (molecule.getAtomCharge(atom) !== 0) return undefined;
    if (!allConnectedBondsSingle(molecule, atom)) return undefined;
    const carbonyl = bondedCarbonylAtom(molecule, atom, from);
    if (carbonyl !== undefined) {
      return molecule.getAllHydrogens(atom) === 1 &&
        carbonylHasSingleCarbonSubstituent(molecule, carbonyl, atom)
        ? "NHC(=O)R"
        : undefined;
    }
    if (connectedHeavyAtomsExcept(molecule, atom, from).some((neighbor) => molecule.getAtomicNo(neighbor) !== 6)) {
      return undefined;
    }
    return "NR2";
  }
  if (element === 6) {
    if (molecule.getAtomCharge(atom) !== 0) return undefined;
    if (molecule.isAromaticAtom(atom)) return "aryl";
    if (maxBondOrderTo(molecule, atom, 7) === 3) return "CN";
    if (maxBondOrderTo(molecule, atom, 8) === 2) {
      if (molecule.getAllHydrogens(atom) === 1) return "CHO";
      const oxygenBonds = connectedAtomsOfElement(molecule, atom, 8);
      if (oxygenBonds.length === 2) {
        const doubleOxygens = oxygenBonds.filter(({ bond }) => molecule.getBondOrder(bond) === 2);
        const singleOxygens = oxygenBonds.filter(({ bond }) => molecule.getBondOrder(bond) === 1);
        if (doubleOxygens.length !== 1 || singleOxygens.length !== 1 || countBondedTo(molecule, atom, 7) > 0) {
          return undefined;
        }
        const singleOxygen = singleOxygens[0].atom;
        if (molecule.getAllHydrogens(singleOxygen) > 0) return "COOH";
        return simpleEsterOxygen(molecule, singleOxygen, atom) ? "COOR" : undefined;
      }
      if (oxygenBonds.length !== 1) return undefined;
      if (countBondedTo(molecule, atom, 7) >= 1) return "C(=O)NR2";
      if (countBondedTo(molecule, atom, 17) === 1) return "ClCO";
      if ([9, 35, 53].some((halogen) => countBondedTo(molecule, atom, halogen) > 0)) return undefined;
      return carbonylHasSingleCarbonSubstituent(molecule, atom, from) ? "C(=O)R" : undefined;
    }
    if (maxBondOrderTo(molecule, atom, 6) === 3) return "alkyne";
    if (maxBondOrderTo(molecule, atom, 6) === 2) return "vinyl";
    // Any multiple bond to a heteroatom (e.g. an imine carbon) is not a generic alkyl group.
    if (!allConnectedBondsSingle(molecule, atom)) return undefined;
    return "alkyl";
  }
  return undefined;
}

function connectedAtomsOfElement(
  molecule: OCL.Molecule,
  atom: number,
  element: number
): { atom: number; bond: number }[] {
  const connected: { atom: number; bond: number }[] = [];
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    const neighbor = molecule.getConnAtom(atom, i);
    if (molecule.getAtomicNo(neighbor) === element) {
      connected.push({ atom: neighbor, bond: molecule.getConnBond(atom, i) });
    }
  }
  return connected;
}

function connectedHeavyAtomsExcept(molecule: OCL.Molecule, atom: number, excluded: number): number[] {
  const connected: number[] = [];
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    const neighbor = molecule.getConnAtom(atom, i);
    if (neighbor !== excluded && molecule.getAtomicNo(neighbor) !== 1) connected.push(neighbor);
  }
  return connected;
}

function singleOtherCarbon(molecule: OCL.Molecule, atom: number, from: number): number | undefined {
  const connected = connectedHeavyAtomsExcept(molecule, atom, from);
  return connected.length === 1 && molecule.getAtomicNo(connected[0]) === 6 ? connected[0] : undefined;
}

function simpleEsterOxygen(molecule: OCL.Molecule, oxygen: number, carbonyl: number): boolean {
  const otherCarbon = singleOtherCarbon(molecule, oxygen, carbonyl);
  return otherCarbon !== undefined && maxBondOrderTo(molecule, otherCarbon, 8) !== 2;
}

function acyloxyIncrementKey(
  molecule: OCL.Molecule,
  carbonyl: number,
  oxygen: number
): "ArCO2" | "OC(=O)R" | undefined {
  const oxygenBonds = connectedAtomsOfElement(molecule, carbonyl, 8);
  const doubleOxygens = oxygenBonds.filter(({ bond }) => molecule.getBondOrder(bond) === 2);
  const singleOxygens = oxygenBonds.filter(({ bond }) => molecule.getBondOrder(bond) === 1);
  if (
    oxygenBonds.length !== 2 ||
    doubleOxygens.length !== 1 ||
    singleOxygens.length !== 1 ||
    singleOxygens[0].atom !== oxygen ||
    countBondedTo(molecule, carbonyl, 7) > 0
  ) {
    return undefined;
  }
  const carbonSubstituents = connectedAtomsOfElement(molecule, carbonyl, 6).map(({ atom }) => atom);
  if (carbonSubstituents.length !== 1) return undefined;
  return molecule.isAromaticAtom(carbonSubstituents[0]) ? "ArCO2" : "OC(=O)R";
}

function oxygenParticipatesInRing(molecule: OCL.Molecule, oxygen: number): boolean {
  for (let i = 0; i < molecule.getConnAtoms(oxygen); i += 1) {
    if (molecule.isRingBond(molecule.getConnBond(oxygen, i))) return true;
  }
  return false;
}

function carbonylHasPrimaryAmideNitrogen(molecule: OCL.Molecule, carbon: number): boolean {
  const nitrogens = connectedAtomsOfElement(molecule, carbon, 7);
  return nitrogens.length === 1 && molecule.getAllHydrogens(nitrogens[0].atom) === 2;
}

function carbonylHasArylSubstituent(molecule: OCL.Molecule, carbon: number, excluded: number): boolean {
  for (let i = 0; i < molecule.getConnAtoms(carbon); i += 1) {
    const neighbor = molecule.getConnAtom(carbon, i);
    if (neighbor !== excluded && molecule.getAtomicNo(neighbor) === 6 && molecule.isAromaticAtom(neighbor)) {
      return true;
    }
  }
  return false;
}

/** For a table class written R-C(=O)-X, require the R side to be exactly one singly bonded carbon.
 * This rejects thioesters, silyl acyl compounds, carbamates, ureas, and other lookalikes instead of
 * collapsing them into a ketone/amide correction. */
function carbonylHasSingleCarbonSubstituent(
  molecule: OCL.Molecule,
  carbonyl: number,
  excluded: number
): boolean {
  const substituents: { atom: number; bond: number }[] = [];
  for (let index = 0; index < molecule.getConnAtoms(carbonyl); index += 1) {
    const atom = molecule.getConnAtom(carbonyl, index);
    if (atom === excluded || molecule.getAtomicNo(atom) === 1 || molecule.getAtomicNo(atom) === 8) continue;
    substituents.push({ atom, bond: molecule.getConnBond(carbonyl, index) });
  }
  return substituents.length === 1 &&
    molecule.getAtomicNo(substituents[0].atom) === 6 &&
    molecule.getBondOrder(substituents[0].bond) === 1;
}

function moleculeApplicabilityFailure(
  molecule: OCL.Molecule
): "charged-structure" | "isotopically-labeled-structure" | "radical-structure" | undefined {
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomMass(atom) !== 0) return "isotopically-labeled-structure";
    if (molecule.getAtomRadical(atom) !== OCL.Molecule.cAtomRadicalStateNone) return "radical-structure";
    if (molecule.getAtomCharge(atom) !== 0 && !isSupportedNitroChargeAtom(molecule, atom)) {
      return "charged-structure";
    }
  }
  return undefined;
}

/** Nitro groups are encoded charge-separated in ordinary SMILES, but are an explicit table entry. */
function isSupportedNitroChargeAtom(molecule: OCL.Molecule, atom: number): boolean {
  if (isNitroNitrogen(molecule, atom)) return true;
  if (molecule.getAtomicNo(atom) !== 8) return false;
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    const nitrogen = molecule.getConnAtom(atom, i);
    const oxygens = canonicalNitroOxygens(molecule, nitrogen);
    if (oxygens?.includes(atom)) return true;
  }
  return false;
}

function isNitroNitrogen(molecule: OCL.Molecule, atom: number): boolean {
  return canonicalNitroOxygens(molecule, atom) !== undefined;
}

/** Match the same narrow N+/O- representation exempted by normalizeStructure. */
function canonicalNitroOxygens(molecule: OCL.Molecule, nitrogen: number): number[] | undefined {
  if (molecule.getAtomicNo(nitrogen) !== 7 || molecule.getAtomCharge(nitrogen) !== 1) return undefined;
  const oxygens = connectedAtomsOfElement(molecule, nitrogen, 8).map(({ atom }) => atom);
  if (oxygens.length !== 2) return undefined;
  return oxygens.filter((oxygen) => molecule.getAtomCharge(oxygen) === -1).length === 1 &&
    oxygens.filter((oxygen) => molecule.getAtomCharge(oxygen) === 0).length === 1
    ? oxygens
    : undefined;
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

function isSp3Carbon(molecule: OCL.Molecule, atom: number): boolean {
  return !molecule.isAromaticAtom(atom) && allConnectedBondsSingle(molecule, atom);
}

function allConnectedBondsSingle(molecule: OCL.Molecule, atom: number): boolean {
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    if (molecule.getBondOrder(molecule.getConnBond(atom, i)) !== 1) return false;
  }
  return true;
}

function onlyDirectElements(molecule: OCL.Molecule, atom: number, allowed: ReadonlySet<number>): boolean {
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    const neighbor = molecule.getConnAtom(atom, i);
    if (molecule.getAtomicNo(neighbor) !== 1 && !allowed.has(molecule.getAtomicNo(neighbor))) return false;
  }
  return true;
}

function bondedCarbonylAtom(molecule: OCL.Molecule, atom: number, from: number): number | undefined {
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    const neighbor = molecule.getConnAtom(atom, i);
    if (neighbor === from) continue;
    if (molecule.getAtomicNo(neighbor) === 6 && maxBondOrderTo(molecule, neighbor, 8) === 2) return neighbor;
  }
  return undefined;
}

function applicable(ppm: number, method: string): ProtonIncrementEstimate {
  return { applicable: true, ppm: round2(ppm), estimator: estimator(method) };
}

function unavailable(reason: ProtonIncrementUnavailableReason): ProtonIncrementEstimate {
  return { applicable: false, reason, estimator: estimator("applicability-check") };
}

function estimator(method: string): NmrEstimateProvenance {
  return { id: PROTON_INCREMENT_ESTIMATOR_ID, version: PROTON_INCREMENT_ESTIMATOR_VERSION, method };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
