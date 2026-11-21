import { retainedCtabCompatibility } from "./storedCtabGeometry";
import { adoptDerivedDocument, DocumentPatchError, type ChemDraftDocument, type DocumentObject, type DocumentPage, type DocumentPatch, type MoleculeObject } from "@chemdraft/chem-core";
import {
  PluginRequestLimits, type NormalizedProposedDocumentPatch, type PluginExpectedStructure,
  type PluginRequestError, type PluginRequestPrecondition
} from "@chemdraft/plugin-api";
import {
  assertPluginDocumentWriteScope, assertPluginPatchWriteScope, DirectWritePatchOps, writePatchOps
} from "./index";
import { sameDocumentValue } from "./documentValue";
import { rebasePluginPatch } from "./rebasePluginPatch";
import { assertAuthoredBracketReferences, assertRequestReferences, requestReferenceScope } from "./requestReferences";

export class RequestWriteError extends Error {
  constructor(readonly code: PluginRequestError["code"], message: string) { super(message); }
}

export interface RequestObjectRef { pageId: string; objectId: string }
export interface RequestViewport { x: number; y: number; width: number; height: number }
export type RequestPageChoice = "keep" | "enlarge" | "unanswered";
export interface RequestPageFit {
  growth: readonly { pageId: string; requiredBounds: RequestViewport; width: number; height: number;
    shiftX: number; shiftY: number; movedObjectIds: string[] }[];
  apply(): ChemDraftDocument;
  project(document: ChemDraftDocument): ChemDraftDocument;
}
export interface RequestPageSpaceProvider {
  /** `documentKey` is the request document's `RequestDocument.key`, so the host can own the question
   * by the document the request started in, whichever document is active when it is asked. */
  confirm(signal: AbortSignal, documentKey: string): Promise<RequestPageChoice>;
  plan(before: ChemDraftDocument, proposed: ChemDraftDocument,
    minimum?: { pageId: string; width: number; height: number }): RequestPageFit;
}

export function pageContainsBounds(page: { width: number; height: number }, bounds: RequestViewport): boolean {
  return containsBounds({ x: 0, y: 0, width: page.width, height: page.height }, bounds);
}

export function containsBounds(outer: RequestViewport, inner: RequestViewport): boolean {
  const epsilon = 1e-6;
  return inner.x >= outer.x - epsilon && inner.y >= outer.y - epsilon &&
    inner.x + inner.width <= outer.x + outer.width + epsilon &&
    inner.y + inner.height <= outer.y + outer.height + epsilon;
}
export interface RequestDocument {
  /** Stable across tab switches and unique to this open document instance. */
  key: string;
  /** Current immutable snapshot. The identity stays stable until editing. */
  read(): ChemDraftDocument | undefined;
  viewport?(): RequestViewport | undefined;
}

type VerifyWrite = (before: ChemDraftDocument, draft: ChemDraftDocument, scope: ReadonlySet<string>,
  expected: ReadonlyMap<string, string>, signal: AbortSignal) => Promise<ChemDraftDocument>;

export interface RequestHistory {
  verify: VerifyWrite;
  /** Synchronous normalization of the live rebase, using the same rules as verify.
   * Hosts which commit the authored geometry directly can omit this hook. */
  normalize?(document: ChemDraftDocument): ChemDraftDocument;
  checkFinal?(before: ChemDraftDocument, draft: ChemDraftDocument, final: ChemDraftDocument, scope: ReadonlySet<string>): void;
  run<T>(apply: () => T): Promise<T>;
  /** Check history continuity before preparing and again inside the history guard. */
  check?(): void;
  write(after: ChemDraftDocument, touched: readonly string[],
    assertFinalDocument: (final: ChemDraftDocument) => void): void;
  close?(): void;
}

export interface BoundRequestWrite {
  document: RequestDocument;
  history: RequestHistory;
  selection: readonly RequestObjectRef[];
  signal: AbortSignal;
  authorize(): void;
  enterGestureWait?(): (() => void) | undefined;
  pageSpace?: {
    plan: RequestPageSpaceProvider["plan"];
    confirm(fit: RequestPageFit, before: ChemDraftDocument): Promise<RequestPageChoice>;
    check(fit: RequestPageFit): void;
    checkApproval(current: ChemDraftDocument): void;
  };
  validate?(result: RequestWriteCommit): void;
  publish(result: RequestWriteCommit): void;
}

