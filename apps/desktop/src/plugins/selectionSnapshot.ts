import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import {
  createStructureSourceFingerprint,
  type PluginSelectedMolecule,
  type PluginSelectionSnapshot
} from "@chemdraft/plugin-api";

/**
 * Build a selection snapshot from the active document: for each selected molecule, its object /
 * page / document identity, structure, and a source fingerprint for staleness detection. Molecules
 * follow the document's selection order. Pure and testable — no React, no refs. The host deep-copies
 * and freezes whatever this returns before handing it to a plugin.
 *
 * This stays a thin read over current document state so the pending selection-policy refactor
 * (PLANS-selection-policy.md) can land without touching plugin code.
 */
export function buildPluginSelectionSnapshot(document: ChemDraftDocument): PluginSelectionSnapshot {
  const located = new Map<string, { pageId: string; molecule: MoleculeObject }>();
  for (const page of document.pages) {
    for (const object of page.objects) {
      if (object.type === "molecule") {
        located.set(object.id, { pageId: page.id, molecule: object });
      }
    }
  }

  const molecules: PluginSelectedMolecule[] = [];
  for (const objectId of document.selection.objectIds) {
    const hit = located.get(objectId);
    if (!hit) {
      continue;
    }
    molecules.push({
      objectId,
      documentId: document.id,
      pageId: hit.pageId,
      structureFormat: hit.molecule.structureFormat,
      structure: hit.molecule.structure,
      sourceFingerprint: createStructureSourceFingerprint({
        documentId: document.id,
        pageId: hit.pageId,
        objectId,
        structureFormat: hit.molecule.structureFormat,
        structure: hit.molecule.structure
      })
    });
  }

  return { objectIds: document.selection.objectIds, molecules };
}
