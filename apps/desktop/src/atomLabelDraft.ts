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
  /** Further typing after an external label starts a draft from that accepted label. */
  supersededBefore?: { molecule: MoleculeObject; atom: MoleculeAtom };
  changedAtomIds: Set<string>;
  clearedAtomIds: Set<string>;
};

export function createAtomLabelDraftRollback(molecule: MoleculeObject): AtomLabelDraftRollback {
  return { preview: molecule, changedAtomIds: new Set(), clearedAtomIds: new Set() };
}

const atomLabelFields = new Set<string>([
  "element", "isotope", "labelVisible", "labelLiteral", "labelBondSide", "warningSuppressed", "hydrogenCount"
]);

function sameOwnFields(first: object, second: object, except: ReadonlySet<string> = new Set()): boolean {
  const keys = Object.keys(first).filter(key => !except.has(key));
  return keys.length === Object.keys(second).filter(key => !except.has(key)).length &&
    keys.every(key => Object.hasOwn(second, key) &&
      Object.is((first as Record<string, unknown>)[key], (second as Record<string, unknown>)[key]));
}

function sameAtomLabelFields(atom: MoleculeAtom | undefined, preview: MoleculeAtom | undefined): boolean {
  return !!atom && !!preview && [...atomLabelFields].every(key => {
    if (Object.hasOwn(atom, key) !== Object.hasOwn(preview, key)) return false;
    if (key === "labelBondSide") {
      return atom.labelBondSide === preview.labelBondSide ||
        (!!atom.labelBondSide && !!preview.labelBondSide && sameOwnFields(atom.labelBondSide, preview.labelBondSide));
    }
    return Object.is(atom[key as keyof MoleculeAtom], preview[key as keyof MoleculeAtom]);
  });
}

/** A superseded label belongs to its external writer, including explicit optional-field clears. */
export function documentOwnsAtomLabelDraft(document: ChemDraftDocument, state: AtomLabelDraftState): boolean {
  const molecule = document.pages.flatMap(page => page.objects).find(object => object.id === state.objectId);
  const atom = molecule?.type === "molecule" ? molecule.atoms.find(atom => atom.id === state.atomId) : undefined;
  return sameAtomLabelFields(atom, state.draftRollback.preview.atoms.find(atom => atom.id === state.atomId));
}

/**
 * Compare immutable snapshots in O(objects + atoms/bonds in the edited molecule). Large payloads
 * on other objects are never visited. Shell key order is irrelevant; absent and undefined differ.
 * Selection is compared to the editor's own snapshot, so an external selection also intervenes.
 */
export function atomLabelDraftDocumentUnchanged(
  current: ChemDraftDocument,
  preview: ChemDraftDocument,
  target: Pick<AtomLabelDraftState, "objectId" | "atomId">
): boolean {
  if (current === preview) return true;
  if (!sameOwnFields(current, preview, new Set(["pages", "selection"])) ||
    !sameOwnFields(current.selection, preview.selection, new Set(["objectIds"])) ||
    current.selection.objectIds.length !== preview.selection.objectIds.length ||
    !current.selection.objectIds.every((id, index) => id === preview.selection.objectIds[index]) ||
    current.pages.length !== preview.pages.length) return false;
  return current.pages.every((page, pageIndex) => {
    const beforePage = preview.pages[pageIndex]!;
    if (page === beforePage) return true;
    // Only the edited molecule's page may have a new shell from the draft.
    if (!beforePage.objects.some(object => object.id === target.objectId) ||
      !sameOwnFields(page, beforePage, new Set(["objects"])) ||
      page.objects.length !== beforePage.objects.length) return false;
    return page.objects.every((object, objectIndex) => {
      const before = beforePage.objects[objectIndex]!;
      if (object === before) return true;
      if (object.id !== target.objectId || before.id !== target.objectId ||
        object.type !== "molecule" || before.type !== "molecule" ||
        !sameOwnFields(object, before, new Set(["atoms", "bonds"])) ||
        object.atoms.length !== before.atoms.length || object.bonds.length !== before.bonds.length) return false;
      return object.bonds.every((bond, index) => bond === before.bonds[index]) &&
        object.atoms.every((atom, index) => {
          const beforeAtom = before.atoms[index]!;
          return atom === beforeAtom || (atom.id === target.atomId && beforeAtom.id === target.atomId &&
            sameOwnFields(atom, beforeAtom, atomLabelFields));
        });
    });
  });
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
  const atom = current.atoms.find(atom => atom.id === state.atomId);
  if (atom && !sameAtomLabelFields(atom, rollback.preview.atoms.find(atom => atom.id === state.atomId))) {
    rollback.supersededBefore = { molecule: current, atom };
    rollback.changedAtomIds.clear();
    rollback.clearedAtomIds.clear();
  }
  const currentData = atomData(current);
  const previousData = atomData(rollback.preview);
  const previewData = atomData(preview);
  for (const atom of (rollback.supersededBefore?.molecule ?? state.draftBeforeMolecule).atoms) {
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
  const fields = [
    "element", "isotope", "labelVisible", "labelLiteral", "labelBondSide", "warningSuppressed", "hydrogenCount"
  ] as const;
  for (const key of fields) {
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
  if (!documentOwnsAtomLabelDraft(document, state)) return document;
  const pages = document.pages.map(page => ({
    ...page,
    objects: page.objects.map(object => {
      if (object.id !== state.objectId || object.type !== "molecule" || !object.atoms.some(a => a.id === state.atomId)) return object;
      const rollback = state.draftRollback;
      const before = rollback.supersededBefore?.molecule ?? state.draftBeforeMolecule;
      const beforeAtoms = new Map(before.atoms.map(atom => [atom.id, atom]));
      const currentData = atomData(object);
      const previewData = atomData(rollback.preview);
      const atoms = object.atoms.map(atom => {
        if (atom.id === state.atomId) return restoreAtomLabelFields(atom, rollback.supersededBefore?.atom ?? state.draftBeforeAtom);
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