export interface RequestWriteCommit {
  touched: RequestObjectRef[];
  insertions: (RequestObjectRef & { opIndex: number; object: DocumentObject })[];
}

type Entry = RequestObjectRef & { object: DocumentObject };
const entries = (document: ChemDraftDocument): Entry[] => document.pages.flatMap(page =>
  page.objects.map(object => ({ pageId: page.id, objectId: object.id, object })));
const equal = (left: unknown, right: unknown): boolean => left === right || JSON.stringify(left) === JSON.stringify(right);
const sameEntry = (left: Entry | undefined, right: Entry | undefined) =>
  left?.pageId === right?.pageId && equal(left?.object, right?.object);
const objectTarget = (op: Exclude<DocumentPatch, { op: "batch" }>): string[] =>
  "objectId" in op ? [op.objectId] : op.op === "setObjectOrder" ? op.objectIds : [];

/** The verifier may refresh storage and record a label's bond side. The authored native graph,
 * including coordinates that encode E/Z and the charge/radical contributions of marks, is fixed.
 * The desktop verifier compares the chemical reading of side-dependent labels with RDKit. */
function assertVerifiedGraph(authored: MoleculeObject, verified: MoleculeObject): void {
  const atomFields = ({ labelBondSide: _side, ...atom }: MoleculeObject["atoms"][number]) => atom;
  const sameAtoms = authored.atoms === verified.atoms || (authored.atoms.length === verified.atoms.length &&
    authored.atoms.every((atom, index) => atom === verified.atoms[index] ||
      sameDocumentValue(atomFields(atom), atomFields(verified.atoms[index]!))));
  if (!sameAtoms || !sameDocumentValue(authored.bonds, verified.bonds) ||
      !sameDocumentValue(authored.superatoms, verified.superatoms) || !sameDocumentValue(authored.rGroups, verified.rGroups)) {
    throw new RequestWriteError("chemistry", `Desktop normalization would change the authored graph of molecule "${authored.id}".`);
  }
}

function sameStoredChemistry(left: MoleculeObject, right: MoleculeObject): boolean {
  return left.structureFormat === right.structureFormat && left.structure === right.structure &&
    sameDocumentValue(left.chemistry, right.chemistry) && sameDocumentValue(left.compatibility, right.compatibility);
}

export class RequestRevisions {
  private readonly objects = new WeakMap<DocumentObject, string>();
  private readonly pages = new Map<string, { token: string; page: DocumentPage }>();
  private readonly objectsByPage = new WeakMap<DocumentPage["objects"], Map<string, DocumentObject | undefined>>();

  private uniqueObjects(page: DocumentPage) {
    let index = this.objectsByPage.get(page.objects);
    if (!index) {
      index = new Map();
      for (const object of page.objects) index.set(object.id, index.has(object.id) ? undefined : object);
      this.objectsByPage.set(page.objects, index);
    }
    return index;
  }

  object(object: DocumentObject): string {
    let token = this.objects.get(object);
    if (!token) { token = crypto.randomUUID(); this.objects.set(object, token); }
    return token;
  }

  /** A group's bounds depend on its descendants. Their revisions constrain placement only. */
  tableAnchors(page: DocumentPage, anchors: readonly RequestObjectRef[]): PluginRequestPrecondition[] {
    const ids = new Set(anchors.map(ref => ref.objectId));
    const objects = this.uniqueObjects(page);
    const conditions: PluginRequestPrecondition[] = [];
    for (const id of ids) {
      const object = objects.get(id);
      if (!object) throw new RequestWriteError("stale", `Table anchor "${id}" is unavailable.`);
      conditions.push({ kind: "objectRevision", pageId: page.id, objectId: id, token: this.object(object) });
      if (object.type === "group") {
        for (const childId of object.childObjectIds) {
          // Missing children contributed no bounds at capture. Ambiguous IDs still fail above.
          if (objects.has(childId)) ids.add(childId);
        }
      }
    }
    return conditions;
  }

