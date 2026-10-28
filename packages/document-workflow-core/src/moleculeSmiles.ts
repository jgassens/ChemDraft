// SMILES for one native molecule on export: RDKit's identifiers when the caller supplies them, the
// native graph writer otherwise, with every approximation reported as an export warning.
// Moved verbatim from apps/desktop/src/moleculeSmiles.ts; loading the engine stays in the desktop.

import { isDativeBond, moleculeToMolfileV2000, type MoleculeObject } from "@chemdraft/chem-core";
import type { ExportWarning } from "@chemdraft/export-engine";
import {
  nativeAtomChargeIsExpressible,
  nativeAtomValence,
  nativeAtomValenceForCharge,
  nativeBondOrderResolution,
  nativeElementFromAtomLabel
} from "@chemdraft/layout-engine";

import { expandNativeMoleculeLabelGroups, nativeImplicitHydrogenCount, nativeSingleHeavyElementLabelValence } from "./atoms";
import { nativeMoleculeUnspellableLabels, nativeSingleBondGraphSmiles, nativeSmilesBondOrderResolution } from "./smiles";

export type ComputeStructureIdentifiers = typeof import("@chemdraft/rdkit-adapter/identifiers").computeStructureIdentifiers;

/** SMILES infers radicals from valence; compare that count with the drawn dots using the
 * same element, charge and hydrogen rules as the native labels and writer.
 */
export function nativeSmilesRadicalWarnings(molecule: MoleculeObject): ExportWarning[] {
  const { molecule: expanded } = expandNativeMoleculeLabelGroups(molecule);
  const resolution = nativeBondOrderResolution(expanded.atoms, expanded.bonds);
  return expanded.atoms.flatMap((atom): ExportWarning[] => {
    const radicals = atom.markRadicals ?? 0;
    const used = resolution.bondOrderUsage.get(atom.id) ?? 0;
    const directElement = nativeElementFromAtomLabel(atom.element);
    const spelled = directElement ? undefined : nativeSingleHeavyElementLabelValence(atom.element);
    const isotopeHydrogen = atom.element === "D" || atom.element === "T";
    const element = isotopeHydrogen ? "H" : directElement ?? spelled?.element;
    let implied: number | undefined;
    if (element && nativeAtomValence[element] !== undefined &&
        nativeAtomChargeIsExpressible(element, atom.formalCharge)) {
      const valence = nativeAtomValenceForCharge(element, atom.formalCharge);
      const hydrogens = element === "H" ? 0 : atom.labelLiteral ? (spelled?.hydrogens ?? 0) :
        atom.hydrogenCount ?? spelled?.hydrogens ?? Math.max(0, valence - used - radicals);
      implied = Math.max(0, valence - used - hydrogens);
    } else if (element && nativeAtomValence[element] === undefined) {
      // The drawing's covalent valence table says nothing about the parser's metal valence.
      if (radicals === 0 && atom.formalCharge !== 0) return [];
    } else if (radicals === 0 && (!atom.labelLiteral || !element)) return [];
    if (implied === radicals) return [];
    const drawn = `Atom ${atom.id} (${atom.element}) is drawn with ${radicals} radical electron${radicals === 1 ? "" : "s"}`;
    const addedIsotopeHydrogen = isotopeHydrogen && used === 0 && radicals === 0 &&
      atom.formalCharge === 0 && !atom.labelLiteral;
    return [{
      code: "export.smiles_radical_loss",
      message: addedIsotopeHydrogen
        ? `${drawn}; SMILES cannot preserve its hydrogen count: the engine adds 1 hydrogen; the native writer instead implies 1 radical electron.`
        : implied === undefined
          ? `${drawn}; SMILES' implied radical count cannot be reliably determined without the structure engine for this element and charge.`
          : `${drawn}; SMILES would imply ${implied} radical electron${implied === 1 ? "" : "s"} with its hydrogen count and formal charge.`,
      severity: "warning",
      objectId: molecule.id
    }];
  });
}

