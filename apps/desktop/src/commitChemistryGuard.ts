import type { ChemDraftDocument, DocumentPage, ElectronMarkObject, MoleculeAtom, MoleculeObject } from "@chemdraft/chem-core";
import { electronMarkAtomContribution } from "@chemdraft/document-workflow-core";

/**
 * The commit-time chemistry guard (AGENTS.md section 7: an operation that is not a chemistry edit
 * never changes chemistry). Earlier fixes guarded Duplicate and paste one path at a time, and each
 * review found another path (a paste placed after its own check, a move, a style change) where
 * commit normalization re-attributed a loose charge mark to a different molecule. So the check
 * runs once, in MainWindow's commit funnel, on the FINAL document: after placement and after
 * normalization. Every commit is checked unless its caller declares it a chemistry edit.
 *
 * Pure: the funnel injects commit normalization and the mark-to-atom resolver, so this module
 * never imports `documentWorkflow` (which imports this module's comparison for Duplicate).
 */

/** What the guard compares per atom: the stored charge and what charge and radical marks resolve to. */
export interface AtomChemistry {
  formalCharge: number;
  markCharge: number;
  markRadicals: number;
}

/** One atom of `expected` that is missing from, or has different chemistry in, `actual`. */
export interface AtomChemistryChange {
  atomId: string;
  before: AtomChemistry;
  /** Absent when the atom is gone. */
  after?: AtomChemistry;
}

/** A change to a molecule that existed before the operation (on page `pageId` before it). */
export interface MoleculeChemistryChange {
  pageId: string;
  moleculeId: string;
  /** Absent when the whole molecule is gone. */
  atomId?: string;
  before?: AtomChemistry;
  /** Absent when the atom, or its molecule, is gone. */
  after?: AtomChemistry;
}

/**
 * How the commit funnel treats one commit. `preserve` (the default) refuses the commit when a
 * molecule that existed before it would change; `operation` names it in the refusal ("Cannot
 * <operation> without changing…"). `transform` marks a selection transform whose mark associations
 * `resolveElectronMarksInSelectionTransform` (or a drop) has already decided and announced: the
 * atoms of the selected molecules it moved may change, nothing else may. `exempt` is declared by a
 * caller whose commit is meant to change chemistry, or that is verified elsewhere; `reason` says which.
 */
export type CommitChemistryPolicy =
  | { readonly kind: "preserve"; readonly operation?: string; readonly transform?: boolean }
  | { readonly kind: "exempt"; readonly reason: "chemistry edit" | "text edit" | "plugin write" };

export const PRESERVE_CHEMISTRY: CommitChemistryPolicy = { kind: "preserve" };
/** Drawing, deleting, charge and label edits, mark drops and drags, atom drags, Ketcher edits. */
export const CHEMISTRY_EDIT: CommitChemistryPolicy = { kind: "exempt", reason: "chemistry edit" };
/** Typing in a text object: the session's content was already the present while it was typed. */
export const TEXT_EDIT: CommitChemistryPolicy = { kind: "exempt", reason: "text edit" };
/** Plugin and assistant writes: `document.write` is declared and the host verifies them itself. */
export const PLUGIN_WRITE: CommitChemistryPolicy = { kind: "exempt", reason: "plugin write" };

export function preserveChemistry(operation?: string): CommitChemistryPolicy {
  return operation === undefined ? PRESERVE_CHEMISTRY : { kind: "preserve", operation };
}

/** A selection transform (align, rotate, nudge, a drag…): see `CommitChemistryPolicy`. */
export function selectionTransformChemistry(operation?: string): CommitChemistryPolicy {
  return { kind: "preserve", operation, transform: true };
}

/** Object ids are unique only within a page, so an atom is keyed by its page as well. */
export const atomChemistryKey = (pageId: string, moleculeId: string, atomId: string) => `${pageId}\n${moleculeId}\n${atomId}`;

export function atomChemistry(atom: MoleculeAtom): AtomChemistry {
  return { formalCharge: atom.formalCharge, markCharge: atom.markCharge ?? 0, markRadicals: atom.markRadicals ?? 0 };
}

