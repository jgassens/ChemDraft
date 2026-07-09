import * as OCL from "openchemlib";

/**
 * Coarse functional-group shift estimates for atoms the HOSE database does not cover, so a proton (or
 * carbon) is never silently dropped. Classifies the host by OCL topology (aldehyde, aromatic, alkene,
 * alkyne, CH adjacent to O/N/halogen, α-to-carbonyl, generic sp³) and returns a typical shift. These
 * are deliberately rough, first-approximation values — surfaced as `rule-estimated`, never as a
 * measured match. Runtime OpenChemLib import; reachable only via OclHosePredictor (worker/lazy).
 */

const HALOGENS = new Set([9, 17, 35, 53]);

export function estimateProtonShift(molecule: OCL.Molecule, host: number): number {
  molecule.ensureHelperArrays(OCL.Molecule.cHelperRings);
  if (isAldehyde(molecule, host)) return 9.7;
  if (molecule.isAromaticAtom(host)) return 7.3;
  if (maxBondOrderTo(molecule, host, 6) === 3) return 2.4; // alkyne C–H
  if (maxBondOrderTo(molecule, host, 6) === 2) return 5.7; // vinyl / alkene C–H
  if (bondedTo(molecule, host, 8)) return 3.6; // C–O
  if (bondedTo(molecule, host, 7)) return 2.7; // C–N
  if (bondedToHalogen(molecule, host)) return 3.4;
  if (alphaToCarbonyl(molecule, host)) return 2.3;
  return 1.3; // generic sp³ C–H
}

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

function maxBondOrderTo(molecule: OCL.Molecule, atom: number, element: number): number {
  let max = 0;
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    if (molecule.getAtomicNo(molecule.getConnAtom(atom, i)) === element) {
      max = Math.max(max, molecule.getBondOrder(molecule.getConnBond(atom, i)));
    }
  }
  return max;
}

function isCarbonyl(molecule: OCL.Molecule, atom: number): boolean {
  return molecule.getAtomicNo(atom) === 6 && maxBondOrderTo(molecule, atom, 8) === 2;
}

function isAldehyde(molecule: OCL.Molecule, atom: number): boolean {
  return isCarbonyl(molecule, atom) && molecule.getAllHydrogens(atom) === 1;
}

function bondedTo(molecule: OCL.Molecule, atom: number, element: number): boolean {
  return countBondedTo(molecule, atom, element) > 0;
}

function countBondedTo(molecule: OCL.Molecule, atom: number, element: number): number {
  let count = 0;
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    if (molecule.getAtomicNo(molecule.getConnAtom(atom, i)) === element) count += 1;
  }
  return count;
}

function bondedToHalogen(molecule: OCL.Molecule, atom: number): boolean {
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    if (HALOGENS.has(molecule.getAtomicNo(molecule.getConnAtom(atom, i)))) return true;
  }
  return false;
}

function alphaToCarbonyl(molecule: OCL.Molecule, atom: number): boolean {
  for (let i = 0; i < molecule.getConnAtoms(atom); i += 1) {
    if (isCarbonyl(molecule, molecule.getConnAtom(atom, i))) return true;
  }
  return false;
}