export async function moleculeSmiles(
  molecule: MoleculeObject,
  index: number,
  warnings: ExportWarning[],
  computeStructureIdentifiers: ComputeStructureIdentifiers | undefined,
  molfile?: string,
  options: { requireEngineAtomStates?: boolean } = {}
): Promise<string> {
  const requireEngineAtomStates = options.requireEngineAtomStates ?? false;
  // Both the V2000 input to RDKit and the native fallback approximate these features.
  const dativeBondCount = molecule.bonds.filter(isDativeBond).length;
  if (dativeBondCount > 0) {
    warnings.push({
      code: "export.smiles_dative_bond",
      message: `SMILES has no dative/coordination bond: ${dativeBondCount} dashed bond(s) written as plain single.`,
      severity: "warning",
      objectId: molecule.id
    });
  }
  // Refuse unknown-order bonds before either route or the stored-SMILES shortcut can lose them.
  // Aromatic downgrades belong to the native writer alone — RDKit reads the molfile's type-4
  // bonds and resolves them itself — so those are reported only on the fallback below.
  const bondOrders = nativeSmilesBondOrderResolution(molecule.atoms, molecule.bonds);
  const bondOrderWarning = (message: string): ExportWarning => ({
    code: "export.smiles_bond_order", message, severity: "warning", objectId: molecule.id
  });
  for (const label of nativeMoleculeUnspellableLabels(molecule)) {
    warnings.push({
      code: "export.smiles_atom_label",
      message: `Atom label "${label}" cannot be spelled as a single SMILES atom; written as a dummy atom [*].`,
      severity: "warning",
      objectId: molecule.id
    });
  }
  // Both routes write a valid group label as the atoms it stands for; say which ones, once each.
  const expanded = expandNativeMoleculeLabelGroups(molecule);
  for (const label of [...new Set(expanded.expansions.map((expansion) => expansion.label))]) {
    warnings.push({
      code: "export.smiles_abbreviation_expanded",
      message: `Abbreviation "${label}" was written out as the atoms it stands for.`,
      severity: "info",
      objectId: molecule.id
    });
  }
  // MDL has no code for three or four radical electrons. Use the native bracket spelling
  // instead of feeding an already changed radical count to the engine. Keep the fallback's
  // stereo warning if that graph also needs stereochemical notation.
  const hasDrawnRadicals = molecule.atoms.some((atom) => (atom.markRadicals ?? 0) > 0);
  const needsNativeRadicals = molecule.atoms.some((atom) => (atom.markRadicals ?? 0) > 2);
  let engineUnavailable = !computeStructureIdentifiers;
  if (computeStructureIdentifiers && !needsNativeRadicals) {
    try {
      const writerWarnings: string[] = [];
      const placeholderAtoms = new Map(expanded.placeholderAtoms);
      for (const atom of expanded.molecule.atoms) {
        const spelled = nativeSingleHeavyElementLabelValence(atom.element);
        if ((atom.markRadicals ?? 0) > 0 && spelled && spelled.element !== atom.element) {
          placeholderAtoms.set(atom.id, "it carries radical electrons, so its stated hydrogen count cannot be preserved");
        }
      }
      const identifiers = await computeStructureIdentifiers(
        molfile ?? moleculeToMolfileV2000(expanded.molecule, {
          unknownBondOrders: "refuse",
          fromDocFrame: true,
          warnings: writerWarnings,
          messageFormat: "SMILES",
          spellLabel: nativeSingleHeavyElementLabelValence,
          kekuleBondOrders: nativeBondOrderResolution(expanded.molecule.atoms, expanded.molecule.bonds).kekuleOrders,
          placeholderAtoms
        }).contents,
        { includeAtomStates: true }
      );
      if (identifiers?.smiles) {
        // Older engines and identifier-only callers have no atom-state parser. Preserve their
        // existing messages, but require evidence for strict exports and drawn radical marks.
        if (identifiers.smilesAtomStates !== undefined || identifiers.smilesAtomOrder !== undefined ||
            requireEngineAtomStates || hasDrawnRadicals) {
          warnings.push(...engineSmilesAtomWarnings(molecule, identifiers));
        }
        // Only report these losses when the engine's molfile route supplied the output.
        warnings.push(...writerWarnings.map((message): ExportWarning => ({
          code: "export.smiles_v2000_loss",
          message,
          severity: "warning",
          objectId: molecule.id
        })));
        return identifiers.smiles;
      }
      engineUnavailable = true;
    } catch {
      engineUnavailable = true;
      // A failed engine load or parse falls back per molecule, without dropping its record.
    }
  }
  if (moleculeHasSmilesStereo(molecule)) {
    warnings.push({
      code: "export.smiles_stereo_dropped",
      message: `Stereochemistry could not be written to SMILES for molecule ${index + 1}; ${needsNativeRadicals
        ? "the native writer required to preserve its radical count does not support stereochemistry"
        : "the structure engine was unavailable"}.`,
      severity: "warning",
      objectId: molecule.id
    });
  }
  warnings.push(...bondOrders.warnings.aromatic.map(bondOrderWarning));
  // The stored string is trusted only when every atom writes as itself: no group expanded, and no
  // label written as a dummy atom — a placeholder ("R"), unrecognized text ("Ome"), a flagged group,
  // a bonded "Ar". Otherwise it may say something else entirely (a stored "CO" for a C–R drawing,
  // "[Ar]O" for aryl alcohol) while the warnings above promise [*]; write the current graph instead.
  if (
    engineUnavailable && !requireEngineAtomStates &&
    expanded.expansions.length === 0 &&
    expanded.placeholderAtoms.size === 0 &&
    nativeMoleculeUnspellableLabels(molecule).length === 0 &&
    !molecule.atoms.some((atom) => (atom.markRadicals ?? 0) > 0) &&
    !molecule.bonds.some((bond) => bond.stereo === "either") &&
    molecule.structureFormat === "smiles" &&
    molecule.structure
  ) {
    warnings.push(...nativeSmilesRadicalWarnings(molecule));
    return molecule.structure;
  }
  const atomOrder: string[] = [];
  const smiles = nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds, undefined, atomOrder);
  // Reparse when radical marks or strict verification need engine evidence: some native
  // spellings parse even when their MDL radical encoding does not (for example D with two dots).
  // Ordinary fallback exports keep their existing behavior after load, parse or writer failure.
  if (computeStructureIdentifiers && (hasDrawnRadicals || requireEngineAtomStates)) {
    try {
      const identifiers = await computeStructureIdentifiers(smiles, { includeAtomStates: true });
      if (identifiers?.smilesAtomOrder && identifiers.smilesAtomStates) {
        const inputIndexById = new Map(expanded.molecule.atoms.map((atom, inputIndex) => [atom.id, inputIndex]));
        warnings.push(...engineSmilesAtomWarnings(molecule, {
          ...identifiers,
          smilesAtomOrder: identifiers.smilesAtomOrder.map((outputIndex) => inputIndexById.get(atomOrder[outputIndex]!) ?? -1)
        }));
        return smiles;
      }
    } catch {
      // Without a usable engine the native predictor remains the only available warning.
    }
  }
  warnings.push(...(requireEngineAtomStates
    ? engineSmilesAtomWarnings(molecule, undefined)
    : nativeSmilesRadicalWarnings(molecule)));
  return smiles;
}