  page(page: DocumentPage): string {
    const previous = this.pages.get(page.id);
    if (previous && (previous.page === page || (
      previous.page.objects.length === page.objects.length &&
      previous.page.objects.every((object, index) => object === page.objects[index]) &&
      equal({ ...previous.page, objects: [] }, { ...page, objects: [] })
    ))) return previous.token;
    const token = crypto.randomUUID();
    this.pages.set(page.id, { token, page });
    return token;
  }

  check(document: ChemDraftDocument, conditions: readonly PluginRequestPrecondition[]): void {
    for (const condition of conditions) {
      const page = document.pages.find(page => page.id === condition.pageId);
      const object = page && condition.kind === "objectRevision" && this.uniqueObjects(page).get(condition.objectId);
      const matches = page && (condition.kind === "pageAtLeast"
        ? page.width >= condition.width && page.height >= condition.height
        : object && this.object(object) === condition.token);
      if (!matches) throw new RequestWriteError("stale", condition.kind === "pageAtLeast"
        ? `Page "${condition.pageId}" no longer meets the required size.`
        : `Object "${condition.objectId}" no longer has the requested revision.`);
    }
  }
}

interface WriteOptions {
  useInsertionSource?: boolean;
  revisions?: RequestRevisions;
  preconditions?: readonly PluginRequestPrecondition[];
  expected?: readonly PluginExpectedStructure[];
}

/** Pure preflight shared by figure planners and the live write. Keep the preparation
 * function so commit can rebase the same proposal after waiting for a gesture. */
