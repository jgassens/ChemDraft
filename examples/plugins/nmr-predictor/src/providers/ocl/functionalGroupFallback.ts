import * as OCL from "openchemlib";

import type { NmrEstimateProvenance } from "../../domain/contracts";
import {
  aromaticComponentIsCarbocyclic,
  countBondedTo,
  isAldehyde,
  isCarbonyl,
  maxBondOrderTo
} from "./oclTopology";

/**
 * Coarse carbon functional-group shift helpers. The numeric function supports bounded rule tests; the live
 * provider routes unmatched carbon environments through `estimateCarbonShiftWithApplicability`, so
 * unsupported chemistry is omitted rather than guaranteed a number. Applicable values remain rough,
 * disclosed `rule-estimated` approximations, never measured matches.
 */

const HALOGENS = new Set([9, 17, 35, 53]);
const SUPPORTED_DIRECT_ELEMENTS = new Set([6, 7, 8, 9, 17, 35, 53]);

export const FUNCTIONAL_GROUP_ESTIMATOR_ID = "chemdraft.functional-group-rules";
export const FUNCTIONAL_GROUP_ESTIMATOR_VERSION = "1.1.0";

export type CarbonRuleEstimate =
  | { applicable: true; ppm: number; estimator: NmrEstimateProvenance }
  | {
      applicable: false;
      reason:
        | "non-carbon-host"
        | "charged-structure"
        | "isotopically-labeled-structure"
        | "radical-structure"
        | "heteroaromatic-ring"
        | "unsupported-substituent"
        | "unsupported-bonding-environment";
      estimator: NmrEstimateProvenance;
    };

export function estimateCarbonShift(molecule: OCL.Molecule, host: number): number {
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  if (isCarbonyl(molecule, host)) {
    // Two oxygens (acid/ester) resonate lower than a lone ketone/aldehyde carbonyl.
    return countBondedTo(molecule, host, 8) >= 2 ? 172 : isAldehyde(molecule, host) ? 192 : 205;
  }
  if (molecule.isAromaticAtom(host)) return 128;
  if (maxBondOrderTo(molecule, host, 6) === 3) return 80; // alkyne
  if (maxBondOrderTo(molecule, host, 6) === 2) return 125; // alkene
  if (bondedTo(molecule, host, 8)) return 65;
  if (bondedTo(molecule, host, 7)) return 47;
  if (bondedToHalogen(molecule, host)) return 35;
  return 25; // generic sp³
}

/** Applicability-gated form used by the live provider. The numeric helper above remains useful for
 * isolated rule tests, but unmatched environments only enter a result through this explicit gate. */
export function estimateCarbonShiftWithApplicability(molecule: OCL.Molecule, host: number): CarbonRuleEstimate {
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  if (molecule.getAtomicNo(host) !== 6) {
    return unavailableCarbon("non-carbon-host");
  }
  for (let atom = 0; atom < molecule.getAllAtoms(); atom += 1) {
    if (molecule.getAtomMass(atom) !== 0) return unavailableCarbon("isotopically-labeled-structure");
    if (molecule.getAtomRadical(atom) !== OCL.Molecule.cAtomRadicalStateNone) return unavailableCarbon("radical-structure");
    if (molecule.getAtomCharge(atom) !== 0) return unavailableCarbon("charged-structure");
  }
  for (let i = 0; i < molecule.getConnAtoms(host); i += 1) {
    const neighbor = molecule.getConnAtom(host, i);
    const element = molecule.getAtomicNo(neighbor);
    if (element !== 1 && !SUPPORTED_DIRECT_ELEMENTS.has(element)) {
      return unavailableCarbon("unsupported-substituent");
    }
  }
  if (molecule.isAromaticAtom(host) && !aromaticComponentIsCarbocyclic(molecule, host)) {
    return unavailableCarbon("heteroaromatic-ring");
  }
  const method = carbonRuleMethod(molecule, host);
  if (!method) {
    return unavailableCarbon("unsupported-bonding-environment");
  }
  return {
    applicable: true,
    ppm: estimateCarbonShift(molecule, host),
    estimator: carbonEstimator(method)
  };
}

function carbonRuleMethod(molecule: OCL.Molecule, host: number): string | undefined {
  if (isCarbonyl(molecule, host)) {
    const multipleBonds = connectedMultipleBonds(molecule, host);
    if (multipleBonds.length !== 1 || multipleBonds[0].element !== 8 || multipleBonds[0].order !== 2) {
      return undefined;
    }
    if (countBondedTo(molecule, host, 8) >= 2) return "carbonyl-acid-or-ester";
    if (bondedTo(molecule, host, 7)) return undefined; // amide C=O is not represented by the ketone rule
    return isAldehyde(molecule, host) ? "carbonyl-aldehyde" : "carbonyl-ketone";
  }
  if (molecule.isAromaticAtom(host)) return "aromatic-carbon";
  const multipleBonds = connectedMultipleBonds(molecule, host);
  if (multipleBonds.length > 0) {
    // Only C=C and C≡C are explicit coarse classes. C=N, C≡N, N=C=O, and other multiply bonded
    // heteroatom environments must not collapse to the generic 47/25 ppm rules.
    if (multipleBonds.every((bond) => bond.element === 6 && bond.order === 3)) return "alkynyl-carbon";
    if (multipleBonds.every((bond) => bond.element === 6 && bond.order === 2)) return "vinylic-carbon";
    return undefined;
  }
  if (bondedTo(molecule, host, 8)) return "oxygen-substituted-carbon";
  if (bondedTo(molecule, host, 7)) return "nitrogen-substituted-carbon";
  if (bondedToHalogen(molecule, host)) return "halogen-substituted-carbon";
  return "generic-sp3-carbon";
}

function connectedMultipleBonds(
  molecule: OCL.Molecule,
  atom: number
): { element: number; order: number }[] {
  const bonds: { element: number; order: number }[] = [];
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    const bond = molecule.getConnBond(atom, i);
    if (molecule.isAromaticBond(bond)) continue;
    const order = molecule.getBondOrder(bond);
    if (order > 1) {
      bonds.push({ element: molecule.getAtomicNo(molecule.getConnAtom(atom, i)), order });
    }
  }
  return bonds;
}

function unavailableCarbon(reason: Extract<CarbonRuleEstimate, { applicable: false }>["reason"]): CarbonRuleEstimate {
  return { applicable: false, reason, estimator: carbonEstimator("applicability-check") };
}

function carbonEstimator(method: string): NmrEstimateProvenance {
  return { id: FUNCTIONAL_GROUP_ESTIMATOR_ID, version: FUNCTIONAL_GROUP_ESTIMATOR_VERSION, method };
}

function bondedTo(molecule: OCL.Molecule, atom: number, element: number): boolean {
  return countBondedTo(molecule, atom, element) > 0;
}

function bondedToHalogen(molecule: OCL.Molecule, atom: number): boolean {
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    if (HALOGENS.has(molecule.getAtomicNo(molecule.getConnAtom(atom, i)))) return true;
  }
  return false;
}
