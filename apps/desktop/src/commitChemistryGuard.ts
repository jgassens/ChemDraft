import type { ChemDraftDocument, DocumentPage, ElectronMarkObject, MoleculeAtom, MoleculeBond, MoleculeObject } from "@chemdraft/chem-core";
import { electronMarkAtomContribution, stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { loadStereoEngine, type StereoEngine } from "./stereoReadout";

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
  /**
   * Set for every change other than an atom's charge or radical marks (`moleculeInvariantChanges`):
   * what changed, as the end of a refusal sentence ("its atom "a2" would be O instead of N").
   * Such a change is never explained by a mark the operation moved by itself.
   */
  detail?: string;
  /**
   * Set when the molecule's stereochemistry had to be read back but the stereo engine is not
   * available (still loading, or failed to load): the refusal says the check could not run yet,
   * not that the chemistry would change (`describeMoleculeChemistryChange`).
   */
  stereoUnchecked?: StereoEngineUnavailable;
  /**
   * Set when the engine is loaded but the stereo read-back could not run on this molecule (the
   * perception molfile could not be written, a perceiver threw or answered for the wrong atoms, or
   * the engine cannot read atropisomer axes): why, as the end of "cannot be checked because …".
   * The commit is refused (fail closed), never passed with its stereo unchecked.
   */
  stereoUnreadable?: string;
}

/**
 * How the commit funnel treats one commit. `preserve` (the default) refuses the commit when a
 * molecule that existed before it would change; `operation` names it in the refusal ("Cannot
 * <operation> without changing…"). Moves and selection transforms preserve: owner ruling 2026-11-21
 * (charge always follows) carries every mark with its atom, so a move never changes chemistry and
 * this guard is the check that it did not. `exempt` is declared by a caller whose commit is meant to
 * change chemistry, or that is verified elsewhere; `reason` says which.
 */
export type CommitChemistryPolicy =
  | {
    readonly kind: "preserve";
    readonly operation?: string;
    /**
     * A SCOPED chemistry edit: the molecules whose atoms or bonds the operation itself added,
     * removed or changed (`structurallyEditedMoleculeKeys`, `before` against the operation's own
     * `next`) may change, and so may the molecules named in `editedMoleculeIds`. Every other
     * molecule that existed before stays guarded. Bond, chain and template placement use it
     * (`structureEditChemistry`): a ring fused onto A legitimately changes A, but a standalone
     * template placed beside B must not take B's legacy loose "+".
     */
    readonly structureEdit?: boolean;
    /** Molecules (by id, each on the first page holding it: `namedMoleculeKeys`) the operation is meant to change: `chemistryEditOf`. */
    readonly editedMoleculeIds?: readonly string[];
    /**
     * Molecules whose atoms the operation rebuilt with ids that do not name the same atoms as
     * before (`structureEditorChemistry`). The commit funnel then does not run the charge-follows
     * rule (`marksFollowAtoms`): it pairs atoms by id, and would carry a mark to, and anchor it on,
     * whichever atom inherited its atom's id.
     */
    readonly rebuiltMoleculeIds?: readonly string[];
    /** See `IndependentMarkMoves`. */
    readonly independentlyMovedMarkIds?: ReadonlySet<string>;
    /** Flip Horizontal / Vertical only (`flipChemistry`): see `CommitChemistryCheck.mirrorIsTheOperation`. */
    readonly mirrorIsTheOperation?: boolean;
  }
  | {
    readonly kind: "exempt";
    readonly reason: "chemistry edit" | "text edit" | "plugin write";
    /** See `IndependentMarkMoves`: an exempt commit is not checked, but the charge-follows rule still reads it. */
    readonly independentlyMovedMarkIds?: ReadonlySet<string>;
  };

/**
 * `independentlyMovedMarkIds`: the electron marks the operation moved BY ITSELF, as the operation
 * that moved them declares them (a mark dragged or dropped, a mark transformed in a selection
 * without its molecule: `electronMarkDrop.ts`). It is the only source of a mark-move exemption:
 * nothing infers from atom motion that a mark moved by itself. The commit guard exempts the old and
 * new atoms of these marks (a mark drop under the mark-move policy) and nothing else; a mark the
 * charge-follows rule carried with its atom is never exempt. The charge-follows rule leaves these
 * marks where the operation put them when their atom stayed put, and puts every other mark of an
 * unmoved atom back exactly as it was. Every other move path passes none.
 */
export type IndependentMarkMoves = ReadonlySet<string>;

export const PRESERVE_CHEMISTRY: CommitChemistryPolicy = { kind: "preserve" };
/**
 * Document-wide exemption: deleting, label edits, mark drops and drags, atom drags, the point-based
 * charge tool (a Ketcher save is scoped: `structureEditorChemistry`). Prefer the scoped `structureEditChemistry` / `chemistryEditOf`
 * wherever the molecules an operation is meant to change are known.
 */
export const CHEMISTRY_EDIT: CommitChemistryPolicy = { kind: "exempt", reason: "chemistry edit" };
/** Typing in a text object: the session's content was already the present while it was typed. */
export const TEXT_EDIT: CommitChemistryPolicy = { kind: "exempt", reason: "text edit" };
/** Plugin and assistant writes: `document.write` is declared and the host verifies them itself. */
export const PLUGIN_WRITE: CommitChemistryPolicy = { kind: "exempt", reason: "plugin write" };

export function preserveChemistry(operation?: string): CommitChemistryPolicy {
  return operation === undefined ? PRESERVE_CHEMISTRY : { kind: "preserve", operation };
}

/**
 * Bond, chain and template placement, standalone or fused: only the molecules whose atoms or bonds
 * the operation added, removed or changed (plus `moleculeIds`) may change chemistry.
 */
export function structureEditChemistry(operation?: string, moleculeIds?: readonly string[]): CommitChemistryPolicy {
  return { kind: "preserve", operation, structureEdit: true, ...(moleculeIds?.length ? { editedMoleculeIds: moleculeIds } : {}) };
}

/** A chemistry edit of the named molecules only (a charge placed on an atom, an atom-problem fix). */
export function chemistryEditOf(moleculeIds: readonly string[], operation?: string): CommitChemistryPolicy {
  return { kind: "preserve", operation, editedMoleculeIds: moleculeIds };
}

/**
 * A structure-editor (Ketcher) save of one molecule: only that molecule may change. The save
 * rebuilds the molecule and reuses its previous atom ids by array index (`parseV3000MoleculeGraph`),
 * so deleting or reordering an earlier atom shifts later atoms onto other atoms' old ids. No id can
 * be trusted to name the same atom, so marks are not carried by the charge-follows rule: they stay
 * where they are and normal mark association applies, inside the edited molecule only.
 */
export function structureEditorChemistry(moleculeId: string): CommitChemistryPolicy {
  return { kind: "preserve", operation: "apply this structure edit", editedMoleculeIds: [moleculeId], rebuiltMoleculeIds: [moleculeId] };
}