export async function preflightRequestPatch(before: ChemDraftDocument, proposal: NormalizedProposedDocumentPatch,
  selection: readonly RequestObjectRef[], verify: VerifyWrite, signal: AbortSignal, options: WriteOptions = {}) {
  const ops = writePatchOps(proposal.patch);
  if (ops.some(op => !(DirectWritePatchOps as readonly string[]).includes(op.op))) {
    throw new RequestWriteError("invalid", "The patch contains an operation unavailable to request writes.");
  }
  function prepare(before: ChemDraftDocument) {
    const original = entries(before);
    const proposalIds = new Set<string>();
    for (const op of ops) {
      if (op.op !== "addObject" && op.op !== "addAnnotation") continue;
      const id = op.op === "addObject" ? op.object.id : op.annotation.id;
      if (proposalIds.has(id)) throw new RequestWriteError("invalid", `Ambiguous insertion ID "${id}".`);
      proposalIds.add(id);
    }
    const rebased = rebasePluginPatch(before, proposal, false, true);
    const leaves = writePatchOps(rebased.patch);
    const insertionRefs = leaves.flatMap((op, opIndex) => op.op === "addObject" || op.op === "addAnnotation"
      ? [{ pageId: op.pageId, objectId: op.op === "addObject" ? op.object.id : op.annotation.id, opIndex }]
      : []);
    const byId = new Map<string, Entry>();
    for (const entry of original) {
      if (byId.has(entry.objectId)) throw new RequestWriteError("invalid", `Ambiguous object ID "${entry.objectId}".`);
      byId.set(entry.objectId, entry);
    }
    if (new Set(before.pages.map(page => page.id)).size !== before.pages.length) {
      throw new RequestWriteError("invalid", "The document contains an ambiguous page or object ID.");
    }
    const scope = selection.filter(ref => byId.get(ref.objectId)?.pageId === ref.pageId).map(ref => ref.objectId);
    const targets = new Set<string>();
    const ordered = new Set<string>();
    const granted = new Set(scope);
    for (const op of leaves) {
      if (op.op === "addObject" || op.op === "addAnnotation") {
        granted.add(op.op === "addObject" ? op.object.id : op.annotation.id);
        continue;
      }
      const seen = op.op === "setObjectOrder" ? ordered : targets;
      for (const id of objectTarget(op)) {
        if (seen.has(id)) throw new RequestWriteError("invalid", `Ambiguous patch target "${id}".`);
        if (!granted.has(id)) throw new RequestWriteError("scope", `${id} was not selected when the command started`);
        seen.add(id);
      }
    }

    // Native objects can refer to each other within an atomic batch. Use their rebased IDs and
    // grant neither a colliding existing ID nor a reference on a different page.
    const grantedPages = new Map(scope.map(id => [id, byId.get(id)!.pageId]));
    for (const { objectId, pageId } of insertionRefs) grantedPages.set(objectId, pageId);
    const checkReferenceScope = requestReferenceScope(grantedPages);

    const expected = new Map<string, string>();
    for (const item of options.expected ?? []) {
      const entry = item.kind === "insertion"
        ? insertionRefs.find(ref => ref.opIndex === item.opIndex)
        : byId.get(item.objectId);
      if (item.kind === "object" && (!scope.includes(item.objectId) || entry?.pageId !== item.pageId || !targets.has(item.objectId))) {
        throw new RequestWriteError("scope", `Structure expectation for "${item.objectId}" must refer to an in-scope edited molecule.`);
      }
      if (!entry || expected.has(entry.objectId)) throw new RequestWriteError("invalid", "Invalid or duplicate structure expectation.");
      expected.set(entry.objectId, item.sourceSmiles);
    }

    // This preflight applies the whole draft atomically and detects implicit bracket, reaction
    // and crossing changes. Its original proposal is kept so commit-time rebasing uses live IDs.
    let draft: ChemDraftDocument;
    try { draft = assertPluginPatchWriteScope(before, proposal, scope, rebased, checkReferenceScope); }
    catch (error) {
      if (error instanceof RequestWriteError) throw error;
      throw new RequestWriteError(error instanceof DocumentPatchError ? "invalid" : "scope", (error as Error).message);
    }
    const nextEntries = entries(draft);
    const after = new Map(nextEntries.map(entry => [entry.objectId, entry]));
    if (options.useInsertionSource) {
      for (const { objectId } of insertionRefs) {
        const molecule = after.get(objectId)?.object;
        if (molecule?.type !== "molecule") continue;
        const source = molecule.structureFormat === "smiles" ? molecule.structure : molecule.compatibility?.unknown.smiles;
        if (typeof source === "string" && source.trim() && source.length <= 5_000) expected.set(objectId, source);
      }
    }
    for (const id of expected.keys()) {
      const molecule = after.get(id)?.object;
      if (molecule?.type !== "molecule" || equal(byId.get(id)?.object, molecule)) {
        throw new RequestWriteError("invalid", `Structure expectation for "${id}" must refer to a changed molecule.`);
      }
    }
    assertAuthoredBracketReferences(leaves, after);
    assertRequestReferences(before, draft, targets, insertionRefs.map(ref => ref.objectId), checkReferenceScope);
    const touched = new Map<string, RequestObjectRef>();
    for (const op of leaves) {
      const ids = op.op === "addObject" ? [op.object.id] : op.op === "addAnnotation" ? [op.annotation.id] : objectTarget(op);
      for (const objectId of ids) {
        const entry = after.get(objectId) ?? byId.get(objectId);
        if (entry) touched.set(objectId, { objectId, pageId: entry.pageId });
      }
    }
    const changed = [...touched.values()];
    if (changed.length > PluginRequestLimits.objects) throw new RequestWriteError("limit", "Too many objects in the write receipt.");
    return { draft, scope, expected, insertionRefs, changed, granted, byId, checkReferenceScope };
  }

  const planned = prepare(before);
  let verified: ChemDraftDocument;
  let inspectedFinal: Map<string, Entry>;
  try {
    verified = await verify(before, planned.draft, planned.granted, planned.expected, signal);
    inspectedFinal = new Map(entries(verified).map(entry => [entry.objectId, entry]));
    for (const { object } of entries(planned.draft)) {
      if (object.type !== "molecule") continue;
      const final = inspectedFinal.get(object.id)?.object;
      if (final?.type !== "molecule") throw new RequestWriteError("chemistry",
        `Desktop normalization would remove molecule "${object.id}".`);
      if (object !== final) assertVerifiedGraph(object, final);
      const original = planned.byId.get(object.id)?.object;
      if (original?.type === "molecule" && original !== final && !planned.expected.has(object.id) &&
          !sameStoredChemistry(original, final) &&
          !sameStoredChemistry({ ...original, compatibility: retainedCtabCompatibility(original, final) }, final)) {
        throw new RequestWriteError("chemistry", `The write would replace the stored chemistry of "${object.id}" without a verified chemical edit.`);
      }
    }
  } catch (error) {
    throw new RequestWriteError("chemistry", (error as Error).message);
  }
  return { prepare, planned, verified, inspectedFinal };
}

