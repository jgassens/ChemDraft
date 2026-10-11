import type { ChemDraftDocument, MoleculeAtom, MoleculeBond, MoleculeObject } from "@chemdraft/chem-core";
import {
  nativeSingleBondGraphMetadata,
  normalizeNativeMoleculeGeometry,
  tryNativeSingleBondGraphSmiles
} from "@chemdraft/document-workflow-core";

export type AtomLabelDraftState = {
  objectId: string;
  atomId: string;
  /** The inline draft starts after the first hover key's immediate commit, if any. */
  draftBeforeAtom: MoleculeAtom;
  draftBeforeMolecule: MoleculeObject;
  draftRollback: AtomLabelDraftRollback;
};

/** Edit-owned bookkeeping shared by successive React states, never by document snapshots. */
export type AtomLabelDraftRollback = {
  preview: MoleculeObject;
  changedAtomIds: Set<string>;
  clearedAtomIds: Set<string>;
};

export function createAtomLabelDraftRollback(molecule: MoleculeObject): AtomLabelDraftRollback {
  return { preview: molecule, changedAtomIds: new Set(), clearedAtomIds: new Set() };
}

function atomData(molecule: MoleculeObject): Map<string, string> {
  const incidentBonds = new Map<string, MoleculeBond[]>();
  for (const bond of molecule.bonds) {
    for (const id of new Set([bond.fromAtomId, bond.toAtomId])) {
      const bonds = incidentBonds.get(id) ?? [];
      bonds.push(bond);
      incidentBonds.set(id, bonds);
    }
  }
  // Per-atom style changes count as edits too, even though the atom record stays the same.
  const styleMaps = Object.entries(molecule.style).filter(([, value]) =>
    value && typeof value === "object" && !Array.isArray(value)
  ) as Array<[string, Record<string, unknown>]>;
  return new Map(molecule.atoms.map(atom => [atom.id, JSON.stringify([
    atom, incidentBonds.get(atom.id) ?? [],
    styleMaps.filter(([, map]) => Object.hasOwn(map, atom.id)).map(([key, map]) => [key, map[atom.id]])
  ])]));
}

/** Record only side effects of the draft patch; later keys must not adopt external edits as ours. */
export function recordAtomLabelDraftRollback(
  state: AtomLabelDraftState,
  current: MoleculeObject,
  preview: MoleculeObject
): void {
  const rollback = state.draftRollback;
  const currentData = atomData(current);
  const previousData = atomData(rollback.preview);
  const previewData = atomData(preview);
  for (const atom of state.draftBeforeMolecule.atoms) {
    if (atom.id === state.atomId) continue;
    if (currentData.get(atom.id) !== previousData.get(atom.id)) {
      rollback.changedAtomIds.add(atom.id);
    }
    if (currentData.get(atom.id) !== previewData.get(atom.id)) {
      rollback.clearedAtomIds.add(atom.id);
    }
  }
  rollback.preview = preview;
}

function moleculeDraftPayload(molecule: MoleculeObject): string {
  return JSON.stringify({ ...molecule, structure: undefined, structureFormat: undefined,
    chemistry: undefined, x: undefined, y: undefined, width: undefined, height: undefined });
}

/** Fields written by nativeAtomWithElement and relabel's import-H cleanup. Charge is unchanged. */
function restoreAtomLabelFields(atom: MoleculeAtom, before: MoleculeAtom): MoleculeAtom {
  const restored = { ...atom };
  for (const key of ["element", "labelVisible", "labelLiteral", "warningSuppressed", "hydrogenCount"] as const) {
    if (Object.hasOwn(before, key)) Object.assign(restored, { [key]: before[key] });
    else delete restored[key];
  }
  // Keep the original record (including optional-field ordering) for an exact untouched rollback.
  const keys = Object.keys(restored) as Array<keyof MoleculeAtom>;
  return keys.length === Object.keys(before).length &&
    keys.every(key => Object.hasOwn(before, key) && JSON.stringify(restored[key]) === JSON.stringify(before[key]))
    ? before : restored;
}

/** Roll back preview data directly: a chemistry patch would clear imported H hints again. */
export function restoreAtomLabelDraft(document: ChemDraftDocument, state: AtomLabelDraftState): ChemDraftDocument {
  const pages = document.pages.map(page => ({
    ...page,
    objects: page.objects.map(object => {
      if (object.id !== state.objectId || object.type !== "molecule" || !object.atoms.some(a => a.id === state.atomId)) return object;
      const before = state.draftBeforeMolecule;
      const beforeAtoms = new Map(before.atoms.map(atom => [atom.id, atom]));
      const rollback = state.draftRollback;
      const currentData = atomData(object);
      const previewData = atomData(rollback.preview);
      const atoms = object.atoms.map(atom => {
        if (atom.id === state.atomId) return restoreAtomLabelFields(atom, state.draftBeforeAtom);
        // Relabel patches can drop orphaned import hints on other atoms. Restore those atoms only
        // if neither an external atom/style edit nor an incident-bond edit superseded the preview.
        return rollback.clearedAtomIds.has(atom.id) && !rollback.changedAtomIds.has(atom.id) &&
          currentData.get(atom.id) === previewData.get(atom.id)
          ? beforeAtoms.get(atom.id) ?? atom : atom;
      });
      const restored = { ...object, atoms };
      // An exact rollback keeps the original imported serialization and metadata, including fields
      // the native writer cannot reproduce. Any surviving change to this molecule needs fresh data.
      if (moleculeDraftPayload(restored) === moleculeDraftPayload(before)) return before;
      const storedSmiles = tryNativeSingleBondGraphSmiles(atoms, object.bonds);
      const refreshed = normalizeNativeMoleculeGeometry({
        ...restored,
        structureFormat: "smiles",
        structure: "smiles" in storedSmiles ? storedSmiles.smiles : "",
        chemistry: nativeSingleBondGraphMetadata(atoms, object.bonds)
      });
      return JSON.stringify(refreshed) === JSON.stringify(object) ? object : refreshed;
    })
  }));
  return pages.every((page, i) => page.objects.every((object, j) => object === document.pages[i]!.objects[j]))
    ? document : { ...document, pages };
}
