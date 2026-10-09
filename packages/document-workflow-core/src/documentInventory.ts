import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { nativeMoleculeRings } from "@chemdraft/layout-engine";

/** Describe native ids and geometry without introducing another ring or depiction algorithm. */
export function documentInventory(
  document: ChemDraftDocument,
  inputAtomIndices: ReadonlyMap<string, readonly (number | null)[]> = new Map()
) {
  return {
    pages: document.pages.map((page) => ({ id: page.id, width: page.width, height: page.height })),
    molecules: document.pages.flatMap((page) => page.objects.flatMap((object) =>
      object.type !== "molecule" ? [] : [{
        objectId: object.id,
        pageId: page.id,
        atoms: object.atoms.map((atom, index) => ({
          id: atom.id, element: atom.element, x: atom.x, y: atom.y,
          inputAtomIndex: inputAtomIndices.get(object.id)?.[index] ?? null
        })),
        bonds: object.bonds.map((bond) => ({
          id: bond.id, fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId,
          order: bond.order, display: bond.display ?? {}
        })),
        rings: nativeMoleculeRings(object).map((ring) => ({
          ringKey: ring.ringKey, atomIds: ring.atomIds, bondIds: ring.bondIds,
          center: ring.center, size: ring.atomIds.length
        }))
      }]
    ))
  };
}
