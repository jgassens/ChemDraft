import { moleculeToMolfileV2000, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import {
  createStructureSourceFingerprint,
  type PluginSelectedMolecule,
  type PluginSelectionSnapshot,
  type PluginStructureFormat
} from "@chemdraft/plugin-api";

/**
 * The structure a plugin should analyze for `molecule`.
 *
 * A native drawing (and any molecule the editor has parsed into an atom/bond graph) is the source
 * of truth in its `atoms`/`bonds`. The object's own `structure` string is a hand-rolled SMILES that
 * is *lossy* for anything the writer can't linearize — fused/polycyclic ring systems collapse to a
 * bare atom concatenation (e.g. naphthalene → `CCCCCCCCCC`, which OCL reads as decane). Handing the
 * plugin that string makes it predict the wrong molecule entirely.
 *
 * So whenever a live graph exists we serialize it to a lossless V2000 molfile — a plain connection
 * table (no OCL, no aromaticity/ring perception on our side; the plugin's OCL does that) — and let the
 * plugin parse it. Only when there is no graph (e.g. a molecule imported as SMILES that was never
 * parsed) do we fall back to the object's existing structure string.
 */
export function pluginFacingStructure(
  molecule: MoleculeObject
): { structureFormat: PluginStructureFormat; structure: string } {
  if (molecule.atoms && molecule.atoms.length > 0) {
    try {
      return {
        structureFormat: "molfile-v2000",
        // Native atoms live in the document (y-down) frame; molfiles are y-up.
        structure: moleculeToMolfileV2000(molecule, { fromDocFrame: true })
      };
    } catch {
      // >999 atoms/bonds or other writer limit: fall back to whatever the object already carries
      // rather than dropping the molecule from the selection.
    }
  }
  return { structureFormat: molecule.structureFormat, structure: molecule.structure };
}

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
    const facing = pluginFacingStructure(hit.molecule);
    molecules.push({
      objectId,
      documentId: document.id,
      pageId: hit.pageId,
      structureFormat: facing.structureFormat,
      structure: facing.structure,
      // Fingerprint stays keyed on the object's own coordinate-free structure string (not the
      // emitted molfile) so a pure move never reads as a content change / staleness.
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

/**
 * Recompute the source fingerprint for a specific molecule in the current document (independent of
 * selection), for staleness detection (D-09): a panel report carries the fingerprint it was computed
 * against; if this no longer matches — or the object is gone — the report is stale. Returns undefined
 * when the object no longer exists or is not a molecule.
 */
export function computeObjectFingerprint(document: ChemDraftDocument, objectId: string): string | undefined {
  for (const page of document.pages) {
    for (const object of page.objects) {
      if (object.type === "molecule" && object.id === objectId) {
        return createStructureSourceFingerprint({
          documentId: document.id,
          pageId: page.id,
          objectId,
          structureFormat: object.structureFormat,
          structure: object.structure
        });
      }
    }
  }
  return undefined;
}