/**
 * Compare the expanded drawing with the reparsed output using RDKit's exact output traversal.
 * Label expansion and the molfile writer retain drawn atom order; canonical SMILES does not.
 * Explicit H survives both parses, so even added group hydrogens keep their input indices.
 * Expectations reuse the drawing's label rules, never a second engine valence table.
 */
export function engineSmilesAtomWarnings(
  molecule: MoleculeObject,
  identifiers: Awaited<ReturnType<ComputeStructureIdentifiers>>
): ExportWarning[] {
  const { molecule: expanded, placeholderAtoms } = expandNativeMoleculeLabelGroups(molecule);
  const states = identifiers?.smilesAtomStates;
  const order = identifiers?.smilesAtomOrder;
  const warning = (code: string, message: string): ExportWarning =>
    ({ code, message, severity: "warning", objectId: molecule.id });
  if (!states || !order || states.length !== expanded.atoms.length || order.length !== states.length ||
      new Set(order).size !== order.length || order.some((index) => !expanded.atoms[index])) {
    return [warning("export.smiles_atom_state_unverified",
      `Atom states (${expanded.atoms.map((atom) => `Atom ${atom.id} (${atom.element})`).join(", ")}) could not be verified against the exported SMILES by the structure engine.`)];
  }
  const actualByInput = new Map(order.map((inputIndex, outputIndex) => [inputIndex, states[outputIndex]!]));
  const resolution = nativeBondOrderResolution(expanded.atoms, expanded.bonds);
  const atomsById = new Map(expanded.atoms.map((atom) => [atom.id, atom]));
  const losses = expanded.atoms.flatMap((atom, inputIndex): ExportWarning[] => {
    const actual = actualByInput.get(inputIndex)!;
    const isotopeHydrogen = atom.element === "D" || atom.element === "T";
    const direct = nativeElementFromAtomLabel(atom.element);
    const spelled = direct ? undefined : nativeSingleHeavyElementLabelValence(atom.element);
    const element = isotopeHydrogen ? "H" : direct ?? spelled?.element;
    // Unspellable labels already have an explicit placeholder warning; still check their marks.
    const expectedElement = placeholderAtoms.has(atom.id) || !element ? "*" : element;
    const radicals = atom.markRadicals ?? 0;
    const isotope = atom.element === "D" ? 2 : atom.element === "T" ? 3 : 0;
    const bondedHydrogens = (resolution.bondsByAtom.get(atom.id) ?? []).filter((bond) => {
      const neighbor = atomsById.get(bond.fromAtomId === atom.id ? bond.toAtomId : bond.fromAtomId);
      return neighbor && ["H", "D", "T"].includes(neighbor.element);
    }).length;
    const hydrogens = bondedHydrogens + (isotopeHydrogen || element === "H" ? 0 :
      atom.labelLiteral ? spelled?.hydrogens ?? 0 :
      atom.hydrogenCount ?? spelled?.hydrogens ?? (direct
        ? nativeImplicitHydrogenCount(direct, resolution.bondOrderUsage.get(atom.id) ?? 0, atom.formalCharge, radicals)
        : 0));
    const prefix = `Atom ${atom.id} (${atom.element})`;
    const losses: ExportWarning[] = [];
    if (radicals !== actual.nRad) losses.push(warning("export.smiles_radical_loss",
      `${prefix} is drawn with ${radicals} radical electron${radicals === 1 ? "" : "s"}; SMILES reparses with ${actual.nRad} radical electron${actual.nRad === 1 ? "" : "s"}.`));
    if (hydrogens !== actual.hydrogenCount) losses.push(warning("export.smiles_hydrogen_loss",
      `${prefix} is drawn with ${hydrogens} total hydrogen${hydrogens === 1 ? "" : "s"}; SMILES reparses with ${actual.hydrogenCount} total hydrogen${actual.hydrogenCount === 1 ? "" : "s"}.`));
    if (atom.formalCharge !== actual.formalCharge) losses.push(warning("export.smiles_charge_loss",
      `${prefix} is drawn with formal charge ${atom.formalCharge}; SMILES reparses with formal charge ${actual.formalCharge}.`));
    if (isotope !== actual.isotope) losses.push(warning("export.smiles_isotope_loss",
      `${prefix} is drawn with isotope ${isotope}; SMILES reparses with isotope ${actual.isotope}.`));
    if (expectedElement !== actual.element) losses.push(warning("export.smiles_element_loss",
      `${prefix} is drawn as ${expectedElement}; SMILES reparses as ${actual.element}.`));
    return losses;
  });
  // Sanitization can redistribute formal charges in neutral hypervalent drawings. It is
  // informational only when every other mapped atom state and the molecular charge survive.
  if (losses.length > 0 && losses.every((loss) => loss.code === "export.smiles_charge_loss") &&
      expanded.atoms.reduce((sum, atom) => sum + atom.formalCharge, 0) ===
        states.reduce((sum, atom) => sum + atom.formalCharge, 0)) {
    return [{
      code: "export.smiles_charge_separated",
      message: `SMILES writes charge-separated formal charges while preserving total charge: ${losses.map((loss) => loss.message).join(" ")}`,
      severity: "info",
      objectId: molecule.id
    }];
  }
  return losses;
}

/** The native graph writer has neither tetrahedral nor double-bond stereo notation. */
function moleculeHasSmilesStereo(molecule: MoleculeObject): boolean {
  const heavyAtomIds = new Set(molecule.atoms
    .filter((atom) => !["H", "D", "T"].includes(atom.element))
    .map((atom) => atom.id));
  const hasOtherHeavyNeighbor = (atomId: string, otherEndId: string): boolean =>
    molecule.bonds.some((bond) => !isDativeBond(bond) && (
      (bond.fromAtomId === atomId && bond.toAtomId !== otherEndId && heavyAtomIds.has(bond.toAtomId)) ||
      (bond.toAtomId === atomId && bond.fromAtomId !== otherEndId && heavyAtomIds.has(bond.fromAtomId))
    ));
  return molecule.bonds.some((bond) =>
    bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed" ||
    (bond.order === "double" &&
      hasOtherHeavyNeighbor(bond.fromAtomId, bond.toAtomId) &&
      hasOtherHeavyNeighbor(bond.toAtomId, bond.fromAtomId))
  );
}