function sameAtomChemistry(a: MoleculeAtom, b: MoleculeAtom): boolean {
  return a.formalCharge === b.formalCharge && (a.markCharge ?? 0) === (b.markCharge ?? 0) &&
    (a.markRadicals ?? 0) === (b.markRadicals ?? 0);
}

/**
 * THE comparison: every atom of `expected` against the atom with the same id in `actual`. Used for
 * a molecule before and after an operation, and by Duplicate for an original and its copy (copies
 * keep their atom ids). Atoms only `actual` has are not reported. Empty when nothing changed.
 */
export function moleculeAtomChemistryChanges(expected: MoleculeObject, actual: MoleculeObject): AtomChemistryChange[] {
  if (expected === actual || expected.atoms === actual.atoms) return [];
  const actualAtoms = new Map(actual.atoms.map((atom) => [atom.id, atom]));
  const changes: AtomChemistryChange[] = [];
  for (const atom of expected.atoms) {
    const found = actualAtoms.get(atom.id);
    if (found === atom || (found && sameAtomChemistry(atom, found))) continue;
    changes.push(found
      ? { atomId: atom.id, before: atomChemistry(atom), after: atomChemistry(found) }
      : { atomId: atom.id, before: atomChemistry(atom) });
  }
  return changes;
}

export interface PreexistingChemistryOptions {
  /** Only molecules on this page of `before`; every page when absent. */
  pageId?: string;
  /** Molecules the caller compares itself. */
  skipMoleculeIds?: ReadonlySet<string>;
  /** Atoms (`atomChemistryKey`) whose change the operation itself explains; never reported. */
  exemptAtomKeys?: ReadonlySet<string>;
}

const moleculesById = (page: DocumentPage | undefined) => new Map((page?.objects ?? [])
  .flatMap((object) => object.type === "molecule" ? [[object.id, object] as const] : []));

/**
 * Every molecule in `before` against the molecule with the same id in `after`: changed atoms,
 * removed atoms, and molecules that are gone. Object ids are unique only within a page, so a
 * molecule is matched on its own page, and on another page only when that page set holds the id
 * once (it moved pages). Molecules only `after` has (pasted, duplicated, drawn) are ignored.
 * Compare committed (normalized) documents: that is the chemistry the user sees.
 */
export function preexistingMoleculeChemistryChanges(
  before: ChemDraftDocument,
  after: ChemDraftDocument,
  options: PreexistingChemistryOptions = {}
): MoleculeChemistryChange[] {
  if (before === after || before.pages === after.pages) return [];
  const afterPages = new Map(after.pages.map((page) => [page.id, page]));
  let elsewhere: Map<string, MoleculeObject | undefined> | undefined;
  const movedPages = (id: string) => {
    if (!elsewhere) {
      elsewhere = new Map();
      for (const page of after.pages) {
        for (const object of page.objects) {
          if (object.type !== "molecule") continue;
          // An id held by more than one page names no single molecule.
          elsewhere.set(object.id, elsewhere.has(object.id) ? undefined : object);
        }
      }
    }
    return elsewhere.get(id);
  };
  const changes: MoleculeChemistryChange[] = [];
  for (const page of before.pages) {
    if (options.pageId !== undefined && page.id !== options.pageId) continue;
    const afterPage = afterPages.get(page.id);
    if (afterPage?.objects === page.objects) continue;
    const samePage = moleculesById(afterPage);
    for (const molecule of page.objects) {
      if (molecule.type !== "molecule" || options.skipMoleculeIds?.has(molecule.id)) continue;
      const found = samePage.get(molecule.id) ?? movedPages(molecule.id);
      if (found === molecule) continue;
      if (!found) {
        changes.push({ pageId: page.id, moleculeId: molecule.id });
        continue;
      }
      for (const change of moleculeAtomChemistryChanges(molecule, found)) {
        if (options.exemptAtomKeys?.has(atomChemistryKey(page.id, molecule.id, change.atomId))) continue;
        changes.push({ pageId: page.id, moleculeId: molecule.id, ...change });
      }
    }
  }
  return changes;
}

