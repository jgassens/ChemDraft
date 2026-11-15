import { isEngineDocument, moleculeToMolfileV2000, type ChemDraftDocument, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { expandNativeMoleculeLabelGroups, nativeSingleHeavyElementLabelValence } from "@chemdraft/document-workflow-core";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
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
  molecule: MoleculeObject,
  warnings: string[] = []
): { structureFormat: PluginStructureFormat; structure: string } {
  if (molecule.atoms && molecule.atoms.length > 0) {
    try {
      // A valid group label ("OMe", "Ph") is handed over as the atoms it stands for, appended after
      // the drawn atoms, so the plugin predicts for the molecule the drawing means.
      const { molecule: expanded, placeholderAtoms } = expandNativeMoleculeLabelGroups(molecule);
      return {
        structureFormat: "molfile-v2000",
        // Native atoms live in the document (y-down) frame; molfiles are y-up. A condensed label
        // naming one heavy atom ("OH", "NH2") is spelled as that atom with exactly its hydrogens,
        // through the valence field, which OpenChemLib honours. Any label still left — a
        // placeholder, unrecognized text, a flagged group — is handed over as an R-group
        // pseudo-atom, not the export dummy "*": the plugin's OpenChemLib reads "*" as a carbon
        // and would predict for a molecule the user did not draw, with nothing to tell it
        // otherwise. An R-group is honestly "a group this file does not spell" (AGENTS.md §12 UI:
        // no fake chemistry).
        structure: moleculeToMolfileV2000(expanded, {
          fromDocFrame: true,
          warnings,
          abbreviations: "rgroup",
          kekuleBondOrders: nativeBondOrderResolution(expanded.atoms, expanded.bonds).kekuleOrders,
          spellLabel: nativeSingleHeavyElementLabelValence,
          placeholderAtoms
        }).contents
      };
    } catch (error) {
      warnings.push(`Molecule ${molecule.id} could not be written from its graph: ${String(error)}; using its stored structure.`);
      // >999 atoms/bonds or other writer limit: fall back to whatever the object already carries
      // rather than dropping the molecule from the selection.
    }
  }
  return { structureFormat: molecule.structureFormat, structure: molecule.structure };
}

/** Signed orientation, with a relative tolerance for roundoff at collinear points after rotation. */
function orientation(a: MoleculeAtom, b: MoleculeAtom, c: MoleculeAtom): number {
  const bx = b.x - a.x;
  const by = b.y - a.y;
  const cx = c.x - a.x;
  const cy = c.y - a.y;
  const cross = bx * cy - by * cx;
  return Math.abs(cross) <= 1e-10 * Math.hypot(bx, by) * Math.hypot(cx, cy) ? 0 : Math.sign(cross);
}

/**
 * Conservative local stereo geometry, not CIP assignments. Orientation signs retain the geometry
 * that a plugin's molfile reader uses without retaining positions, angles or bond lengths. This
 * avoids loading a chemistry engine during render. Work runs only on cache misses for owned graphs.
 */
function moleculeStereoGeometry(molecule: MoleculeObject): Array<[string, number[]]> {
  const stereoBonds = molecule.bonds.filter(bond =>
    (bond.order === "double" && bond.stereo !== "either") ||
    bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed"
  );
  if (stereoBonds.length === 0) return [];

  const atoms = new Map(molecule.atoms.map(atom => [atom.id, atom]));
  const neighbors = new Map(molecule.atoms.map(atom => [atom.id, [] as MoleculeAtom[]]));
  for (const bond of molecule.bonds) {
    const from = atoms.get(bond.fromAtomId);
    const to = atoms.get(bond.toAtomId);
    if (from && to) {
      neighbors.get(from.id)!.push(to);
      neighbors.get(to.id)!.push(from);
    }
  }

  const signature: Array<[string, number[]]> = [];
  const centers = new Set<string>();
  for (const bond of stereoBonds) {
    const from = atoms.get(bond.fromAtomId);
    const to = atoms.get(bond.toAtomId);
    if (!from || !to) continue;

    if (bond.order === "double" && bond.stereo !== "either") {
      const left = neighbors.get(from.id)!.filter(atom => atom.id !== to.id);
      const right = neighbors.get(to.id)!.filter(atom => atom.id !== from.id);
      if (left.length && right.length) {
        const sides = [...left, ...right].map(atom => orientation(from, to, atom));
        // Relative sides encode E/Z; reversing every side together preserves the signature.
        const reference = sides.find(side => side !== 0) ?? 1;
        signature.push([bond.id, sides.map(side => side * reference)]);
      }
    }

    const style = bond.display?.bondStyle;
    if ((style === "wedge" || style === "hashed") && !centers.has(from.id)) {
      centers.add(from.id); // The molfile puts the narrow (stereocentre) end first.
      const ligands = neighbors.get(from.id)!;
      if (ligands.length < 3 || ligands.length > 4) continue;
      const points = [from, ...ligands];
      const signs: number[] = [];
      // Include triangles through the centre (implicit H) and through three ligands (four
      // explicit substituents). Their handedness can change with fixed wedge/hash flags.
      // At most five points keeps this bounded even for malformed, high-degree graphs.
      for (let i = 0; i < points.length - 2; i++) {
        for (let j = i + 1; j < points.length - 1; j++) {
          for (let k = j + 1; k < points.length; k++) {
            signs.push(orientation(points[i]!, points[j]!, points[k]!));
          }
        }
      }
      signature.push([from.id, signs]);
    }
  }
  return signature;
}

