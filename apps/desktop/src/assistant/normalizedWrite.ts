import type { ChemDraftDocument, DocumentObject, MoleculeObject } from "@chemdraft/chem-core";
import { normalizeCommittedDocument } from "../documentWorkflow";
import type { AssistantToolContext } from "./AssistantToolContext";
import { inspectMolecule, inspectSmiles } from "./writeBuilder";

const objectsById = (document: ChemDraftDocument) => new Map(document.pages.flatMap(page =>
  page.objects.map(object => [object.id, { pageId: page.id, object }] as const)));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type ObjectEntry = { pageId: string; object: DocumentObject };
// Patches and normalization share untouched objects. Do not serialize their atom/bond graphs
// just to discover that they are unchanged; retain value comparison for replaced objects.
const equalEntry = (a: ObjectEntry | undefined, b: ObjectEntry | undefined) =>
  (a?.pageId === b?.pageId && a?.object === b?.object) || equal(a, b);

/** Host boundary for every assistant tool write. Verify the exact desktop commit, not just
 * the patch: charge/radical reconciliation can also mutate unselected neighbouring objects.
 * The caller must recheck normalization inside the synchronous gesture gate. */
function normalizeScopedWrite(before: ChemDraftDocument, patched: ChemDraftDocument, scope: ReadonlySet<string>): ChemDraftDocument {
  const normalized = normalizeCommittedDocument(patched);
  const previous = objectsById(before), proposed = objectsById(patched), committed = objectsById(normalized);
  for (const id of new Set([...previous.keys(), ...proposed.keys(), ...committed.keys()])) {
    if (scope.has(id)) continue;
    const old = previous.get(id), next = committed.get(id);
    if (equalEntry(old, next)) continue;
    if (old?.object.type === "electron-mark" && next?.object.type === "electron-mark" && next.object.anchor.kind === "atom") {
      const mark = old.object;
      throw new Error(`refused: placing ${next.object.anchor.objectId} there would attach the unselected ${mark.markKind} mark ${id}` +
        `${mark.markKind === "lone-pair" ? "" : " and change its chemistry"}; choose another position.`);
    }
    throw new Error(`refused: desktop normalization would change or remove unselected ${old?.object.type ?? next?.object.type ?? "object"} ${id}; choose another position.`);
  }
  for (const [id, { object }] of proposed) {
    if (object.type === "molecule" && committed.get(id)?.object.type !== "molecule") {
      throw new Error(`refused: desktop normalization would remove or absorb molecule ${id}; choose another position.`);
    }
  }
  return normalized;
}

export async function verifyNormalizedAssistantWrite(context: AssistantToolContext, before: ChemDraftDocument,
  patched: ChemDraftDocument, scope: ReadonlySet<string>, expectedSmiles: ReadonlyMap<string, string> = new Map()
): Promise<ChemDraftDocument> {
  const normalized = normalizeScopedWrite(before, patched, scope);
  const previous = objectsById(before), proposed = objectsById(patched), committed = objectsById(normalized);
  // Include normalization's side effects, even when the patch itself only touched text or marks.
  for (const [id, entry] of committed) {
    const molecule = entry.object;
    if (molecule.type !== "molecule" || equalEntry(previous.get(id), entry)) continue;
    const source = expectedSmiles.has(id) ? proposed.get(id)?.object : previous.get(id)?.object ?? proposed.get(id)?.object;
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
    const expected = expectedSmiles.get(id);
    const input = expected === undefined ? await inspectMolecule(context, source) : await inspectSmiles(context, expected);
    const output = await inspectMolecule(context, molecule);
    if (input.canonicalSmiles !== output.canonicalSmiles || input.heavyAtoms !== output.heavyAtoms) {
      throw new Error(`refused: placing ${id} there would change its canonical isomeric SMILES or atom count during desktop normalization; choose another position.`);
    }
  }
  return normalized;
}

/** A gesture may change unrelated objects while inspection awaits RDKit. Recompute the entire
 * commit against the live document, recheck scope, and require every changed molecule to match
 * the one already inspected. This stays synchronous with the history write. */
export function recheckNormalizedAssistantWrite(before: ChemDraftDocument, patched: ChemDraftDocument,
  scope: ReadonlySet<string>, verified: ChemDraftDocument, verifiedBefore: ChemDraftDocument): ChemDraftDocument {
  const normalized = normalizeScopedWrite(before, patched, scope);
  const previous = objectsById(before), inspected = objectsById(verified), baseline = objectsById(verifiedBefore);
  for (const [id, entry] of objectsById(normalized)) {
    if (entry.object.type === "molecule" && !equalEntry(previous.get(id), entry) &&
      (!equalEntry(inspected.get(id), entry) || !equalEntry(previous.get(id), baseline.get(id)))) {
      throw new Error(`refused: the document changed while verifying molecule ${id}; read it again and choose another position.`);
    }
  }
  return normalized;
}
