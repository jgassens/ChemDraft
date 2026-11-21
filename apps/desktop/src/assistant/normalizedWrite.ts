import type { ChemDraftDocument, DocumentObject, MoleculeObject } from "@chemdraft/chem-core";
import { duplicateIdRefusalMessage, effectiveScopePages, objectInWriteScope, type PluginWriteScopePages } from "@chemdraft/plugin-host";
import { normalizeCommittedDocument } from "../documentWorkflow";
import type { AssistantToolContext } from "./AssistantToolContext";
import { assertCanonical, inspectMolecule } from "../plugins/requestWrites/structureIdentity";

/** Keyed by page AND id: a bare-id map would let a same-id object on a later page hide (or stand in
 * for) the one the write changed. Keys are `pageKey(pageId, objectId)`. */
const pageKey = (pageId: string, objectId: string) => `${pageId}\u0000${objectId}`;
const objectsById = (document: ChemDraftDocument) => new Map(document.pages.flatMap(page =>
  page.objects.map(object => [pageKey(page.id, object.id), { pageId: page.id, object }] as const)));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type ObjectEntry = { pageId: string; object: DocumentObject };
// Patches and normalization share untouched objects. Do not serialize their atom/bond graphs
// just to discover that they are unchanged; retain value comparison for replaced objects.
const equalEntry = (a: ObjectEntry | undefined, b: ObjectEntry | undefined) =>
  (a?.pageId === b?.pageId && a?.object === b?.object) || equal(a, b);

/** Host boundary for every assistant tool write. Verify the exact desktop commit, not just
 * the patch: charge/radical reconciliation can also mutate unselected neighbouring objects.
 * The caller rechecks the authored result inside the synchronous gesture gate before host cleanup. */
function normalizeScopedWrite(before: ChemDraftDocument, patched: ChemDraftDocument, scope: ReadonlySet<string>,
  sendScopePages?: PluginWriteScopePages): ChemDraftDocument {
  // Follow a uniquely identified selected object that moved pages; never a same-id object elsewhere.
  const scopePages = effectiveScopePages(before, sendScopePages);
  const normalized = normalizeCommittedDocument(patched);
  assertOffPageDuplicatesUnchanged(before, normalized, scopePages);
  const previous = objectsById(before), proposed = objectsById(patched), committed = objectsById(normalized);
  for (const key of new Set([...previous.keys(), ...proposed.keys(), ...committed.keys()])) {
    const old = previous.get(key), next = committed.get(key);
    const entry = (old ?? proposed.get(key) ?? next)!;
    const id = entry.object.id;
    if (objectInWriteScope(scope, scopePages, entry.pageId, id)) continue;
    if (equalEntry(old, next)) continue;
    if (old?.object.type === "electron-mark" && next?.object.type === "electron-mark" && next.object.anchor.kind === "atom") {
      const mark = old.object;
      throw new Error(`refused: placing ${next.object.anchor.objectId} there would attach the unselected ${mark.markKind} mark ${id}` +
        `${mark.markKind === "lone-pair" ? "" : " and change its chemistry"}; choose another position.`);
    }
    throw new Error(`refused: desktop normalization would change or remove unselected ${old?.object.type ?? next?.object.type ?? "object"} ${id}; choose another position.`);
  }
  for (const [key, { object }] of proposed) {
    const id = object.id;
    if (object.type === "molecule" && committed.get(key)?.object.type !== "molecule") {
      throw new Error(`refused: desktop normalization would remove or absorb molecule ${id}; choose another position.`);
    }
  }
  return normalized;
}

/** Legacy scope is page-bound: a selected id grants its selection page's object only. A same-id
 * object on any other page is out of scope, including for normalization side effects (AGENTS.md section 7). */
function assertOffPageDuplicatesUnchanged(before: ChemDraftDocument, after: ChemDraftDocument,
  scopePages: PluginWriteScopePages | undefined): void {
  if (!scopePages?.size) return;
  const offPage = (document: ChemDraftDocument): ObjectEntry[] => document.pages.flatMap(page => page.objects
    .filter(object => { const pinned = scopePages.get(object.id); return pinned !== undefined && pinned !== page.id; })
    .map(object => ({ pageId: page.id, object })));
  const previous = offPage(before), next = offPage(after);
  for (let index = 0; index < Math.max(previous.length, next.length); index++) {
    if (equalEntry(previous[index], next[index])) continue;
    const entry = (previous[index] ?? next[index])!;
    throw new Error(duplicateIdRefusalMessage(before, entry.object.id, scopePages.get(entry.object.id)!, [entry.pageId]));
  }
}