/** "Cannot <operation> without changing the chemistry of molecule "m": its atom "a" would …". */
export function describeMoleculeChemistryChange(change: MoleculeChemistryChange, operation = "complete this edit"): string {
  const prefix = `Cannot ${operation} without changing the chemistry of molecule "${change.moleculeId}": `;
  if (change.atomId === undefined) return `${prefix}it would be removed.`;
  const { before, after } = change;
  if (!after || !before) return `${prefix}its atom "${change.atomId}" would be removed.`;
  if (after.formalCharge === before.formalCharge && after.markRadicals === before.markRadicals) {
    return `${prefix}its atom "${change.atomId}" would take ${after.markCharge} of its charge ${after.formalCharge} ` +
      `from charge marks instead of ${before.markCharge}.`;
  }
  return `${prefix}its atom "${change.atomId}" would have charge ${after.formalCharge} and ${after.markRadicals} ` +
    `radical marks instead of ${before.formalCharge} and ${before.markRadicals}.`;
}

/** One status line for a refused commit: the first change, and how many more there are. */
export function chemistryRefusalStatus(messages: readonly string[]): string {
  if (messages.length <= 1) return messages[0] ?? "";
  return `${messages[0]} (and ${messages.length - 1} more)`;
}

/** The atom a charge or radical mark is attributed to on its page (commit's own resolver). */
export type MarkAtomResolver = (page: DocumentPage, mark: ElectronMarkObject) => readonly { objectId: string; atomId: string }[];

export interface CommitChemistryCheck {
  /** The committed document the operation started from. */
  before: ChemDraftDocument;
  /** The operation's own result, before commit normalization: decides which marks it moved. */
  next: ChemDraftDocument;
  /** The normalized document about to be committed: placement and normalization are done. */
  after: ChemDraftDocument;
  /**
   * Commit normalization (idempotent). The operation is judged against what a commit of the
   * UNCHANGED document would hold, `normalize(before)`, not against `before` itself: a file opened
   * with its stored marks preserved can differ from that, and the first commit of any kind settles
   * the difference. That settling is not the operation's doing, so it is never blamed on it, while a
   * change the operation causes is caught even where the stored value happened to match it.
   */
  normalize: (document: ChemDraftDocument) => ChemDraftDocument;
  /** Resolves which atoms a mark's chemistry goes to; see `movedSelectedMarkAtomKeys`. */
  markAtoms: MarkAtomResolver;
  operation?: string;
  /** A selection transform: the selected molecules it moved may change (`movedSelectedMoleculeAtomKeys`). */
  transform?: boolean;
}

/**
 * The commit-time check. Empty when no molecule that existed before the operation changes;
 * otherwise one message per changed atom (or removed molecule), naming both.
 *
 * Some changes are the operation's own, and only charge or radical changes on atoms that remain
 * (a removed atom or molecule is never exempt):
 * - a charge or radical mark the user selected and the operation moved or explicitly re-anchored:
 *   its old and new atoms (align, distribute, arrange, nudge, rotate or resize of a selection that
 *   includes the mark, which decide and announce the mark's new atom);
 * - for a selection transform (`transform`), the atoms of the selected molecules it moved: moving
 *   a molecule away from its own stationary mark is announced by the transform as well.
 * Molecules the operation did not select and move are never exempt: the legacy loose "+" that
 * normalization would hand from B to a molecule placed beside it is refused.
 */
export function commitChemistryRefusals(check: CommitChemistryCheck): string[] {
  if (check.before === check.after) return [];
  const baseline = check.normalize(check.before);
  const changes = preexistingMoleculeChemistryChanges(baseline, check.after);
  if (changes.length === 0) return [];
  const exempt = movedSelectedMarkAtomKeys(check.before, check.next, [baseline, check.after], check.markAtoms);
  if (check.transform) for (const key of movedSelectedMoleculeAtomKeys(check.before, check.next)) exempt.add(key);
  return changes
    .filter((change) => change.atomId === undefined || !change.after ||
      !exempt.has(atomChemistryKey(change.pageId, change.moleculeId, change.atomId)))
    .map((change) => describeMoleculeChemistryChange(change, check.operation));
}

/**
 * The selection's page and its ids plus every member of a selected group, nested groups included.
 * A selection belongs to one page (its `pageId`, else the first page).
 */
