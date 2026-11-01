import { createEmptyDocument, nativeDrawingStyleFromObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule, type PastedStructureDepiction } from "@chemdraft/document-workflow-core";
import { evaluateLayoutContacts, type LayoutContacts } from "@chemdraft/layout-engine";
import type { DepictionEngineAvailability } from "@chemdraft/rdkit-adapter/depiction";
import type { PasteDepiction } from "./depict";
import { nativeMoleculeLayoutQuality } from "./layoutQuality";

function drawingForPaste(depiction: PastedStructureDepiction, smiles: string) {
  const document = createEmptyDocument();
  const molecule = createSmilesMolecule(document, { x: 400, y: 400 }, depiction, smiles,
    undefined, { openUnspecifiedDoubleBonds: true, constrainToPage: false });
  return { document: { ...document, pages: [{ ...document.pages[0], objects: [molecule] }] }, molecule };
}

/** Paste repairs skeleton contacts only; labels and crossings retain the engine's layout. */
function hardPasteDefects(quality: LayoutContacts): number {
  return quality.overlappingAtoms.length + quality.atomBondOverlaps.length + quality.collinearBondOverlaps.length;
}

function overlapDescription(quality: LayoutContacts): string {
  return quality.overlappingAtoms.length ? "overlapping atoms"
    : quality.atomBondOverlaps.length ? "atoms overlapping bonds" : "overlapping collinear bonds";
}

/** Always publish the standard layout, warning if a deadline returns it before repair. */
export function standardPasteDepiction(result: PasteDepiction): PasteDepiction {
  if (!result.depiction.atoms.length) return result;
  const quality = evaluateLayoutContacts(result.depiction.atoms, result.depiction.bonds);
  return hardPasteDefects(quality) === 0 ? result : { ...result, warnings: [...(result.warnings ?? []),
    `Pasted structure still has ${overlapDescription(quality)}; used the standard layout without repair.`] };
}

/** Runs inside the existing depiction worker. Clean pastes perform no re-layout or engine load. */
export async function gatePasteDepiction(
  result: PasteDepiction, smiles: string, availability: DepictionEngineAvailability & { standardOnly?: boolean } = {}
): Promise<PasteDepiction> {
  if (availability.standardOnly) return standardPasteDepiction(result);
  if (!result.depiction.atoms.length) return result;
  const original = evaluateLayoutContacts(result.depiction.atoms, result.depiction.bonds);
  if (hardPasteDefects(original) === 0) return result;
  const { document, molecule } = drawingForPaste(result.depiction, smiles);
  const warnings = [...(result.warnings ?? [])];
  try {
    // Only failed depictions reach the host's shared selection. No second ranking, mapping,
    // repair or stereo implementation is maintained for paste, and no document is committed here.
    if (availability.oclLoadFailure !== undefined) throw new Error(availability.oclLoadFailure);
    const { relayoutMolfile2D, perceiveStereoCentersFromMolfile } = await import("@chemdraft/ocl-adapter");
    const { prepareNativeMoleculeEngineRelayout } = await import("../documentWorkflow");
    const prepared = await prepareNativeMoleculeEngineRelayout(document, molecule.id, relayoutMolfile2D, async () => {
      if (availability.rdkitLoadFailure !== undefined) return [];
      const { createRdkit2DRelayouts } = await import("@chemdraft/rdkit-adapter/depiction");
      return createRdkit2DRelayouts();
    }, { targetBondLengthPx: nativeDrawingStyleFromObjectStyle(molecule.style).bondLengthPx,
      perceiveStereo: perceiveStereoCentersFromMolfile });
    const after = prepared.pages[0].objects[0] as MoleculeObject;
    if (hardPasteDefects(nativeMoleculeLayoutQuality(after, false)) === 0) {
      const indices = new Map(after.atoms.map((atom, i) => [atom.id, i]));
      return { ...result, depiction: {
        atoms: after.atoms.map(atom => ({ element: atom.element, charge: atom.formalCharge,
          ...(atom.isotope === undefined ? {} : { isotope: atom.isotope }), x: atom.x, y: -atom.y })),
        bonds: after.bonds.map(bond => ({ from: indices.get(bond.fromAtomId)!, to: indices.get(bond.toAtomId)!,
          order: bond.order, ...(bond.stereo === "either" ? { stereo: "either" as const } : {}),
          wedge: bond.display?.bondStyle === "wedge" ? "wedge" : bond.display?.bondStyle === "hashed" ? "hashed" : null }))
      } };
    }
  } catch (error) {
    warnings.push(`Paste layout repair failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  warnings.push(`Pasted structure still has ${overlapDescription(original)}; no generated layout cleared the overlaps.`);
  return { ...result, warnings };
}