/**
 * Whether the commit funnel runs the charge-follows rule (owner ruling 2026-11-21) for a commit
 * under `policy`: always, except for a commit that rebuilt atoms under new ids
 * (`rebuiltMoleculeIds`), where pairing atoms by id would pair different atoms.
 */
export function marksFollowAtoms(policy: CommitChemistryPolicy | undefined): boolean {
  return !(policy?.kind === "preserve" && policy.rebuiltMoleculeIds?.length);
}

/**
 * A move or selection transform (align, rotate, nudge, a drag…). Owner ruling 2026-11-21 (charge
 * always follows): marks move with their atoms, so a move preserves every molecule's chemistry,
 * moved or not, with no exempt atom. Only the marks the transform itself reports it moved without
 * their atom (`independentlyMovedMarkIds`, a mark drop) may change chemistry, under the mark-move
 * policy; a transform that moved none passes none.
 *
 * A selection transform never mirrors a molecule: a drag, align, rotate or resize whose result is a
 * mirror image of a stereo molecule is read back and refused like any other stereo change. Only Flip
 * Horizontal / Vertical mirrors, and says so explicitly (`flipChemistry`).
 */
export function selectionTransformChemistry(operation?: string, independentlyMovedMarkIds?: IndependentMarkMoves): CommitChemistryPolicy {
  return withIndependentlyMovedMarks(preserveChemistry(operation), independentlyMovedMarkIds);
}

/**
 * Flip Horizontal / Vertical: a selection transform (`selectionTransformChemistry`) whose whole
 * point is the mirror image, so an exact affine image of a molecule, mirror included, with its
 * wedges unchanged is not read back for stereo (`mirrorIsTheOperation`). Only the Flip command path
 * passes it; nothing infers it from geometry.
 */
export function flipChemistry(operation?: string, independentlyMovedMarkIds?: IndependentMarkMoves): CommitChemistryPolicy {
  return withIndependentlyMovedMarks({ kind: "preserve", operation, mirrorIsTheOperation: true }, independentlyMovedMarkIds);
}

/** `policy` with the marks the operation moved by itself (`IndependentMarkMoves`); unchanged for none. */
export function withIndependentlyMovedMarks(policy: CommitChemistryPolicy, markIds?: IndependentMarkMoves): CommitChemistryPolicy {
  return markIds === undefined ? policy : { ...policy, independentlyMovedMarkIds: markIds };
}

/**
 * Object ids are unique only within a page, so an atom is keyed by its page as well. The key is a
 * JSON tuple, so no id (one holding a newline or any other delimiter) can alias another triple.
 */
export const atomChemistryKey = (pageId: string, moleculeId: string, atomId: string) => JSON.stringify([pageId, moleculeId, atomId]);

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
  /** See `CommitChemistryCheck.stereoEngine`. */
  stereoEngine?: CommitStereoEngineOption;
  /** See `CommitChemistryCheck.mirrorIsTheOperation`. */
  mirrorIsTheOperation?: boolean;
}

const moleculesById = (page: DocumentPage | undefined) => new Map((page?.objects ?? [])
  .flatMap((object) => object.type === "molecule" ? [[object.id, object] as const] : []));

/**
 * The molecule of `after` that a molecule of `before`, gone from its own page, moved to; matching is
 * one-to-one. A source is a molecule of `before` whose page no longer holds its id in `after`; a
 * destination is a molecule of `after` on a page that did not hold that id in `before` (a molecule
 * already on its page in `before` is that page's own and never stands in for a same-id molecule
 * removed from another page). For each id, every source is paired with at most one destination and
 * every destination with at most one source: first pairs where the destination IS the source, then
 * pairs with the same structure and chemistry, each in document order. Nothing else pairs: a same-id
 * arrival that differs in structure or chemistry cannot be told from an unrelated molecule (drawn or
 * pasted elsewhere) and never masks a deletion. That includes geometry: a move that also translates
 * or rotates the molecule gives, by value, the very document that deleting it and drawing a same-id,
 * same-chemistry molecule elsewhere gives, so it is reported removed (the safe side; a scoped edit
 * naming the molecule still exempts that). A source left unpaired has no match and so is
 * reported removed (pages A and B both held "m"; only page C holds it now: one of them moved, the
 * other is gone); a destination left unpaired is an addition and matches nothing. Built lazily.
 */
function movedPageMatcher(before: ChemDraftDocument, after: ChemDraftDocument): (pageId: string, id: string) => MoleculeObject | undefined {
  let matched: Map<string, MoleculeObject> | undefined;
  return (pageId, id) => {
    if (!matched) {
      const map = new Map<string, MoleculeObject>();
      matched = map;
      const beforePages = new Map(before.pages.map((page) => [page.id, page]));
      const afterPages = new Map(after.pages.map((page) => [page.id, page]));
      const destinations = new Map<string, MoleculeObject[]>();
      for (const page of after.pages) {
        const heldBefore = moleculesById(beforePages.get(page.id));
        for (const object of page.objects) {
          if (object.type !== "molecule" || heldBefore.has(object.id)) continue;
          const list = destinations.get(object.id);
          if (list) list.push(object); else destinations.set(object.id, [object]);
        }
      }
      const sources = new Map<string, { pageId: string; molecule: MoleculeObject }[]>();
      for (const page of before.pages) {
        if (!page.objects.some((object) => object.type === "molecule" && destinations.has(object.id))) continue;
        const heldAfter = moleculesById(afterPages.get(page.id));
        for (const object of page.objects) {
          if (object.type !== "molecule" || heldAfter.has(object.id) || !destinations.has(object.id)) continue;
          const list = sources.get(object.id);
          if (list) list.push({ pageId: page.id, molecule: object }); else sources.set(object.id, [{ pageId: page.id, molecule: object }]);
        }
      }
      const tiers: ((source: MoleculeObject, destination: MoleculeObject) => boolean)[] = [
        (source, destination) => source === destination,
        (source, destination) => sameMoleculeStructure(source, destination) &&
          moleculeAtomChemistryChanges(source, destination).length === 0
      ];
      for (const [moleculeId, candidates] of sources) {
        // By position, not identity: one molecule object can sit on several pages.
        const arrived = destinations.get(moleculeId)!;
        const sourcePaired = candidates.map(() => false);
        const destinationPaired = arrived.map(() => false);
        for (const pairs of tiers) {
          candidates.forEach((source, sourceIndex) => {
            if (sourcePaired[sourceIndex]) return;
            const destinationIndex = arrived.findIndex((destination, index) => !destinationPaired[index] && pairs(source.molecule, destination));
            if (destinationIndex < 0) return;
            map.set(moleculeKey(source.pageId, moleculeId), arrived[destinationIndex]);
            sourcePaired[sourceIndex] = destinationPaired[destinationIndex] = true;
          });
        }
      }
    }
    return matched.get(moleculeKey(pageId, id));
  };
}

