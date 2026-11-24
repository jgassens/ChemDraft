import { adoptDerivedDocument, type ChemDraftDocument, type DocumentPage, type MoleculeObject } from "@chemdraft/chem-core";
import {
  isEditableNativeMoleculeGraph, nativeAtomChargeSupportsValence, nativeSingleBondGraphMetadata, normalizeNativeMoleculeGeometry
} from "@chemdraft/document-workflow-core";
import { nativeBondOrderResolution, nativeElementFromAtomLabel } from "@chemdraft/layout-engine";
import {
  clearStoredCtabReference, requireUnchangedConnectionPointSource, resolveObjectOnPage, storedCtabReference,
  type PluginHostOptions, type PluginPatchApplicationRequest
} from "@chemdraft/plugin-host";
import { runHandoffGraphInConformerWorker } from "../chemistry3d/client";
import { definedDoubleBonds } from "../chemistry3d/graph";
import { planConnectionPoints, prepareHandoffGraph, reactionMembership } from "./handoffGraph";
import { stableRecord, verifyStoredSources } from "./requestWrites/storedChemistry";
import { desktopWriteInspectionContext } from "./requestWrites/structureIdentity";

type ConnectionPointEdit = NonNullable<PluginPatchApplicationRequest["connectionPointEdit"]>;
const label = "Mark connection points";

function refusal(anchors: readonly string[], reason: string): Error {
  return new Error(`Cannot mark ${anchors.length === 1 ? "anchor" : "anchors"} ${anchors.map(id => `"${id}"`).join(", ")}: ${reason}`);
}

function assertEditable(page: DocumentPage, molecule: MoleculeObject, anchors: readonly string[]): void {
  if (reactionMembership(page, molecule.id).length) throw refusal(anchors, "the molecule belongs to a reaction.");
  if (molecule.superatoms.length) throw refusal(anchors, "the molecule contains a superatom.");
  if (molecule.rGroups.length || !isEditableNativeMoleculeGraph(molecule) ||
      molecule.style.projection === "perspective" || molecule.atoms.some(atom => atom.z !== undefined && atom.z !== 0)) {
    throw refusal(anchors, "the molecule has no editable 2D structure for marking.");
  }
}

function freshIds(existing: readonly { id: string }[], prefix: string, count: number): string[] {
  const used = new Set(existing.map(({ id }) => id));
  const ids: string[] = [];
  for (let i = 1; ids.length < count; i++) {
    const id = `${prefix}-${i}`;
    if (!used.has(id)) ids.push(id);
  }
  return ids;
}

export const buildConnectionPointsPatch: NonNullable<PluginHostOptions["buildConnectionPointsPatch"]> =
  ({ objectId, anchors }, source, page) => {
    assertEditable(page, source, anchors);
    const resolution = nativeBondOrderResolution(source.atoms, source.bonds);
    const seen = new Set<string>();
    for (const id of anchors) {
      const atom = resolution.atomById.get(id);
      if (!atom) throw refusal([id], "there is no drawn atom with that ID.");
      if (seen.has(id)) throw refusal([id], "the anchor was repeated.");
      seen.add(id);
      if (atom.element === "X") throw refusal([id], "the atom is already an X connection point.");
      if (resolution.bondsByAtom.get(id)?.some(bond =>
        resolution.atomById.get(bond.fromAtomId === id ? bond.toAtomId : bond.fromAtomId)?.element === "X")) {
        throw refusal([id], "the atom already bears an X connection point.");
      }
      const element = nativeElementFromAtomLabel(atom.element);
      if (!element) throw refusal([id], `"${atom.element}" is not an editable element at this anchor.`);
      const valence = (resolution.bondOrderUsage.get(id) ?? 0) + (atom.markRadicals ?? 0) + (atom.hydrogenCount ?? 0);
      if (resolution.unresolvedAtomIds.has(id) || !nativeAtomChargeSupportsValence(element, valence + 1, atom.formalCharge)) {
        throw refusal([id], "the atom has no free valence for a new single bond.");
      }
    }
    const points = planConnectionPoints(source, page, anchors);
    const atomIds = freshIds(source.atoms, "connection-point", points.length);
    const bondIds = freshIds(source.bonds, "connection-bond", points.length);
    const atoms = [...source.atoms, ...points.map(({ x, y }, index) =>
      ({ id: atomIds[index]!, element: "X", x, y, formalCharge: 0 }))];
    const bonds = [...source.bonds, ...points.map(({ anchorAtomId }, index) =>
      ({ id: bondIds[index]!, fromAtomId: anchorAtomId, toAtomId: atomIds[index]!, order: "single" as const }))];
    const { x, y, width, height } = normalizeNativeMoleculeGeometry({ ...source, atoms }, source.rotation !== 0);
    return { atomIds, patch: { reason: label, patch: { op: "updateObject", objectId, changes: { x, y, width, height, atoms, bonds } } } };
  };