/**
 * A rigid-motion-invariant key for the live graph that supplies the plugin's structure, including edits
 * the stored structure may not reflect (for example, isotopes). Moving a molecule must not stale a report,
 * while changes to its chemistry, atoms, bonds, superatoms, or R-groups must.
 */
function moleculeGraphKey(molecule: MoleculeObject): string {
  return JSON.stringify({
    chemistry: molecule.chemistry,
    atoms: molecule.atoms.map(({ x: _x, y: _y, z: _z, labelOffset: _labelOffset, ...atom }) => atom),
    bonds: molecule.bonds,
    stereoGeometry: moleculeStereoGeometry(molecule),
    superatoms: molecule.superatoms,
    rGroups: molecule.rGroups
  });
}

// Engine documents own immutable objects: applyPatches shares untouched molecules and replaces
// edited ones through updateObject/mergeObjectChanges; adoptDerivedDocument validates replacements.
// MainWindow admits initial/opened documents through toEngineDocument/admitParsedDocument. Cache
// only that ownership contract, since callers can still mutate non-engine documents in place.
// Weak keys also let discarded molecules and their graph-sized hash inputs be collected.
const sourceFingerprints = new WeakMap<MoleculeObject, {
  documentId: string;
  pageId: string;
  fingerprint: string;
}>();

/** Keep selection snapshots and open-panel staleness checks on precisely the same source key. */
function moleculeSourceFingerprint(
  document: ChemDraftDocument,
  pageId: string,
  molecule: MoleculeObject
): string {
  const cacheable = isEngineDocument(document);
  const cached = cacheable ? sourceFingerprints.get(molecule) : undefined;
  if (cached?.documentId === document.id && cached.pageId === pageId) {
    return cached.fingerprint;
  }
  const fingerprint = createStructureSourceFingerprint({
    documentId: document.id,
    pageId,
    objectId: molecule.id,
    structureFormat: molecule.structureFormat,
    // Match pluginFacingStructure's live-graph preference: stored text can miss isotope, charge,
    // radical and label-side edits. Keep the stored-text key only when there is no live graph.
    structure: molecule.atoms?.length > 0 || molecule.structure === "" ? moleculeGraphKey(molecule) : molecule.structure
  });
  if (cacheable) {
    sourceFingerprints.set(molecule, { documentId: document.id, pageId, fingerprint });
  }
  return fingerprint;
}

/**
 * Build a selection snapshot from the active document: for each selected molecule, its object /
 * page / document identity, structure, and a source fingerprint for staleness detection. Molecules
 * follow the document's selection order. Pure and testable — no React, no refs. The host deep-copies
 * and freezes whatever this returns before handing it to a plugin.
 *
 * This stays a thin read over current document state. That kept plugin code untouched when the
 * selection-policy refactor landed (docs/shipped/selection-policy-refactor.md); keep it thin.
 */
export function buildPluginSelectionSnapshot(document: ChemDraftDocument, warnings: string[] = []): PluginSelectionSnapshot {
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
    const facing = pluginFacingStructure(hit.molecule, warnings);
    molecules.push({
      objectId,
      documentId: document.id,
      pageId: hit.pageId,
      structureFormat: facing.structureFormat,
      structure: facing.structure,
      // Retain stereo geometry while keeping pure translations and rotations out of the key.
      sourceFingerprint: moleculeSourceFingerprint(document, hit.pageId, hit.molecule)
    });
  }

  return { objectIds: document.selection.objectIds, molecules };
}

/**
 * Read the source fingerprint for a specific molecule in the current document (independent of
 * selection), for staleness detection (D-09): a panel report carries the fingerprint it was computed
 * against; if this no longer matches — or the object is gone — the report is stale. Returns undefined
 * when the object no longer exists or is not a molecule.
 */
export function computeObjectFingerprint(document: ChemDraftDocument, objectId: string): string | undefined {
  for (const page of document.pages) {
    for (const object of page.objects) {
      if (object.type === "molecule" && object.id === objectId) {
        return moleculeSourceFingerprint(document, page.id, object);
      }
    }
  }
  return undefined;
}
