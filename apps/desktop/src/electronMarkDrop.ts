import { applyPatch, nativeDrawingStyleFromObjectStyle,
  type ChemDraftDocument, type ElectronMarkObject, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { atomDisplayLabel } from "@chemdraft/layout-engine";
import { documentDrawingDefaults, nativeAtomChargeSupportsValence, nativeAtomExternalValence,
  nativeElementFromAtomLabel, phase4Timestamp, type PagePoint } from "@chemdraft/document-workflow-core";
import { electronMarkAtomContribution, electronMarkChemistryChanges, findDocumentObject,
  isEditableNativeMoleculeGraph, moveDocumentObject, nativeChargePlacementPointForAtom, normalizeCommittedDocument,
  type NativeMoleculeDeleteTarget } from "./documentWorkflow";

/** Document-space radius, independent of zoom and of the direct-editing preference. */
export const ELECTRON_MARK_DROP_CAPTURE_BOND_LENGTHS = 0.5;

/** Geometric target shared by the drag highlight and the committed drop, including refused targets. */
export function electronMarkDropTarget(
  document: ChemDraftDocument, point: PagePoint, pageId = document.pages[0]?.id
): NativeMoleculeDeleteTarget | undefined {
  const radius = documentDrawingDefaults(document).bondLengthPx * ELECTRON_MARK_DROP_CAPTURE_BOND_LENGTHS;
  let nearest: NativeMoleculeDeleteTarget | undefined;
  for (const object of document.pages.find(page => page.id === pageId)?.objects ?? []) {
    if (object.type !== "molecule" || !isEditableNativeMoleculeGraph(object)) continue;
    for (const atom of object.atoms) {
      const distanceToPointer = Math.hypot(point.x - atom.x, point.y - atom.y);
      if (distanceToPointer <= radius && (!nearest || distanceToPointer < nearest.distanceToPointer)) {
        nearest = { kind: "atom", objectId: object.id, atomId: atom.id, distanceToPointer };
      }
    }
  }
  return nearest;
}

function associatedAtom(document: ChemDraftDocument, anchor: ElectronMarkObject["anchor"]) {
  const molecule = anchor.kind === "atom" && anchor.objectId ? findDocumentObject(document, anchor.objectId) : undefined;
  const atom = molecule?.type === "molecule" ? molecule.atoms.find(atom => atom.id === anchor.atomId) : undefined;
  return molecule?.type === "molecule" && atom ? { molecule, atom } : undefined;
}

function label({ molecule, atom }: { molecule: MoleculeObject; atom: MoleculeAtom }): string {
  return atomDisplayLabel(atom, molecule.bonds, nativeDrawingStyleFromObjectStyle(molecule.style), molecule.atoms) ?? atom.element;
}

function markName(mark: ElectronMarkObject): string {
  return mark.markKind === "charge" ? (mark.radical ? "Radical ion" : "Charge")
    : mark.markKind === "radical-dot" ? "Radical electron"
    : mark.markKind === "lone-pair" ? "Lone pair" : "Electron mark";
}

export interface ElectronMarkDropResult {
  document: ChemDraftDocument;
  status: string;
  undoLabel: string;
  refused?: boolean;
}

/** A single direct drop. Callers install the already-normalized snapshot once; previews never call this. */
export function dropElectronMark(
  document: ChemDraftDocument, markId: string, position: PagePoint, dropPoint: PagePoint
): ElectronMarkDropResult {
  const mark = findDocumentObject(document, markId);
  if (mark?.type !== "electron-mark") return { document, status: "Electron mark no longer exists", undoLabel: "Move electron mark" };
  const name = markName(mark);
  const source = associatedAtom(document, mark.anchor);
  const pageId = document.pages.find(page => page.objects.some(object => object.id === markId))?.id;
  const target = electronMarkDropTarget(document, dropPoint, pageId);
  const anchor: ElectronMarkObject["anchor"] = target?.kind === "atom"
    ? { kind: "atom", objectId: target.objectId, atomId: target.atomId } : mark.anchor;
  const destination = associatedAtom(document, anchor);
  const transferring = destination && (!source || source.molecule.id !== destination.molecule.id || source.atom.id !== destination.atom.id);
  const contribution = electronMarkAtomContribution(mark);
  const undoLabel = source || destination ? `Move ${name}` : "Move electron mark";
  const refusal = (reason: string): ElectronMarkDropResult => ({ document, undoLabel, refused: true,
    status: `Cannot move ${name}${source ? ` from ${source.atom.element}` : ""}${destination ? ` to ${destination.atom.element}` : ""}: ${reason}` });

  if (transferring && (contribution.charge || contribution.radicals)) {
    // Use the same admission rule as typed charge stacking, including the radical bonding slots.
    // Check removal too: a four-bond N cannot lose its +1 without an explicit bond edit.
    for (const [endpoint, sign] of [[source, -1], [destination, 1]] as const) {
      if (!endpoint) continue;
      const { molecule, atom } = endpoint;
      const element = nativeElementFromAtomLabel(atom.element);
      const charge = atom.formalCharge + sign * contribution.charge;
      const usage = nativeAtomExternalValence(molecule, atom) + sign * contribution.radicals;
      if (element && !nativeAtomChargeSupportsValence(element, usage, charge)) {
        return refusal(`${atom.element} cannot carry formal charge ${charge > 0 ? "+" : ""}${charge} with bond/radical valence ${usage}`);
      }
    }
  }

  let moved = moveDocumentObject(document, markId, position);
  if (destination) {
    moved = applyPatch(moved, { op: "updateObject", objectId: markId,
      changes: { anchor, atomAssociation: "explicit" } }, { now: phase4Timestamp });
  }
  let after = normalizeCommittedDocument(moved, {
    floatingElectronMarkIds: !target && !source ? new Set([markId]) : undefined
  });
  const finalMark = findDocumentObject(after, markId) as ElectronMarkObject;
  const finalDestination = associatedAtom(after, finalMark.anchor);
  if (destination && (!finalDestination || finalDestination.molecule.id !== destination.molecule.id ||
    finalDestination.atom.id !== destination.atom.id)) return refusal("the atom cannot accept this mark's charge or unpaired electrons");
  if (transferring && (contribution.charge || contribution.radicals)) {
    for (const [endpoint, sign] of [[source, -1], [destination, 1]] as const) {
      if (!endpoint) continue;
      const final = associatedAtom(after, { kind: "atom", objectId: endpoint.molecule.id, atomId: endpoint.atom.id });
      if (!final || final.atom.formalCharge !== endpoint.atom.formalCharge + sign * contribution.charge ||
        (final.atom.markRadicals ?? 0) !== (endpoint.atom.markRadicals ?? 0) + sign * contribution.radicals) {
        return refusal("the atom associations could not preserve the existing charges or unpaired electrons");
      }
      const element = nativeElementFromAtomLabel(final.atom.element);
      if (element && !nativeAtomChargeSupportsValence(element, nativeAtomExternalValence(final.molecule, final.atom), final.atom.formalCharge)) {
        return refusal(`${final.atom.element} has unsupported valence after moving this mark`);
      }
    }
  }

  // Only an actual atom drop snaps beside its label. Empty-space drops retain the user's
  // position and existing association. Use reconciled chemistry so OH/NH2 includes the new H.
  if (target && finalDestination) {
    const page = after.pages.find(page => page.id === pageId)!;
    const point = nativeChargePlacementPointForAtom(finalDestination.molecule, finalDestination.atom.id,
      page.objects.filter(object => object.id !== markId), page.width, page.height, finalMark);
    if (point) after = applyPatch(after, { op: "updateObject", objectId: markId,
      changes: { x: point.x - finalMark.width / 2, y: point.y - finalMark.height / 2 } }, { now: phase4Timestamp });
  }

  const anchors = [mark.anchor, finalMark.anchor];
  const chemistryChanges = electronMarkChemistryChanges(document, after, { markIds: [markId], atoms: anchors.flatMap(anchor =>
    anchor.kind === "atom" && anchor.objectId && anchor.atomId ? [{ objectId: anchor.objectId, atomId: anchor.atomId }] : []) });
  const finalSource = source && associatedAtom(after, mark.anchor);
  const endpoints = [finalDestination, finalSource].flatMap(endpoint => endpoint ? [endpoint] : []);
  const changedAtoms = endpoints.filter((endpoint, index, endpoints) =>
    endpoints.findIndex(other => other?.molecule.id === endpoint.molecule.id && other?.atom.id === endpoint.atom.id) === index);
  const chemistry = chemistryChanges.length
    ? ` (${changedAtoms.map(endpoint => `${endpoint.atom.element} now ${label(endpoint)}`).join(", ")})` : "";
  // Status describes the committed associations and chemistry, including any change made by
  // normalization, rather than relying on the intended geometric transfer alone.
  if (finalDestination && (!source || source.molecule.id !== finalDestination.molecule.id || source.atom.id !== finalDestination.atom.id)) {
    return { document: after, undoLabel, status: source
      ? `${name} moved from ${source.atom.element} to ${finalDestination.atom.element}${chemistry}`
      : `${name} attached to ${finalDestination.atom.element}${chemistry}` };
  }
  if (source && !finalDestination && chemistryChanges.length) {
    return { document: after, undoLabel, status: `${name} detached from ${source.atom.element}${chemistry}` };
  }
  return { document: after, undoLabel, status: source
    ? `${name} repositioned on ${source.atom.element}${chemistry}${target ? "" : "; no atom within capture radius"}`
    : `Moved electron mark${chemistry}` };
}
