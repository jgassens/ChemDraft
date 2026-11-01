import { createEmptyDocument, nativeDrawingStyleFromObjectStyle, type MoleculeObject } from "@chemdraft/chem-core";
import { createSmilesMolecule, type PastedStructureDepiction } from "@chemdraft/document-workflow-core";
import { evaluateLayoutQuality, layoutAtomAndLabelDefects, moleculeLayoutLabelBoxes, type LayoutQuality } from "@chemdraft/layout-engine";
import type { DepictionEngineAvailability } from "@chemdraft/rdkit-adapter/depiction";
import type { PasteDepiction } from "./depict";

/** Renderer-aware hard geometry, shared by paste and the Clean Up command status. */
export function nativeMoleculeLayoutQuality(molecule: MoleculeObject): LayoutQuality {
  const indices = new Map(molecule.atoms.map((atom, i) => [atom.id, i]));
  return evaluateLayoutQuality(molecule.atoms, molecule.bonds.map(bond => ({
    from: indices.get(bond.fromAtomId)!, to: indices.get(bond.toAtomId)!
  })), undefined, undefined, undefined, moleculeLayoutLabelBoxes(molecule));
}

function drawingForPaste(depiction: PastedStructureDepiction, smiles: string) {
  const document = createEmptyDocument();
  const molecule = createSmilesMolecule(document, { x: 400, y: 400 }, depiction, smiles,
    undefined, { openUnspecifiedDoubleBonds: true, constrainToPage: false });
  return { document: { ...document, pages: [{ ...document.pages[0], objects: [molecule] }] }, molecule };
}

/** Also screens the deadline fallback: never publish a known-overlapping standard layout. */
export function pasteDepictionHasOverlaps(result: PasteDepiction, smiles: string): boolean {
  if (!result.depiction.atoms.length) return false;
  return layoutAtomAndLabelDefects(nativeMoleculeLayoutQuality(drawingForPaste(result.depiction, smiles).molecule)) > 0;
}

/** Runs inside the existing depiction worker. Clean pastes perform no re-layout or engine load. */
export async function gatePasteDepiction(
  result: PasteDepiction, smiles: string, availability: DepictionEngineAvailability = {}
): Promise<PasteDepiction> {
  if (!result.depiction.atoms.length) return result;
  const { document, molecule } = drawingForPaste(result.depiction, smiles);
  const original = nativeMoleculeLayoutQuality(molecule);
  if (layoutAtomAndLabelDefects(original) === 0) return result;
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
    if (layoutAtomAndLabelDefects(nativeMoleculeLayoutQuality(after)) === 0) {
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
  const overlap = original.overlappingAtoms.length ? "overlapping atoms"
    : original.atomBondOverlaps.length ? "atoms overlapping bonds"
    : original.collinearBondOverlaps.length ? "overlapping collinear bonds" : "overlapping atom labels";
  warnings.push(`Pasted structure still has ${overlap}; no generated layout cleared the overlaps.`);
  return { ...result, warnings };
}