/**
 * Every molecule in `before` against the molecule with the same id in `after`: changed atoms,
 * removed atoms, and molecules that are gone. Object ids are unique only within a page, so a
 * molecule is matched on its own page, and on another page only when it moved pages
 * (`movedPageMatcher`, one-to-one): a same-id molecule another page already held never masks its
 * removal, and two removed same-id molecules never both match one arrival.
 * Molecules only `after` has (pasted, duplicated, drawn) are ignored.
 * Compare committed (normalized) documents: that is the chemistry the user sees.
 */
export function preexistingMoleculeChemistryChanges(
  before: ChemDraftDocument,
  after: ChemDraftDocument,
  options: PreexistingChemistryOptions = {}
): MoleculeChemistryChange[] {
  if (before === after || before.pages === after.pages) return [];
  const afterPages = new Map(after.pages.map((page) => [page.id, page]));
  const movedPages = movedPageMatcher(before, after);
  const changes: MoleculeChemistryChange[] = [];
  for (const page of before.pages) {
    if (options.pageId !== undefined && page.id !== options.pageId) continue;
    const afterPage = afterPages.get(page.id);
    if (afterPage?.objects === page.objects) continue;
    const samePage = moleculesById(afterPage);
    for (const molecule of page.objects) {
      if (molecule.type !== "molecule" || options.skipMoleculeIds?.has(molecule.id)) continue;
      const found = samePage.get(molecule.id) ?? movedPages(page.id, molecule.id);
      if (found === molecule) continue;
      if (!found) {
        changes.push({ pageId: page.id, moleculeId: molecule.id });
        continue;
      }
      for (const change of moleculeAtomChemistryChanges(molecule, found)) {
        if (options.exemptAtomKeys?.has(atomChemistryKey(page.id, molecule.id, change.atomId))) continue;
        changes.push({ pageId: page.id, moleculeId: molecule.id, ...change });
      }
      for (const change of moleculeInvariantChanges(molecule, found, options.stereoEngine, options.mirrorIsTheOperation)) {
        if (change.atomId !== undefined && options.exemptAtomKeys?.has(atomChemistryKey(page.id, molecule.id, change.atomId))) continue;
        changes.push({ pageId: page.id, moleculeId: molecule.id, ...change });
      }
    }
  }
  return changes;
}

/** "Cannot <operation> without changing the chemistry of molecule "m": its atom "a" would …". */
export function describeMoleculeChemistryChange(change: MoleculeChemistryChange, operation = "complete this edit"): string {
  const unchecked = change.stereoUnchecked;
  if (unchecked) {
    return unchecked.unavailable === "loading"
      ? `Cannot ${operation} yet: checking the stereochemistry of molecule "${change.moleculeId}" is still starting; try again in a moment.`
      : `Cannot ${operation}: the stereochemistry of molecule "${change.moleculeId}" cannot be checked because the stereo engine ` +
        `failed to load (${unchecked.reason}); try again, and restart ChemDraft if it keeps failing.`;
  }
  if (change.stereoUnreadable !== undefined) {
    return `Cannot ${operation}: the stereochemistry of molecule "${change.moleculeId}" cannot be checked because ${change.stereoUnreadable}.`;
  }
  const prefix = `Cannot ${operation} without changing the chemistry of molecule "${change.moleculeId}": `;
  if (change.detail !== undefined) return `${prefix}${change.detail}.`;
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
  /** Resolves which atoms a mark's chemistry goes to; see `independentlyMovedMarkAtomKeys`. */
  markAtoms: MarkAtomResolver;
  operation?: string;
  /** The marks the operation moved by itself (`IndependentMarkMoves`); none when absent. */
  independentlyMovedMarkIds?: IndependentMarkMoves;
  /** A scoped structure edit: the molecules it structurally edited may change (`structurallyEditedMoleculeKeys`). */
  structureEdit?: boolean;
  /** Molecules (by id, each on the first page holding it: `namedMoleculeKeys`) the operation is meant to change. */
  editedMoleculeIds?: readonly string[];
  /**
   * The stereo read-back engine (`moleculeInvariantChanges`). Absent: the guard's own lazily loaded
   * OpenChemLib perceivers (`loadCommitStereoEngine`, which MainWindow warms at mount). While that
   * engine is still loading, or after it failed to load (`StereoEngineUnavailable`), a commit that
   * needs the read-back is refused with a message saying so (`stereoUnchecked`), never passed
   * unchecked and never judged by guessing from wedges; so is one whose drawing the loaded engine
   * cannot read (`stereoUnreadable`). A molecule with no stereo element (`mayCarryStereo`) and a
   * layout that cannot change stereo (`layoutKeepsStereo`) never need it.
   */
  stereoEngine?: CommitStereoEngineOption;
  /**
   * The operation is Flip Horizontal / Vertical (`flipChemistry`): an exact affine image of a
   * molecule, mirror included, with its wedges unchanged, is then not read back for stereo.
   * Otherwise only an orientation-preserving one (move, align, rotate, scale) skips the read-back.
   */
  mirrorIsTheOperation?: boolean;
}

/**
 * The commit-time check. Empty when no molecule that existed before the operation changes;
 * otherwise one message per changed atom (or removed molecule), naming both.
 *
 * Some changes are the operation's own, and only charge or radical changes on atoms that remain
 * (a removed atom or molecule is never exempt):
 * - a charge or radical mark the operation declares it moved by itself (`independentlyMovedMarkIds`:
 *   a mark drop, or a mark in a selection moved without its molecule) and did move or re-anchor:
 *   its old and new atoms (`independentlyMovedMarkAtomKeys`). No other mark explains anything; a
 *   mark the charge-follows rule carried with its atom never does;
 * - for a scoped chemistry edit (`structureEdit`, `editedMoleculeIds`), every change, removal
 *   included, to the molecules it structurally edited or names.
 * Molecules the operation did not select and move, edit or name are never exempt: the legacy loose
 * "+" that normalization would hand from B to a molecule placed beside it is refused, whether a
 * paste or a standalone template placed it.
 */
export function commitChemistryRefusals(check: CommitChemistryCheck): string[] {
  if (check.before === check.after) return [];
  const baseline = check.normalize(check.before);
  let changes = preexistingMoleculeChemistryChanges(baseline, check.after,
    { stereoEngine: check.stereoEngine, mirrorIsTheOperation: check.mirrorIsTheOperation });
  if (changes.length === 0) return [];
  // A scoped edit: the molecules it edits are the operation's own, removal included (a bond that
  // joins B into A removes B); nothing else is.
  if (check.structureEdit || check.editedMoleculeIds?.length) {
    const edited = check.structureEdit ? structurallyEditedMoleculeKeys(check.before, check.next) : new Set<string>();
    for (const key of namedMoleculeKeys(check.before, check.editedMoleculeIds)) edited.add(key);
    changes = changes.filter((change) => !edited.has(moleculeKey(change.pageId, change.moleculeId)));
    if (changes.length === 0) return [];
  }
  const exempt = independentlyMovedMarkAtomKeys(check.before, check.next, [baseline, check.after],
    check.independentlyMovedMarkIds, check.markAtoms);
  return changes
    .filter((change) => change.detail !== undefined || change.atomId === undefined || !change.after ||
      !exempt.has(atomChemistryKey(change.pageId, change.moleculeId, change.atomId)))
    .map((change) => describeMoleculeChemistryChange(change, check.operation));
}