/** One host path for explicit patches and bound compatibility writes. */
export async function commitRequestPatch(binding: BoundRequestWrite, proposal: NormalizedProposedDocumentPatch,
  options: WriteOptions = {}): Promise<RequestWriteCommit> {
  function read(): ChemDraftDocument {
    binding.authorize();
    if (binding.signal.aborted) throw new RequestWriteError("cancelled", "The request write was cancelled.");
    const document = binding.document.read();
    if (!document) throw new RequestWriteError("stale", "The request document was closed or replaced.");
    binding.history.check?.();
    options.revisions?.check(document, options.preconditions ?? []);
    return document;
  }
  const before = read();
  const { prepare, planned, verified, inspectedFinal } = await preflightRequestPatch(before, proposal, binding.selection,
    (...args) => binding.history.verify(...args), binding.signal, options).catch(error => {
      read(); // Cancellation and lost authorization take priority over verification failures.
      throw error;
    });
  read();
  const pageSpace = binding.pageSpace;
  const initialFit = pageSpace?.plan(before, verified);
  let choice: RequestPageChoice | undefined;
  if (pageSpace && initialFit?.growth.length) {
    pageSpace.check(initialFit);
    choice = await pageSpace.confirm(initialFit, before);
    read();
    if (choice === "unanswered") throw new RequestWriteError("cancelled", "The page size question was unanswered.");
  }
  const finishWait = binding.enterGestureWait?.();
  return binding.history.run(() => {
    finishWait?.();
    const live = read();
    const plan = prepare(live);
    if (!equal(planned.insertionRefs, plan.insertionRefs) || !equal([...planned.expected], [...plan.expected]) ||
      [...new Set([...planned.changed, ...plan.changed].map(ref => ref.objectId))]
        .some(id => !sameEntry(planned.byId.get(id), plan.byId.get(id)))) {
      throw new RequestWriteError("stale", "A patch target changed while the write was prepared.");
    }
    // Preserve unrelated live changes, and verify the exact normalized chemistry in history.
    // Carry only host-derived storage fields over the live rebase. Normalization still runs on
    // the actual live graph; its result must match the complete inspected molecule in the guard.
    const proposed = adoptDerivedDocument(plan.draft, { ...plan.draft, pages: plan.draft.pages.map(page => {
      const objects = page.objects.map(object => {
        const entry = inspectedFinal.get(object.id);
        if (object.type !== "molecule" || entry?.object.type !== "molecule" || entry.pageId !== page.id ||
            sameEntry(entry, planned.byId.get(object.id))) return object;
        if (!sameEntry(plan.byId.get(object.id), planned.byId.get(object.id))) {
          throw new RequestWriteError("stale", `Molecule "${object.id}" changed during verification.`);
        }
        if (sameStoredChemistry(object, entry.object)) return object;
        const { structureFormat, structure, chemistry, compatibility } = entry.object;
        return { ...object, structureFormat, structure, chemistry, compatibility };
      });
      return objects.every((object, i) => object === page.objects[i]) ? page : { ...page, objects };
    }) });
    if (live === before && plan.insertionRefs.length === 0 &&
        equal(live.compatibility, proposed.compatibility) && equal(live.compatibility, verified.compatibility) &&
        live.pages.every((page, index) =>
          page.objects.length === proposed.pages[index]?.objects.length &&
          page.objects.length === verified.pages[index]?.objects.length &&
          equal(page.crossings, proposed.pages[index]!.crossings) && equal(page.crossings, verified.pages[index]!.crossings) &&
          page.objects.every((object, at) => equal(object, proposed.pages[index]!.objects[at]) &&
            equal(object, verified.pages[index]!.objects[at])))) {
      return { touched: [], insertions: [] };
    }
    // The verified drawing already includes derived geometry (such as attached arrow labels).
    // If the baseline changed during the wait, normalize the live rebase before measuring it.
    const fit = pageSpace?.plan(live, live === before ? verified : binding.history.normalize?.(proposed) ?? proposed);
    if (fit) pageSpace?.check(fit);
    if (!equal(initialFit?.growth, fit?.growth)) {
      throw new RequestWriteError("stale", "The required page space changed while preparing the write.");
    }
    const approvedFit = fit?.growth.length && choice === "enlarge" ? fit : undefined;
    // Apply the page-local mover to the candidate. Project the same host-computed fit directly
    // from independent snapshots so the mover cannot authorize any incidental change.
    const baseline = approvedFit?.project(live) ?? live;
    const expectedProposal = approvedFit?.project(proposed) ?? proposed;
    const expectedFinal = approvedFit
      ? new Map(entries(approvedFit.project(verified)).map(entry => [entry.objectId, entry]))
      : inspectedFinal;
    const baselineObjects = approvedFit && new Map(entries(baseline).map(entry => [entry.objectId, entry]));
    const guard = (final: ChemDraftDocument) => {
      if (read() !== live) throw new RequestWriteError("stale", "The request document changed before history recorded the write.");
      try {
        binding.history.checkFinal?.(baseline, expectedProposal, final, plan.granted);
        assertPluginDocumentWriteScope(baseline, final, proposal, plan.scope);
      }
      catch (error) {
        if (error instanceof RequestWriteError) throw error;
        throw new RequestWriteError("scope", (error as Error).message);
      }
      const finalEntries = entries(final);
      const finalObjects = new Map(finalEntries.map(entry => [entry.objectId, entry]));
      if (finalObjects.size !== finalEntries.length) throw new RequestWriteError("scope", "Ambiguous final object ID.");
      for (const entry of finalObjects.values()) {
        const intended = expectedFinal.get(entry.objectId);
        const original = plan.byId.get(entry.objectId);
        if (original && entry.pageId !== original.pageId) throw new RequestWriteError("scope", "A request cannot move objects between pages.");
        if (entry.object.type !== "molecule" && entry.object.type !== "electron-mark") continue;
        const unchanged = baselineObjects ? baselineObjects.get(entry.objectId) : original;
        if (sameEntry(unchanged, entry) && sameEntry(inspectedFinal.get(entry.objectId), planned.byId.get(entry.objectId))) continue;
        if (!sameEntry(original, planned.byId.get(entry.objectId)) || !sameEntry(intended, entry)) {
          throw new RequestWriteError("chemistry", `The normalized chemistry of "${entry.objectId}" changed after verification.`);
        }
      }
      for (const entry of entries(proposed)) {
        const type = entry.object.type;
        if ((type === "molecule" || type === "electron-mark") && finalObjects.get(entry.objectId)?.object.type !== type) {
          throw new RequestWriteError("chemistry", `The write would absorb or remove ${type} "${entry.objectId}" during normalization.`);
        }
      }
      for (const ref of plan.insertionRefs) {
        if (finalObjects.get(ref.objectId)?.pageId !== ref.pageId) {
          throw new RequestWriteError("scope", `The write would lose insertion "${ref.objectId}" during normalization.`);
        }
      }
      assertRequestReferences(baseline, final, new Set(plan.changed.map(ref => ref.objectId)),
        plan.insertionRefs.map(ref => ref.objectId), plan.checkReferenceScope);
      return finalObjects;
    };
    const commit: RequestWriteCommit = { touched: plan.changed, insertions: [] };
    binding.history.write(approvedFit?.apply() ?? proposed, plan.changed.map(ref => ref.objectId), final => {
      const finalObjects = guard(final);
      commit.insertions = plan.insertionRefs.map(ref => ({ ...ref, object: finalObjects.get(ref.objectId)!.object }));
      binding.validate?.(commit);
      const current = read();
      if (approvedFit) pageSpace!.checkApproval(current); // Last synchronous check before history installs the drawing.
    });
    binding.publish(commit);
    return commit;
  }).finally(finishWait);
}