export function assertConnectionPointSource(document: ChemDraftDocument, { source, pageId, anchors }: ConnectionPointEdit): void {
  const target = requireUnchangedConnectionPointSource(document, pageId, source);
  assertEditable(target.page, target.object, anchors);
}

/** Serialize the same drawn graph the handoff Worker verifies. The temporary selection is local
 * to the verifier, so changing canvas selection while a command runs does not retarget its write. */
function verificationWork(document: ChemDraftDocument, pageId: string, molecule: MoleculeObject) {
  return prepareHandoffGraph({ objectId: molecule.id }, {
    ...document, selection: { pageId, objectIds: [molecule.id] },
    pages: document.pages.map(page => page.id !== pageId ? page :
      { ...page, objects: page.objects.map(object => object.id === molecule.id ? molecule : object) })
  });
}

function preserveAtomAndBondRecords(source: MoleculeObject, draft: MoleculeObject, atomIds: readonly string[]): MoleculeObject {
  const originals = new Map(source.atoms.map(atom => [atom.id, atom]));
  // Generic graph edits discard stale H hints. Existing records in this additive edit
  // keep their stated counts, which the RDKit audit checks again on the product.
  const atoms = draft.atoms.map(atom => {
    const stated = originals.get(atom.id)?.hydrogenCount;
    return stated !== undefined && atom.hydrogenCount === undefined ? { ...atom, hydrogenCount: stated } : atom;
  });
  const assertKept = (original: readonly { id: string }[], updated: readonly { id: string }[], kind: "atom" | "bond") => {
    const byId = new Map(updated.map(record => [record.id, record]));
    if (byId.size !== updated.length || updated.length !== original.length + atomIds.length) {
      throw new Error(`The edit changed the expected ${kind} count.`);
    }
    for (const record of original) {
      if (stableRecord(record) !== stableRecord(byId.get(record.id))) {
        throw new Error(`The edit would change the existing ${kind} record "${record.id}".`);
      }
    }
  };
  assertKept(source.atoms, atoms, "atom");
  assertKept(source.bonds, draft.bonds, "bond");
  return { ...draft, atoms };
}