/** A molecule on a page, as `structurallyEditedMoleculeKeys` keys it: a JSON tuple, so no id can alias another pair. */
export const moleculeKey = (pageId: string, moleculeId: string) => JSON.stringify([pageId, moleculeId]);

/**
 * The molecules a scoped edit names (`editedMoleculeIds`), as `moleculeKey`s. Object ids are unique
 * only within a page, so a bare id names the molecule on the FIRST page of `before` that holds it, as
 * a patch resolves a bare object id (first occurrence wins) and as the callers find their target; a
 * same-id molecule on any later page stays guarded. Changes are reported under the page a molecule
 * was on before, so an edit that also moves its molecule to another page is still keyed, and exempt,
 * under the page it left, removal included.
 */
function namedMoleculeKeys(before: ChemDraftDocument, moleculeIds: readonly string[] | undefined): Set<string> {
  const keys = new Set<string>();
  for (const id of moleculeIds ?? []) {
    const page = before.pages.find((candidate) => candidate.objects.some((object) => object.type === "molecule" && object.id === id));
    if (page) keys.add(moleculeKey(page.id, id));
  }
  return keys;
}

function sameAtomStructure(a: MoleculeAtom, b: MoleculeAtom): boolean {
  return a.element === b.element && a.isotope === b.isotope && a.x === b.x && a.y === b.y;
}

function sameMoleculeStructure(a: MoleculeObject, b: MoleculeObject): boolean {
  if (a === b) return true;
  if (a.atoms.length !== b.atoms.length || a.bonds.length !== b.bonds.length) return false;
  if (a.atoms !== b.atoms) {
    const atoms = new Map(b.atoms.map((atom) => [atom.id, atom]));
    if (a.atoms.some((atom) => { const other = atoms.get(atom.id); return !other || !sameAtomStructure(atom, other); })) return false;
  }
  if (a.bonds !== b.bonds) {
    const bonds = new Map(b.bonds.map((bond) => [bond.id, bond]));
    if (a.bonds.some((bond) => {
      const other = bonds.get(bond.id);
      return !other || other.fromAtomId !== bond.fromAtomId || other.toAtomId !== bond.toAtomId || other.order !== bond.order;
    })) return false;
  }
  return true;
}

/**
 * The molecules of `before` (`moleculeKey`) whose atoms or bonds the operation added, removed or
 * changed in its own result `next`: a different atom or bond set, an atom's element, isotope or
 * position, or a bond's atoms or order. A molecule gone from `next` (deleted, or joined into
 * another) counts as edited. Charge and radical fields are NOT structure: an operation that only
 * changes a molecule's charges did not edit it structurally. Pass the operation's own result, not
 * the normalized one, so commit normalization can never widen the set.
 */
export function structurallyEditedMoleculeKeys(before: ChemDraftDocument, next: ChemDraftDocument): Set<string> {
  const keys = new Set<string>();
  if (before === next || before.pages === next.pages) return keys;
  const nextPages = new Map(next.pages.map((page) => [page.id, page]));
  const onAnyPage = movedPageMatcher(before, next);
  for (const page of before.pages) {
    const nextPage = nextPages.get(page.id);
    if (nextPage?.objects === page.objects) continue;
    const samePage = moleculesById(nextPage);
    for (const molecule of page.objects) {
      if (molecule.type !== "molecule") continue;
      const found = samePage.get(molecule.id) ?? onAnyPage(page.id, molecule.id);
      if (!found || !sameMoleculeStructure(molecule, found)) keys.add(moleculeKey(page.id, molecule.id));
    }
  }
  return keys;
}

/**
 * `commitChemistryRefusals` under a commit policy, as the commit funnel applies it: an exempt
 * policy is not checked; a preserving one passes its operation name (else `operation`) and scope. Empty when the commit may proceed.
 */
export function policyChemistryRefusals(
  policy: CommitChemistryPolicy,
  check: Omit<CommitChemistryCheck, "operation" | "structureEdit" | "editedMoleculeIds" | "independentlyMovedMarkIds" | "mirrorIsTheOperation">,
  operation?: string
): string[] {
  if (policy.kind !== "preserve") return [];
  return commitChemistryRefusals({ ...check, operation: policy.operation ?? operation,
    structureEdit: policy.structureEdit, editedMoleculeIds: policy.editedMoleculeIds,
    independentlyMovedMarkIds: policy.independentlyMovedMarkIds, mirrorIsTheOperation: policy.mirrorIsTheOperation });
}

/**
 * Atoms whose change the operation's own mark moves explain: for every mark it declares it moved
 * by itself (`markIds`) that carries charge or radicals and that it did reposition, resize or give
 * an explicit anchor it did not have, the atoms the mark is attributed to in each of `documents`,
 * on the page where it moved. Normalization never moves a mark and never makes an anchor explicit,
 * so a declared mark that normalization merely re-attributed explains nothing. Nothing is inferred
 * from how atoms moved: a mark not declared, including every mark the charge-follows rule carried
 * with its atom, has no exempt atom, so a pure move (a selection drag, nudge, align, distribute,
 * arrange, spacing, rotate, flip, resize, a part drag) must leave every charge and radical as it was.
 */
