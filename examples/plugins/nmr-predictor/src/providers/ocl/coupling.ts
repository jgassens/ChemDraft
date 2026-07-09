import * as OCL from "openchemlib";

import type { NmrCoupling, NmrMultiplet } from "../../domain/contracts";

/**
 * First-order ¹H multiplicity + coupling estimator from the molecular topology (not from the shift
 * database). For a proton-bearing host atom it finds its coupling partners on the bond graph —
 * vicinal ³J (protons on heavy neighbours), aromatic ortho/meta, and a smaller aldehyde J — assigns a
 * class-typical J to each, merges equivalent couplings, and applies the first-order (n+1) rule to
 * produce a multiplicity label (s, d, t, q, quint, sext, sept, dd, dt, ddd, m, …). These are
 * estimates for readability, in the spirit of ChemDraw's ChemNMR — deliberately simple, not a
 * full spin simulation. Runtime OpenChemLib import; reachable only via OclHosePredictor (worker/lazy).
 */

const J_VICINAL = 7.0;
const J_AROMATIC_ORTHO = 7.8;
const J_AROMATIC_META = 1.6;
const J_ALDEHYDE = 2.4;
const J_MERGE_TOLERANCE = 0.6;

const NAMES: Record<number, string> = { 1: "d", 2: "t", 3: "q", 4: "quint", 5: "sext", 6: "sept" };

export function computeMultiplet(molecule: OCL.Molecule, hostAtom: number): NmrMultiplet {
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  const couplings: NmrCoupling[] = [];
  const hostAromatic = molecule.isAromaticAtom(hostAtom);
  const hostAldehyde = isAldehydeCarbon(molecule, hostAtom);

  // Vicinal ³J: protons on the host's heavy neighbours (path H–C–C–H).
  for (let i = 0; i < molecule.getConnAtoms(hostAtom); i += 1) {
    const neighbor = molecule.getConnAtom(hostAtom, i);
    const partnerCount = molecule.getAllHydrogens(neighbor);
    if (partnerCount <= 0) {
      continue;
    }
    if (hostAromatic && molecule.isAromaticAtom(neighbor)) {
      couplings.push({ jHz: J_AROMATIC_ORTHO, partnerCount, kind: "aromatic-ortho", toAtomIndex: neighbor });
    } else if (hostAldehyde || isAldehydeCarbon(molecule, neighbor)) {
      couplings.push({ jHz: J_ALDEHYDE, partnerCount, kind: "aldehyde", toAtomIndex: neighbor });
    } else {
      couplings.push({ jHz: J_VICINAL, partnerCount, kind: "vicinal", toAtomIndex: neighbor });
    }
  }

  // Aromatic ⁴J (meta): protons two ring bonds away.
  if (hostAromatic) {
    for (const meta of aromaticMetaPartners(molecule, hostAtom)) {
      couplings.push({
        jHz: J_AROMATIC_META,
        partnerCount: molecule.getAllHydrogens(meta),
        kind: "aromatic-meta",
        toAtomIndex: meta
      });
    }
  }

  return buildMultiplet(couplings);
}

function isAldehydeCarbon(molecule: OCL.Molecule, atom: number): boolean {
  if (molecule.getAtomicNo(atom) !== 6 || molecule.getAllHydrogens(atom) !== 1) {
    return false;
  }
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    const neighbor = molecule.getConnAtom(atom, i);
    if (molecule.getAtomicNo(neighbor) === 8 && molecule.getBondOrder(molecule.getConnBond(atom, i)) === 2) {
      return true;
    }
  }
  return false;
}

function aromaticMetaPartners(molecule: OCL.Molecule, host: number): number[] {
  const metas = new Set<number>();
  for (let i = 0; i < molecule.getConnAtoms(host); i += 1) {
    const ortho = molecule.getConnAtom(host, i);
    if (!molecule.isAromaticAtom(ortho)) {
      continue;
    }
    for (let j = 0; j < molecule.getConnAtoms(ortho); j += 1) {
      const meta = molecule.getConnAtom(ortho, j);
      if (meta !== host && molecule.isAromaticAtom(meta) && molecule.getAllHydrogens(meta) > 0) {
        metas.add(meta);
      }
    }
  }
  return [...metas];
}

/** Merge couplings with near-equal J into groups, then label by the first-order pattern. */
function buildMultiplet(couplings: readonly NmrCoupling[]): NmrMultiplet {
  const merged: NmrCoupling[] = [];
  for (const coupling of [...couplings].sort((a, b) => b.jHz - a.jHz)) {
    const existing = merged.find((m) => m.kind === coupling.kind && Math.abs(m.jHz - coupling.jHz) <= J_MERGE_TOLERANCE);
    if (existing) {
      existing.partnerCount += coupling.partnerCount;
    } else {
      merged.push({ ...coupling });
    }
  }
  if (merged.length === 0) {
    return { label: "s", couplings: [] };
  }
  merged.sort((a, b) => b.jHz - a.jHz);
  return { label: labelFor(merged), couplings: merged };
}

function labelFor(groups: readonly NmrCoupling[]): string {
  if (groups.length === 1) {
    return NAMES[groups[0].partnerCount] ?? "m";
  }
  // Compound multiplet: compact only when every group is small (d/t/q); otherwise report "m".
  const letters = groups.map((group) => (group.partnerCount <= 3 ? NAMES[group.partnerCount] : "m"));
  return letters.some((letter) => letter === "m") ? "m" : letters.join("");
}