export async function verifyConnectionPointEdit(before: ChemDraftDocument, draft: ChemDraftDocument,
  { source, pageId, anchors, atomIds }: ConnectionPointEdit, signal = new AbortController().signal): Promise<ChemDraftDocument> {
  const target = resolveObjectOnPage(draft, pageId, source.id);
  if (target?.object.type !== "molecule") throw refusal(anchors, "the edited molecule could not be verified.");
  const added = new Set(atomIds);
  try {
    const molecule = preserveAtomAndBondRecords(source, target.object, atomIds);
    const original = verificationWork(before, pageId, source);
    if (original.sourceAtomMaps.length) throw new Error("The molecule contains retained atom mapping.");
    const existingPoints = original.atoms.flatMap((atom, i) => atom.isConnectionPoint ? [i] : []);
    const context = desktopWriteInspectionContext(signal, existingPoints);
    const unmarked = await runHandoffGraphInConformerWorker(original, signal);
    if (source.structure || source.compatibility?.unknown.smiles !== undefined) {
      const graph = await context.chemistry.inspectStructure("molfile", original.molfile);
      if (!graph.valid) throw new Error(graph.reason);
      await verifyStoredSources(context, source, { reference: storedCtabReference(source),
        requireOrderedCtabIdentity: existingPoints.length > 0,
        graph: { ...graph, molfile: original.molfile, atomIds: original.atoms.map(atom => atom.atomId) } });
    } else {
      await verifyStoredSources(context, source, { replacementIdentity: unmarked.canonicalSmiles });
    }
    const originalById = new Map(unmarked.graph.atoms.map(atom => [atom.atomId, atom]));
    for (const id of anchors) {
      const atom = originalById.get(id);
      const stated = original.atoms.find(atom => atom.atomId === id)?.statedHydrogens ?? 0;
      if (!atom || atom.hydrogenCount <= stated) {
        throw new Error(`Atom "${id}" has no free valence for a new single bond in RDKit.`);
      }
    }
    const markedWork = verificationWork(draft, pageId, molecule);
    const marked = await runHandoffGraphInConformerWorker({ ...markedWork,
      connectionPointStereo: { atomIds, originalSmiles: unmarked.canonicalSmiles,
        specifiedDoubleBonds: definedDoubleBonds(unmarked.graph) } }, signal);
    const anchorIds = new Set(anchors);
    for (const atom of marked.graph.atoms) {
      const old = originalById.get(atom.atomId);
      if (!old) {
        if (!atom.atomId || !added.has(atom.atomId) || !atom.isConnectionPoint || atom.charge || atom.isotope || atom.radicalElectrons) {
          throw new Error(`The new atom "${atom.atomId}" is no longer a neutral X connection point.`);
        }
      } else if (atom.element !== old.element || atom.charge !== old.charge || atom.isotope !== old.isotope ||
          atom.hydrogenCount !== old.hydrogenCount - Number(atom.atomId !== undefined && anchorIds.has(atom.atomId)) ||
          atom.radicalElectrons !== old.radicalElectrons) {
        throw new Error(`Adding X would change the chemical state at atom "${atom.atomId}".`);
      }
    }
    signal.throwIfAborted();
    const compatibility = clearStoredCtabReference(molecule.compatibility);
    const metadata = nativeSingleBondGraphMetadata(molecule.atoms, molecule.bonds);
    const warnings = new Map([...metadata.warnings, ...(source.chemistry?.warnings ?? [])]
      .map(warning => [stableRecord(warning), warning]));
    const verified = { ...molecule, structure: markedWork.molfile, structureFormat: "molfile-v2000" as const,
      chemistry: { ...metadata, isotopeLabels: source.chemistry?.isotopeLabels ?? metadata.isotopeLabels,
        stereochemistry: source.chemistry?.stereochemistry ?? [], warnings: [...warnings.values()] },
      ...(compatibility && { compatibility: "smiles" in compatibility.unknown
        ? { ...compatibility, unknown: { ...compatibility.unknown, smiles: marked.canonicalSmiles } } : compatibility }) };
    return adoptDerivedDocument(draft, { ...draft, pages: draft.pages.map(page => page.id !== pageId ? page :
      { ...page, objects: page.objects.map(object => object === target.object ? verified : object) }) });
  } catch (error) {
    signal.throwIfAborted();
    throw refusal(anchors, error instanceof Error ? error.message : String(error));
  }
}

/** The page-fit path may translate the verified graph. Reject any normalization that changes its
 * chemical fields after the asynchronous check. */
export function assertVerifiedConnectionPointEdit(before: ChemDraftDocument, after: ChemDraftDocument,
  { source, pageId, anchors }: ConnectionPointEdit): void {
  const graph = (document: ChemDraftDocument) => {
    const object = resolveObjectOnPage(document, pageId, source.id)?.object;
    if (object?.type !== "molecule") return undefined;
    const { x: _x, y: _y, atoms, ...record } = object;
    return { ...record, atoms: atoms.map(({ x: _atomX, y: _atomY, ...atom }) => atom) };
  };
  if (stableRecord(graph(before)) !== stableRecord(graph(after))) throw refusal(anchors, "commit normalization changed the verified graph.");
}