export function independentlyMovedMarkAtomKeys(
  before: ChemDraftDocument,
  next: ChemDraftDocument,
  documents: readonly ChemDraftDocument[],
  markIds: IndependentMarkMoves | undefined,
  markAtoms: MarkAtomResolver
): Set<string> {
  const keys = new Set<string>();
  if (!markIds?.size) return keys;
  const nextPages = new Map(next.pages.map((page) => [page.id, page]));
  for (const page of before.pages) {
    const nextPage = nextPages.get(page.id);
    if (!nextPage || nextPage.objects === page.objects) continue;
    const nextMarks = new Map(nextPage.objects
      .flatMap((object) => object.type === "electron-mark" && markIds.has(object.id) ? [[object.id, object] as const] : []));
    const moved = new Set<string>();
    for (const mark of page.objects) {
      if (mark.type !== "electron-mark" || !markIds.has(mark.id)) continue;
      const { charge, radicals } = electronMarkAtomContribution(mark);
      if (charge === 0 && radicals === 0) continue;
      const after = nextMarks.get(mark.id);
      if (!after || after === mark) continue;
      const repositioned = after.x !== mark.x || after.y !== mark.y || after.width !== mark.width || after.height !== mark.height;
      const reanchored = after.atomAssociation === "explicit" &&
        (mark.atomAssociation !== "explicit" || JSON.stringify(after.anchor) !== JSON.stringify(mark.anchor));
      if (repositioned || reanchored) moved.add(mark.id);
    }
    if (moved.size === 0) continue;
    for (const document of documents) {
      const documentPage = document.pages.find((candidate) => candidate.id === page.id);
      for (const mark of documentPage?.objects ?? []) {
        if (mark.type !== "electron-mark" || !moved.has(mark.id)) continue;
        for (const owner of markAtoms(documentPage!, mark)) keys.add(atomChemistryKey(page.id, owner.objectId, owner.atomId));
      }
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------------------------
// The AGENTS.md section 7 invariants beyond charge (bug chemistry-guard-too-narrow, 1.2.4): a
// preserving commit used to compare only charge and radical marks, so an element, isotope, stated
// hydrogen count, bond order, wedge or a mirrored layout changed silently. Cheap fields first.
// Stereo is judged by what it means, never by which bond carries a wedge (Spin 3D flatten and
// Clean Up legitimately re-place wedges): R/S per atom and E/Z per double bond as the app's
// perceivers read the molecule back, and the axial configuration of an atropisomer axis. The
// read-back runs only for a molecule whose wedge, hash or wavy marks changed, or whose layout
// changed other than by an orientation-preserving affine map (move, align, rotate, scale; a
// mirror too under Flip only, `flipChemistry`), which cannot change it. Without the engine (still loading, or failed to load), or when it cannot read the
// drawing, a molecule that needs the read-back is refused with a message saying so (fail closed);
// one without any stereo element never waits and is never refused for it.
// ---------------------------------------------------------------------------------------------

/** The stereo perceivers the guard reads a molecule back with: the app's OpenChemLib ones (`stereoReadout.ts`). */
export type CommitStereoEngine = StereoEngine;

/** Why the stereo read-back cannot run for this commit: the engine is still loading, or failed to load (`reason`). */
export type StereoEngineUnavailable =
  | { readonly unavailable: "loading" }
  | { readonly unavailable: "failed"; readonly reason: string };
export const STEREO_ENGINE_LOADING: StereoEngineUnavailable = { unavailable: "loading" };
/** `CommitChemistryCheck.stereoEngine`: an engine, or why there is none. */
export type CommitStereoEngineOption = CommitStereoEngine | StereoEngineUnavailable;

const isUnavailable = (option: CommitStereoEngineOption): option is StereoEngineUnavailable => "unavailable" in option;

let loadedStereoEngine: CommitStereoEngine | undefined;
let stereoEngineLoad: Promise<CommitStereoEngine | undefined> | undefined;
/** The last load's failure, kept (and named in refusals) until a later load succeeds. */
let stereoEngineFailure: string | undefined;
/** Bumped by the test reset, so a load still in flight from an earlier test cannot settle into the next one. */
let stereoEngineGeneration = 0;

const errorText = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.trim() || "unknown error";
};

/**
 * Loads the stereo engine for the guard (the app's shared lazy load, §13) and keeps it for the
 * synchronous commit funnel; MainWindow starts it in the background right after mount. Resolves
 * undefined when it cannot load, and remembers why (`StereoEngineUnavailable`); a later call retries.
 */
export function loadCommitStereoEngine(load: () => Promise<StereoEngine> = loadStereoEngine): Promise<CommitStereoEngine | undefined> {
  if (loadedStereoEngine) return Promise.resolve(loadedStereoEngine);
  if (!stereoEngineLoad) {
    const generation = stereoEngineGeneration;
    stereoEngineLoad = Promise.resolve().then(load).then((engine) => {
      if (generation === stereoEngineGeneration) {
        loadedStereoEngine = engine;
        stereoEngineFailure = undefined;
        stereoEngineLoad = undefined;
      }
      return engine;
    }, (error: unknown) => {
      if (generation === stereoEngineGeneration) {
        stereoEngineFailure = errorText(error);
        stereoEngineLoad = undefined;
      }
      return undefined;
    });
  }
  return stereoEngineLoad;
}

/** Test hook: forget the guard's engine, its failure and any load in flight. */
export function resetCommitStereoEngineForTests(): void {
  stereoEngineGeneration++;
  loadedStereoEngine = undefined;
  stereoEngineLoad = undefined;
  stereoEngineFailure = undefined;
}

/** The engine to read back with, or why there is none; asking starts (or retries) the load. */
function currentStereoEngine(option: CommitStereoEngineOption | undefined): CommitStereoEngineOption {
  if (option !== undefined) return option;
  if (loadedStereoEngine) return loadedStereoEngine;
  void loadCommitStereoEngine();
  return stereoEngineFailure === undefined ? STEREO_ENGINE_LOADING : { unavailable: "failed", reason: stereoEngineFailure };
}

const STEREO_STYLES: ReadonlySet<string> = new Set(["wedge", "hashed", "wavy"]);
const stereoStyle = (bond: MoleculeBond): string | undefined => {
  const style = bond.display?.bondStyle;
  return style !== undefined && STEREO_STYLES.has(style) ? style : undefined;
};
const quoted = (value: string | number | undefined, none: string) => value === undefined ? none : String(value);

function atomInvariantChanges(before: MoleculeAtom, after: MoleculeAtom): string[] {
  const id = before.id;
  const details: string[] = [];
  if (before.element !== after.element) details.push(`its atom "${id}" would be ${after.element} instead of ${before.element}`);
  if (before.isotope !== after.isotope) {
    details.push(`its atom "${id}" would have isotope ${quoted(after.isotope, "none")} instead of ${quoted(before.isotope, "none")}`);
  }
  if (before.hydrogenCount !== after.hydrogenCount) {
    const stated = (count: number | undefined) => count === undefined ? "no stated hydrogen count" : `a stated hydrogen count of ${count}`;
    details.push(`its atom "${id}" would have ${stated(after.hydrogenCount)} instead of ${stated(before.hydrogenCount)}`);
  }
  if ((before.labelLiteral ?? false) !== (after.labelLiteral ?? false)) {
    details.push(after.labelLiteral
      ? `its atom "${id}" would become a literal label (no implicit hydrogens)`
      : `its atom "${id}" would stop being a literal label and gain implicit hydrogens`);
  }
  return details;
}

function bondInvariantChanges(before: MoleculeBond, after: MoleculeBond): string[] {
  const id = before.id;
  const sameEnds = (before.fromAtomId === after.fromAtomId && before.toAtomId === after.toAtomId) ||
    (before.fromAtomId === after.toAtomId && before.toAtomId === after.fromAtomId);
  if (!sameEnds) {
    return [`its bond "${id}" would join atoms "${after.fromAtomId}" and "${after.toAtomId}" instead of "${before.fromAtomId}" and "${before.toAtomId}"`];
  }
  const details: string[] = [];
  if (before.order !== after.order) details.push(`its bond "${id}" would be ${after.order} instead of ${before.order}`);
  if (before.stereo !== after.stereo) {
    details.push(after.stereo === "either"
      ? `its bond "${id}" would have unspecified (either) E/Z instead of the drawn geometry`
      : `its bond "${id}" would take E/Z from the drawn geometry instead of unspecified (either)`);
  }
  return details;
}

/**
 * Whether any wedge, hash or wavy mark changed: its style, or its narrow end. Not a change by
 * itself (a mark re-placed on another bond can keep every centre); it means the stereo must be
 * read back.
 */
function stereoMarksChanged(before: MoleculeObject, after: MoleculeObject): boolean {
  if (before.bonds === after.bonds) return false;
  const afterBonds = new Map(after.bonds.map((bond) => [bond.id, bond]));
  return before.bonds.some((bond) => {
    const found = afterBonds.get(bond.id);
    if (!found || found === bond) return false;
    const style = stereoStyle(bond);
    return style !== stereoStyle(found) || (style !== undefined && bond.fromAtomId !== found.fromAtomId);
  });
}

/**
 * Every AGENTS.md section 7 invariant of `before` that `after` (the same molecule after the
 * operation) does not keep, other than charge and radical marks (`moleculeAtomChemistryChanges`)
 * and removed atoms, which that comparison reports: element, isotope, stated hydrogen count,
 * literal flag, added atoms, added, removed or rejoined bonds, bond order, E/Z "either", and the
 * stereochemistry the result reads back as (`stereoReadBackChanges`): what the wedges mean, not
 * which bonds carry them. Atoms and bonds are paired by id. Empty when nothing changed.
 * `mirrorIsTheOperation`: see `CommitChemistryCheck.mirrorIsTheOperation`.
 */
export function moleculeInvariantChanges(
  before: MoleculeObject,
  after: MoleculeObject,
  stereoEngine?: CommitStereoEngineOption,
  mirrorIsTheOperation = false
): MoleculeInvariantChange[] {
  if (before === after || (before.atoms === after.atoms && before.bonds === after.bonds)) return [];
  const changes: MoleculeInvariantChange[] = [];
  const beforeAtoms = new Map(before.atoms.map((atom) => [atom.id, atom]));
  const afterAtoms = new Map(after.atoms.map((atom) => [atom.id, atom]));
  let sameAtoms = before.atoms.length === after.atoms.length;
  if (before.atoms !== after.atoms) {
    for (const atom of before.atoms) {
      const found = afterAtoms.get(atom.id);
      if (!found) { sameAtoms = false; continue; }
      if (found === atom) continue;
      for (const detail of atomInvariantChanges(atom, found)) changes.push({ atomId: atom.id, detail });
    }
    for (const atom of after.atoms) {
      if (!beforeAtoms.has(atom.id)) {
        sameAtoms = false;
        changes.push({ detail: `it would gain atom "${atom.id}" (${atom.element})` });
      }
    }
  }
  if (before.bonds !== after.bonds) {
    const afterBonds = new Map(after.bonds.map((bond) => [bond.id, bond]));
    const beforeBondIds = new Set(before.bonds.map((bond) => bond.id));
    for (const bond of before.bonds) {
      const found = afterBonds.get(bond.id);
      if (!found) {
        changes.push({ detail: `its bond "${bond.id}" between atoms "${bond.fromAtomId}" and "${bond.toAtomId}" would be removed` });
      } else if (found !== bond) {
        for (const detail of bondInvariantChanges(bond, found)) changes.push({ detail });
      }
    }
    for (const bond of after.bonds) {
      if (!beforeBondIds.has(bond.id)) {
        changes.push({ detail: `it would gain bond "${bond.id}" between atoms "${bond.fromAtomId}" and "${bond.toAtomId}"` });
      }
    }
  }
  // Stereo is compared only on an unchanged graph: any other change is already refused, and a
  // read-back of a different graph would only repeat it less precisely.
  if (changes.length > 0 || !sameAtoms) return changes;
  const marksChanged = stereoMarksChanged(before, after);
  if (!marksChanged && before.atoms === after.atoms) return changes;
  if (!hasStereoContent(before) && !hasStereoContent(after)) return changes;
  if (!marksChanged && layoutKeepsStereo(before, after, beforeAtoms, mirrorIsTheOperation)) return changes;
  const engine = currentStereoEngine(stereoEngine);
  let unreadable: string | undefined;
  if (!isUnavailable(engine)) {
    const readBack = stereoReadBackChanges(before, after, engine);
    if (Array.isArray(readBack)) return readBack;
    unreadable = readBack.unreadable;
  }
  // No engine yet (or it failed), or it could not read this drawing: never pass a stereo change
  // unchecked (fail closed), and never guess from the wedges (that refused what the read-back
  // accepts). A molecule with no stereo element cannot change stereo by any layout, so only one
  // that has one waits for the engine, or is refused when the engine cannot read it.
  if (!mayCarryStereo(before) && !mayCarryStereo(after)) return changes;
  if (!isUnavailable(engine)) {
    return [{ detail: `its stereochemistry cannot be checked (${unreadable})`, stereoUnreadable: unreadable }];
  }
  return [{ detail: engine.unavailable === "loading" ? "its stereochemistry cannot be checked yet"
    : `its stereochemistry cannot be checked (${engine.reason})`, stereoUnchecked: engine }];
}

/** One section 7 invariant change of a molecule (`moleculeInvariantChanges`). */
export interface MoleculeInvariantChange {
  atomId?: string;
  detail: string;
  /** See `MoleculeChemistryChange.stereoUnchecked`. */
  stereoUnchecked?: StereoEngineUnavailable;
  /** See `MoleculeChemistryChange.stereoUnreadable`. */
  stereoUnreadable?: string;
}

/**
 * Whether the molecule has a stereo element a layout change could alter the meaning of, decided
 * without the engine: 3D coordinates, a wedge, hash or wavy bond, a possible atropisomer axis
 * (`mayBeAtropisomerAxis`), or a double bond that can be E/Z as drawn (not "either", each end with
 * another drawn neighbour, and not in a ring of seven or fewer atoms, where OpenChemLib perceives
 * no E/Z). Conservative: aromatic bonds count as double (the perception molfile may write them as
 * Kekulé doubles), so a large aromatic ring still waits.
 */
function mayCarryStereo(molecule: MoleculeObject): boolean {
  if (molecule.atoms.some((atom) => atom.z !== undefined)) return true;
  if (molecule.bonds.some((bond) => stereoStyle(bond) !== undefined)) return true;
  const neighbours = neighbourMap(molecule);
  if (molecule.bonds.some((bond) => mayBeAtropisomerAxis(neighbours, bond))) return true;
  return molecule.bonds.some((bond) => {
    if ((bond.order !== "double" && bond.order !== "aromatic") || bond.stereo === "either") return false;
    const others = (atomId: string) => (neighbours.get(atomId) ?? []).some((entry) => entry.bondId !== bond.id);
    if (!others(bond.fromAtomId) || !others(bond.toAtomId)) return false;
    return !inSmallRing(neighbours, bond.id, bond.fromAtomId, bond.toAtomId, 7);
  });
}

type NeighbourMap = ReadonlyMap<string, readonly { atomId: string; bondId: string }[]>;

/** Every atom's drawn neighbours, with the bond to each. */
function neighbourMap(molecule: MoleculeObject): NeighbourMap {
  const neighbours = new Map<string, { atomId: string; bondId: string }[]>();
  const link = (from: string, to: string, bondId: string) => {
    const list = neighbours.get(from) ?? [];
    list.push({ atomId: to, bondId });
    neighbours.set(from, list);
  };
  for (const bond of molecule.bonds) {
    link(bond.fromAtomId, bond.toAtomId, bond.id);
    link(bond.toAtomId, bond.fromAtomId, bond.id);
  }
  return neighbours;
}

/**
 * Whether `bond` may be a stereogenic biaryl axis (an atropisomer, as OpenChemLib perceives one
 * on a hindered biaryl such as BINOL), decided without the engine and on the safe side: a single
 * bond whose two ends each have two or more other neighbours and sit in a ring of at most eight
 * atoms, and whose ortho positions (the ends' other neighbours) carry at least three substituents or ring
 * fusions between them (an ortho atom with three or more drawn neighbours).
 */
function mayBeAtropisomerAxis(neighbours: NeighbourMap, bond: MoleculeBond): boolean {
  if (bond.order !== "single") return false;
  let hindered = 0;
  for (const end of [bond.fromAtomId, bond.toAtomId]) {
    const ortho = (neighbours.get(end) ?? []).filter((entry) => entry.bondId !== bond.id);
    if (ortho.length < 2) return false;
    if (!ortho.some((entry) => inSmallRing(neighbours, entry.bondId, end, entry.atomId, 8))) return false;
    hindered += ortho.filter((entry) => (neighbours.get(entry.atomId)?.length ?? 0) >= 3).length;
  }
  return hindered >= 3;
}

/** Whether a path from `from` to `to` that avoids bond `bondId` closes a ring of at most `maxRing` atoms. */
function inSmallRing(neighbours: NeighbourMap, bondId: string,
  from: string, to: string, maxRing: number): boolean {
  let frontier = [from];
  const seen = new Set([from]);
  // A ring of n atoms is a path of n - 1 bonds from `from` to `to` without the bond itself.
  for (let depth = 1; depth < maxRing && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const atomId of frontier) {
      for (const entry of neighbours.get(atomId) ?? []) {
        if (entry.bondId === bondId || seen.has(entry.atomId)) continue;
        if (entry.atomId === to) return true;
        seen.add(entry.atomId);
        next.push(entry.atomId);
      }
    }
    frontier = next;
  }
  return false;
}

/** Whether the molecule can carry stereo at all: a wedge, hash or wavy bond, a double bond, 3D coordinates, or a possible atropisomer axis. */
function hasStereoContent(molecule: MoleculeObject): boolean {
  if (molecule.bonds.some((bond) => bond.order === "double" || stereoStyle(bond) !== undefined) ||
    molecule.atoms.some((atom) => atom.z !== undefined)) return true;
  const neighbours = neighbourMap(molecule);
  return molecule.bonds.some((bond) => mayBeAtropisomerAxis(neighbours, bond));
}

/**
 * Whether `after`'s atom positions are an orientation-preserving affine image of `before`'s
 * (translation, rotation, uniform or non-uniform positive scaling, shear), with z unchanged. Such
 * a map keeps the cyclic order of every atom's neighbours and the side of every line each atom is
 * on, so the drawn tetrahedral and E/Z configuration is unchanged; the read-back is then skipped.
 * With `mirrorAllowed` (Flip only, `flipChemistry`), an orientation-reversing affine image (a mirror) is accepted too: it
 * draws the mirror image, which is what that command means. Exact to floating-point tolerance;
 * anything else (a mirror under any other commit, a partial drag, a re-layout) falls to the read-back.
 */
function layoutKeepsStereo(before: MoleculeObject, after: MoleculeObject, beforeAtoms: ReadonlyMap<string, MoleculeAtom>,
  mirrorAllowed: boolean): boolean {
  const pairs: [MoleculeAtom, MoleculeAtom][] = [];
  for (const atom of after.atoms) {
    const old = beforeAtoms.get(atom.id);
    if (!old || old.z !== atom.z) return false;
    pairs.push([old, atom]);
  }
  if (pairs.length === 0) return true;
  let extent = 1;
  for (const [old] of pairs) extent = Math.max(extent, Math.abs(old.x - pairs[0][0].x), Math.abs(old.y - pairs[0][0].y));
  const tolerance = 1e-7 * extent;
  const dx = pairs[0][1].x - pairs[0][0].x;
  const dy = pairs[0][1].y - pairs[0][0].y;
  if (pairs.every(([old, atom]) => Math.abs(atom.x - old.x - dx) <= tolerance && Math.abs(atom.y - old.y - dy) <= tolerance)) return true;
  let px = 0, py = 0, qx = 0, qy = 0;
  for (const [old, atom] of pairs) { px += old.x; py += old.y; qx += atom.x; qy += atom.y; }
  px /= pairs.length; py /= pairs.length; qx /= pairs.length; qy /= pairs.length;
  let sxx = 0, sxy = 0, syy = 0, axx = 0, axy = 0, ayx = 0, ayy = 0;
  for (const [old, atom] of pairs) {
    const ox = old.x - px, oy = old.y - py, nx = atom.x - qx, ny = atom.y - qy;
    sxx += ox * ox; sxy += ox * oy; syy += oy * oy;
    axx += nx * ox; axy += nx * oy; ayx += ny * ox; ayy += ny * oy;
  }
  const det = sxx * syy - sxy * sxy;
  // Collinear (or coincident) atoms: no plane to orient, so let the read-back decide.
  if (!(det > 1e-12 * (sxx + syy) * (sxx + syy))) return false;
  const m00 = (axx * syy - axy * sxy) / det, m01 = (axy * sxx - axx * sxy) / det;
  const m10 = (ayx * syy - ayy * sxy) / det, m11 = (ayy * sxx - ayx * sxy) / det;
  const orientation = m00 * m11 - m01 * m10;
  if (!((mirrorAllowed ? Math.abs(orientation) : orientation) > 1e-9 * (m00 * m00 + m01 * m01 + m10 * m10 + m11 * m11))) return false;
  let afterExtent = 1;
  for (const [, atom] of pairs) afterExtent = Math.max(afterExtent, Math.abs(atom.x - qx), Math.abs(atom.y - qy));
  const fit = 1e-7 * Math.max(extent, afterExtent);
  return pairs.every(([old, atom]) => {
    const ox = old.x - px, oy = old.y - py;
    return Math.abs(m00 * ox + m01 * oy - (atom.x - qx)) <= fit && Math.abs(m10 * ox + m11 * oy - (atom.y - qy)) <= fit;
  });
}

type StereoReading = {
  molfile: string;
  centres: Map<string, string>;
  doubleBonds: Map<string, string>;
  /** The atropisomer axes OpenChemLib perceives, as bonds of the molecule (`perceiveUnrepresentableStereo`). */
  axes: MoleculeBond[];
};

/**
 * The molecule's stereo as the app's perceivers read it back (`stereoPerceptionMolfile`, as the
 * flatten and layout guards do), or why it cannot be read: the end of "cannot be checked because
 * …", naming the step that failed and which drawing (`which`: "before" or "after" the edit).
 */
function readStereo(molecule: MoleculeObject, engine: CommitStereoEngine, which: string): StereoReading | { unreadable: string } {
  const drawing = `the drawing ${which} the edit`;
  let molfile: string;
  try {
    molfile = stereoPerceptionMolfile(molecule);
  } catch (error) {
    return { unreadable: `the stereo perception molfile could not be written for ${drawing} (${errorText(error)})` };
  }
  const centres = new Map<string, string>();
  try {
    const perceived = engine.perceiveStereoCentersFromMolfile(molfile);
    if (perceived.length !== molecule.atoms.length) {
      return { unreadable: `the stereocentre perceiver read ${perceived.length} of the ${molecule.atoms.length} atoms of ${drawing}` };
    }
    perceived.forEach((centre, index) => {
      if (centre.isStereoCenter) centres.set(molecule.atoms[index].id, centre.descriptor);
    });
  } catch (error) {
    return { unreadable: `the stereocentre perceiver failed on ${drawing} (${errorText(error)})` };
  }
  const doubleBonds = new Map<string, string>();
  try {
    for (const bond of engine.perceiveDoubleBondStereoFromMolfile(molfile)) {
      const from = molecule.atoms[bond.from]?.id;
      const to = molecule.atoms[bond.to]?.id;
      if (from === undefined || to === undefined) {
        return { unreadable: `the double-bond stereo perceiver named an atom ${drawing} does not have` };
      }
      doubleBonds.set(JSON.stringify([from, to].sort()), bond.descriptor);
    }
  } catch (error) {
    return { unreadable: `the double-bond stereo perceiver failed on ${drawing} (${errorText(error)})` };
  }
  const axes: MoleculeBond[] = [];
  if (!engine.perceiveUnrepresentableStereo || !engine.assertConstrainedLayoutIdentity) {
    const neighbours = neighbourMap(molecule);
    if (molecule.bonds.some((bond) => mayBeAtropisomerAxis(neighbours, bond))) {
      return { unreadable: "the stereo engine cannot read atropisomer axes" };
    }
    return { molfile, centres, doubleBonds, axes };
  }
  try {
    // V2000 input bond order: the perception molfile writes the molecule's bonds in order.
    for (const index of engine.perceiveUnrepresentableStereo(molfile).atropisomerBonds) {
      const bond = molecule.bonds[index];
      if (!bond) return { unreadable: `the atropisomer perceiver named a bond ${drawing} does not have` };
      axes.push(bond);
    }
  } catch (error) {
    return { unreadable: `the atropisomer perceiver failed on ${drawing} (${errorText(error)})` };
  }
  return { molfile, centres, doubleBonds, axes };
}

const centreReading = (value: string | undefined) => value === undefined ? "no stereocentre"
  : value === "unspecified" ? "an unspecified stereocentre" : `stereocentre ${value}`;
const doubleBondReading = (value: string | undefined) => value === undefined ? "no E/Z"
  : value === "unspecified" ? "unassigned E/Z" : value;

/**
 * The stereochemistry `after` reads back as against `before`'s, keyed by atom id: every
 * stereocentre's R/S (or that it is one at all, and whether it is defined: a wavy bond or no mark
 * reads as unspecified), every specified double bond's E/Z, and, on a molecule with an atropisomer
 * axis, the axial configuration. A centre inverted, gained or lost, E turned Z, or an axis mirrored
 * or made undefined is a change; a wedge re-placed on another bond that keeps every centre and axis
 * is not. The adapter reports axes but not their configuration one by one, so axial stereo is
 * compared as OpenChemLib's canonical identity (idcode, which carries every stereo parity) of the
 * two drawings, once no centre or double bond has changed: the graph is the same (checked first),
 * so a different idcode is a different stereo configuration. When either drawing cannot be read,
 * `unreadable` says why, and the caller refuses the commit (fail closed) unless the molecule has no
 * stereo element at all (`moleculeInvariantChanges`).
 */
function stereoReadBackChanges(before: MoleculeObject, after: MoleculeObject, engine: CommitStereoEngine):
  MoleculeInvariantChange[] | { unreadable: string } {
  const readBefore = readStereo(before, engine, "before");
  if ("unreadable" in readBefore) return readBefore;
  const readAfter = readStereo(after, engine, "after");
  if ("unreadable" in readAfter) return readAfter;
  const changes: MoleculeInvariantChange[] = [];
  for (const atom of before.atoms) {
    const was = readBefore.centres.get(atom.id);
    const now = readAfter.centres.get(atom.id);
    if (was !== now) changes.push({ atomId: atom.id, detail: `its atom "${atom.id}" would read as ${centreReading(now)} instead of ${centreReading(was)}` });
  }
  for (const key of new Set([...readBefore.doubleBonds.keys(), ...readAfter.doubleBonds.keys()])) {
    const was = readBefore.doubleBonds.get(key);
    const now = readAfter.doubleBonds.get(key);
    if (was === now) continue;
    const [from, to] = JSON.parse(key) as [string, string];
    changes.push({ detail: `its double bond between atoms "${from}" and "${to}" would read ${doubleBondReading(now)} instead of ${doubleBondReading(was)}` });
  }
  const axisIds = new Set([...readBefore.axes, ...readAfter.axes].map((bond) => bond.id));
  const axes = before.bonds.filter((bond) => axisIds.has(bond.id));
  if (changes.length > 0 || axes.length === 0) return changes;
  const sameIdentity = engine.assertConstrainedLayoutIdentity;
  if (!sameIdentity) return { unreadable: "the stereo engine cannot read atropisomer axes" };
  try {
    sameIdentity(readBefore.molfile, readAfter.molfile);
  } catch (error) {
    const text = errorText(error);
    // The adapter's refusal when the canonical identities differ; anything else is a failure to compare.
    if (!/would change stereochemistry/.test(text)) return { unreadable: `the atropisomer axes could not be compared (${text})` };
    const named = axes.map((bond) => `between atoms "${bond.fromAtomId}" and "${bond.toAtomId}"`).join(", ");
    changes.push({ detail: `its axial stereochemistry would read differently (the atropisomer ${axes.length === 1 ? "axis" : "axes"} ${named})` });
  }
  return changes;
}