export async function verifyNormalizedAssistantWrite(context: AssistantToolContext, before: ChemDraftDocument,
  patched: ChemDraftDocument, scope: ReadonlySet<string>, expectedSmiles: ReadonlyMap<string, string> = new Map(),
  scopePages?: PluginWriteScopePages
): Promise<ChemDraftDocument> {
  const normalized = normalizeScopedWrite(before, patched, scope, scopePages);
  const previous = objectsById(before), proposed = objectsById(patched), committed = objectsById(normalized);
  // Include normalization's side effects, even when the patch itself only touched text or marks.
  for (const [key, entry] of committed) {
    const molecule = entry.object;
    const id = molecule.id;
    if (molecule.type !== "molecule" || equalEntry(previous.get(key), entry)) continue;
    const source = expectedSmiles.has(id) ? proposed.get(key)?.object : previous.get(key)?.object ?? proposed.get(key)?.object;
    if (source?.type !== "molecule") throw new Error(`refused: cannot verify the chemistry of ${id}.`);
    const charges = (object: MoleculeObject) => object.atoms.map(atom => [atom.id, atom.formalCharge]);
    if (source.atoms.length !== molecule.atoms.length || !equal(charges(source), charges(molecule))) {
      throw new Error(`refused: placing ${id} there would change its atom count or charges during desktop normalization; choose another position.`);
    }
    // Standalone literal groups intentionally have no completed molecular SMILES (e.g. CH3).
    // Preserve their exact native meaning instead of inventing hydrogens/connectivity for RDKit.
    const literalGroup = source.atoms.length === 1 && source.atoms[0]!.labelLiteral && source.bonds.length === 0;
    if (literalGroup && !expectedSmiles.has(id)) {
      const meaning = (object: MoleculeObject) => ({
        atoms: object.atoms.map(({ x: _x, y: _y, ...atom }) => atom), bonds: object.bonds,
        superatoms: object.superatoms, rGroups: object.rGroups, structure: object.structure, chemistry: object.chemistry
      });
      if (!equal(meaning(source), meaning(molecule))) throw new Error(`refused: desktop normalization would change the literal group ${id}.`);
      continue;
    }
    // Restyling an invalid graph must not require parseable SMILES. Only exact native
    // equality can bypass the engine: atom coordinates, labels, charges, isotopes, radicals,
    // bonds and every other source field must match. Normalization may refresh metadata.
    const styleOnlyMeaning = ({ style: _style, chemistry: _chemistry, ...object }: MoleculeObject) =>
      JSON.stringify(object, (_key, value: unknown) => value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
    if (!expectedSmiles.has(id) && previous.get(key)?.object.type === "molecule" &&
        styleOnlyMeaning(source) === styleOnlyMeaning(molecule)) continue;
    const expected = expectedSmiles.get(id);
    if (expected !== undefined) {
      try { await assertCanonical(context, molecule, expected); }
      catch (error) {
        throw new Error(`refused: placing ${id} there would change its canonical isomeric SMILES ` +
          "or atom count " +
          `during desktop normalization: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }
    const input = await inspectMolecule(context, source);
    const output = await inspectMolecule(context, molecule);
    if (!input.identitySmiles || !output.identitySmiles ||
      input.identitySmiles !== output.identitySmiles || input.heavyAtoms !== output.heavyAtoms) {
      throw new Error(`refused: placing ${id} there would change its canonical isomeric SMILES or atom count during desktop normalization; choose another position.`);
    }
  }
  return normalized;
}

/** A gesture may change unrelated objects while inspection awaits RDKit. Recompute the entire
 * commit against the live document, recheck scope, and require every changed molecule to match
 * the one already inspected. This stays synchronous with the history write. */
export function recheckNormalizedAssistantWrite(before: ChemDraftDocument, patched: ChemDraftDocument,
  scope: ReadonlySet<string>, verified: ChemDraftDocument, verifiedBefore: ChemDraftDocument,
  scopePages?: PluginWriteScopePages): ChemDraftDocument {
  const normalized = normalizeScopedWrite(before, patched, scope, scopePages);
  const previous = objectsById(before), inspected = objectsById(verified), baseline = objectsById(verifiedBefore);
  for (const [key, entry] of objectsById(normalized)) {
    if (entry.object.type === "molecule" && !equalEntry(previous.get(key), entry) &&
      (!equalEntry(inspected.get(key), entry) || !equalEntry(previous.get(key), baseline.get(key)))) {
      throw new Error(`refused: the document changed while verifying molecule ${entry.object.id}; read it again and choose another position.`);
    }
  }
  return normalized;
}
