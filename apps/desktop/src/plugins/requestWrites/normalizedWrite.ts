import { changedElectronMarkAssignments, moleculeSmiles, nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import { adoptDerivedDocument, type ChemDraftDocument, type DocumentObject, type MoleculeObject } from "@chemdraft/chem-core";
import { retainedCtabCompatibility, RequestWriteError, type RequestHistory } from "@chemdraft/plugin-host";
import { normalizeCommittedDocument } from "../../documentWorkflow";
import { desktopWriteInspectionContext, inspectMolecule, inspectSmiles, type StructureInspectionContext } from "./structureIdentity";
import { inspectWriteSmiles, stableRecord, verifiedChemicalRecord, verifyStoredSources, withoutGeometry } from "./storedChemistry";
import { ChemistryRefusal, PLUGIN_WRITE_REFUSED, refusalSentence } from "./chemistryRefusal";
import { assertRepeatUnitIdentity } from "./repeatUnitIdentity";

const objectsById = (document: ChemDraftDocument) => new Map(document.pages.flatMap(page =>
  page.objects.map(object => [object.id, { pageId: page.id, object }] as const)));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type ObjectEntry = { pageId: string; object: DocumentObject };
// Patches and normalization share untouched objects. Do not serialize their atom/bond graphs
// just to discover that they are unchanged; retain value comparison for replaced objects.
const equalEntry = (a: ObjectEntry | undefined, b: ObjectEntry | undefined) =>
  a?.pageId === b?.pageId && (a?.object === b?.object || stableRecord(a?.object) === stableRecord(b?.object));

/** Host boundary for every verified request write. Verify the exact desktop commit, not just
 * the patch: charge/radical reconciliation can also mutate unselected neighbouring objects.
 * The caller must recheck normalization inside the synchronous gesture gate. */
export function assertNormalizedWriteScope(before: ChemDraftDocument, patched: ChemDraftDocument,
  normalized: ChemDraftDocument, scope: ReadonlySet<string>): Set<string> {
  const previous = objectsById(before), proposed = objectsById(patched), committed = objectsById(normalized);
  const affectedOwners = new Set<string>();
  for (const [index, page] of normalized.pages.entries()) {
    const original = before.pages[index]!;
    if (original.objects === page.objects) continue;
    assertRepeatUnitIdentity(original, page);
    for (const { from, to } of changedElectronMarkAssignments(original, page)) {
      if (from) affectedOwners.add(from.objectId);
      if (to) affectedOwners.add(to.objectId);
    }
  }
  for (const [id, { object: authored }] of proposed) {
    if (authored.type !== "electron-mark") continue;
    const final = committed.get(id)?.object;
    if (final?.type === "electron-mark" && (stableRecord(authored.anchor) !== stableRecord(final.anchor) ||
        authored.atomAssociation !== final.atomAssociation)) {
      throw new RequestWriteError("chemistry", `Desktop normalization would change the atom associated with electron mark "${id}".`);
    }
  }
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
  return affectedOwners;
}

export async function verifyNormalizedWrite(context: StructureInspectionContext, before: ChemDraftDocument,
  patched: ChemDraftDocument, scope: ReadonlySet<string>, expectedSmiles: ReadonlyMap<string, string> = new Map()
): Promise<ChemDraftDocument> {
  const normalized = normalizeCommittedDocument(patched);
  const affectedOwners = assertNormalizedWriteScope(before, patched, normalized, scope);
  const previous = objectsById(before), proposed = objectsById(patched), committed = objectsById(normalized);
  const stored = new Map<string, MoleculeObject>();
  // Include normalization's side effects, even when the patch itself only touched text or marks.
  for (const [id, entry] of committed) {
    const molecule = entry.object;
    if (molecule.type !== "molecule" || (!affectedOwners.has(id) && equalEntry(previous.get(id), entry) &&
      equalEntry(previous.get(id), proposed.get(id)))) continue;
    const authored = proposed.get(id)?.object;
    const original = previous.get(id)?.object;
    const expected = expectedSmiles.get(id);
    const source = expected === undefined ? original ?? authored : authored;
    if (source?.type !== "molecule" || authored?.type !== "molecule") throw new Error(`refused: cannot verify the chemistry of ${id}.`);
    const charges = (object: MoleculeObject) => object.atoms.map(atom => [atom.id, atom.formalCharge]);
    if (source.atoms.length !== molecule.atoms.length || !equal(charges(source), charges(molecule))) {
      throw new Error(`refused: placing ${id} there would change its atom count or charges during desktop normalization; choose another position.`);
    }
    // Standalone literal groups intentionally have no completed molecular SMILES (e.g. CH3).
    // Preserve their exact native meaning instead of inventing hydrogens/connectivity for RDKit.
    const literalGroup = source.atoms.length === 1 && source.atoms[0]!.labelLiteral && source.bonds.length === 0;
    if (literalGroup && expected === undefined) {
      const literalIdentity = stableRecord(withoutGeometry(source));
      if (literalIdentity !== stableRecord(withoutGeometry(molecule)) || literalIdentity !== stableRecord(withoutGeometry(authored))) {
        throw new Error(`refused: desktop normalization would change the literal group ${id}.`);
      }
      if (!previous.has(id)) {
        // A literal has no completed molecular identity. Check its optional stored spelling
        // and metadata against native drawing semantics before accepting it unchanged.
        const spelling = nativeSingleBondGraphSmiles(molecule.atoms, molecule.bonds);
        const native = nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds);
        const cached = molecule.compatibility?.unknown.smiles;
        if (!equal(authored, molecule) || (molecule.structure && (molecule.structureFormat !== "smiles" || molecule.structure !== spelling)) ||
            (cached !== undefined && cached !== spelling) ||
            Object.entries(molecule.chemistry ?? {}).some(([field, value]) => !equal(native[field as keyof typeof native], value))) {
          throw new Error(`The stored literal group "${id}" does not match its native graph.`);
        }
      }
      continue;
    }
    if (original?.type !== "molecule" && expected === undefined) {
      throw new Error(`Insertion of molecule ${id} requires source SMILES.`);
    }
    // Restyling an invalid graph must not require parseable SMILES. Only exact native
    // equality can bypass the engine: atom coordinates, labels, charges, isotopes, radicals,
    // bonds and every stored chemistry field must match before and after normalization.
    const styleOnlyMeaning = ({ style: _style, ...object }: MoleculeObject) => stableRecord(object);
    if (expected === undefined && original?.type === "molecule" &&
        styleOnlyMeaning(source) === styleOnlyMeaning(molecule) && styleOnlyMeaning(source) === styleOnlyMeaning(authored)) continue;
    // A stored-only molecule has no editable graph to inspect. Its position can change if
    // the entire remaining record matches both the authored and normalized versions.
    if (original?.type === "molecule" && original.structureFormat !== "unknown" && original.structure.trim() &&
        !original.atoms.length && !original.bonds.length) {
      const storedMeaning = ({ x: _x, y: _y, ...object }: MoleculeObject) => stableRecord(object);
      const identity = storedMeaning(original);
      if (expected !== undefined || identity !== storedMeaning(authored) || identity !== storedMeaning(molecule)) {
        throw new Error(`Cannot verify a chemical edit to stored-only molecule "${id}".`);
      }
      continue;
    }
    const graph = await inspectMolecule(context, molecule);
    if (!graph.identitySmiles || !graph.orderedIdentity) throw new Error(`Cannot verify the normalized molecule "${id}".`);
    if (expected !== undefined) {
      const declared = await inspectWriteSmiles(context, expected);
      if (declared.identitySmiles !== graph.identitySmiles || declared.hasStoredGroups !== false ||
          (!equal(authored, molecule) && (await inspectMolecule(context, authored)).orderedIdentity !== graph.orderedIdentity)) {
        throw new Error(`The authored or normalized chemistry of "${id}" differs from the expected structure.`);
      }
    }
    const priorGraph = original?.type === "molecule" ? await inspectMolecule(context, original) : undefined;
    if (original?.type === "molecule" && priorGraph) {
      // Compare the editable graph (including coordinate-defined stereo) AND every retained
      // source/metadata field. The imported source can carry more chemistry than the graph.
      const unchangedGraph = priorGraph.identitySmiles === graph.identitySmiles && priorGraph.orderedIdentity === graph.orderedIdentity;
      if (expected === undefined || unchangedGraph) {
        const identity = (object: MoleculeObject) => stableRecord(withoutGeometry({ ...object, chemistry: original.chemistry }));
        const prior = identity(original);
        if (!unchangedGraph || prior !== identity(authored) || prior !== identity(molecule) ||
            stableRecord(authored.chemistry) !== stableRecord(molecule.chemistry)) {
          throw new Error(`The edit would change the chemistry or retained annotations of "${id}" without a matching chemical edit.`);
        }
        await verifyStoredSources(context, original, { replacementIdentity: expected === undefined ? undefined : graph.identitySmiles });
        // The patch already updated the native coordinates. Keep the complete stored source.
        const compatibility = retainedCtabCompatibility(original, molecule);
        if (stableRecord(original.chemistry) === stableRecord(authored.chemistry)) {
          if (compatibility !== original.compatibility) stored.set(id, { ...molecule, compatibility });
          continue;
        }
        // Some style patches also submit a formula cache. Retain the original cache only if
        // the complete graph and source survive and the independent SMILES fallback verifies.
        const retained = { ...molecule, chemistry: original.chemistry, compatibility };
        if ((await inspectSmiles(context, await moleculeSmiles(retained, 0, [], undefined))).identitySmiles !== graph.identitySmiles) {
          throw new Error(`The exported SMILES would change the chemistry of "${id}".`);
        }
        stored.set(id, retained);
        continue;
      }
    }
    stored.set(id, await verifiedChemicalRecord(context, molecule, graph, original?.type === "molecule" && priorGraph
      ? { molecule: original, graph: priorGraph } : undefined));
  }
  if (!stored.size) return normalized;
  return adoptDerivedDocument(normalized, { ...normalized, pages: normalized.pages.map(page => ({
    ...page, objects: page.objects.map(object => stored.get(object.id) ?? object)
  })) });
}

/** plugin-host rewraps whatever the verifier throws using its message, and it must stay app-free, so a
 * refusal is turned into its plain user sentence here, before it crosses into plugin-host. The full
 * technical text, with the molecule id, goes to the log. */
export const verifyDesktopRequestWrite: RequestHistory["verify"] = async (before, draft, scope, expected, signal) => {
  try {
    return await verifyNormalizedWrite(desktopWriteInspectionContext(signal), before, draft, scope, expected);
  } catch (error) {
    if (!(error instanceof ChemistryRefusal)) throw error;
    console.warn(`${PLUGIN_WRITE_REFUSED}: ${error.detail}`);
    throw new Error(refusalSentence(PLUGIN_WRITE_REFUSED, error.reason));
  }
};