function selectedTargets(document: ChemDraftDocument): { pageId: string | undefined; ids: Set<string> } {
  const pageId = document.selection.pageId ?? document.pages[0]?.id;
  const page = document.pages.find((candidate) => candidate.id === pageId);
  const ids = new Set<string>(document.selection.objectIds);
  const members = new Map<string, readonly string[]>();
  for (const object of page?.objects ?? []) if (object.type === "group") members.set(object.id, object.childObjectIds);
  const pending: string[] = [...ids];
  while (pending.length > 0) {
    for (const child of members.get(pending.pop()!) ?? []) {
      if (!ids.has(child)) { ids.add(child); pending.push(child); }
    }
  }
  return { pageId, ids };
}

/**
 * The atoms of every selected molecule (group members included) whose placement or atom positions
 * differ between `before` and `next`: the molecules a selection transform itself moved.
 */
export function movedSelectedMoleculeAtomKeys(before: ChemDraftDocument, next: ChemDraftDocument): Set<string> {
  const keys = new Set<string>();
  const { pageId, ids } = selectedTargets(before);
  const page = before.pages.find((candidate) => candidate.id === pageId);
  if (!page || ids.size === 0) return keys;
  const nextMolecules = moleculesById(next.pages.find((candidate) => candidate.id === pageId));
  for (const molecule of page.objects) {
    if (molecule.type !== "molecule" || !ids.has(molecule.id)) continue;
    const moved = nextMolecules.get(molecule.id);
    if (!moved || moved === molecule) continue;
    const atomsAfter = new Map(moved.atoms.map((atom) => [atom.id, atom]));
    const placementChanged = moved.x !== molecule.x || moved.y !== molecule.y || moved.width !== molecule.width ||
      moved.height !== molecule.height || moved.rotation !== molecule.rotation ||
      molecule.atoms.some((atom) => { const after = atomsAfter.get(atom.id); return !after || after.x !== atom.x || after.y !== atom.y; });
    if (placementChanged) for (const atom of molecule.atoms) keys.add(atomChemistryKey(page.id, molecule.id, atom.id));
  }
  return keys;
}

/**
 * Atoms whose change a selected, moved charge or radical mark explains: the atoms the mark is
 * attributed to in each of `documents`, on the selection's page. A mark counts as moved when the
 * operation changed its position or size, or gave it an explicit anchor it did not have
 * (normalization never moves a mark and never makes an anchor explicit, so a mark it merely
 * re-attributed does not count).
 */
export function movedSelectedMarkAtomKeys(
  before: ChemDraftDocument,
  next: ChemDraftDocument,
  documents: readonly ChemDraftDocument[],
  markAtoms: MarkAtomResolver
): Set<string> {
  const keys = new Set<string>();
  const { pageId, ids } = selectedTargets(before);
  const page = before.pages.find((candidate) => candidate.id === pageId);
  if (!page || ids.size === 0) return keys;
  const nextMarks = new Map((next.pages.find((candidate) => candidate.id === pageId)?.objects ?? [])
    .flatMap((object) => object.type === "electron-mark" ? [[object.id, object] as const] : []));
  const moved = new Set<string>();
  for (const mark of page.objects) {
    if (mark.type !== "electron-mark" || !ids.has(mark.id)) continue;
    const { charge, radicals } = electronMarkAtomContribution(mark);
    if (charge === 0 && radicals === 0) continue;
    const after = nextMarks.get(mark.id);
    if (!after) continue;
    const repositioned = after.x !== mark.x || after.y !== mark.y || after.width !== mark.width || after.height !== mark.height;
    const reanchored = after.atomAssociation === "explicit" &&
      (mark.atomAssociation !== "explicit" || JSON.stringify(after.anchor) !== JSON.stringify(mark.anchor));
    if (repositioned || reanchored) moved.add(mark.id);
  }
  if (moved.size === 0) return keys;
  for (const document of documents) {
    const documentPage = document.pages.find((candidate) => candidate.id === pageId);
    for (const mark of documentPage?.objects ?? []) {
      if (mark.type !== "electron-mark" || !moved.has(mark.id)) continue;
      for (const owner of markAtoms(documentPage!, mark)) keys.add(atomChemistryKey(pageId!, owner.objectId, owner.atomId));
    }
  }
  return keys;
}
