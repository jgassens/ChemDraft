import {
  adoptDerivedDocument,
  applyPatch,
  applyPatches,
  isDativeBond,
  type ApplyPatchOptions,
  type ChemDraftDocument,
  type DocumentObject,
  type MoleculeObject
} from "@chemdraft/chem-core";
import {
  AppliedPatchReceiptSchema,
  type AppliedPatchReceipt,
  type NormalizedProposedDocumentPatch
} from "@chemdraft/plugin-api";
import { assertPluginDocumentWriteScope, rebasePluginPatch, storedCtabReference, writePatchOps } from "@chemdraft/plugin-host";
import { selectionBounds, translateInsertedDocumentObjects } from "../documentWorkflow";
import { choosePlacement, objectRect, overlaps as boundsOverlap, pageContentRect, RELATIVE_GAP, unionRects } from "../assistant/placement";
import type { ViewportRect } from "@chemdraft/viewport-engine";
import { nativeSingleBondGraphMetadata, tryNativeSingleBondGraphSmiles } from "@chemdraft/document-workflow-core";
import { nativeElementFromAtomLabel } from "@chemdraft/layout-engine";
import { refreshVerifiedMoleculeChemistry, stableRecord, verifiedChemicalRecord, verifyStoredSources } from "./requestWrites/storedChemistry";
import { desktopWriteInspectionContext, inspectMolecule } from "./requestWrites/structureIdentity";

export interface PluginPatchPlacementOptions extends ApplyPatchOptions {
  /** Page-space visible rectangle, read when the write actually commits (after gesture gating). */
  insertionTarget?: { pageId: string; bounds?: { x: number; y: number; width: number; height: number } };
  /** Host policy for name results, whose default page-centre position is not user-authored. */
  avoidInsertionOverlap?: boolean;
}

export interface AppliedPluginDocumentPatch {
  document: ChemDraftDocument;
  receipt: AppliedPatchReceipt;
}

/** Match draft molecules with the graphs they had before the batch's updates.
 * Reviewed proposals are authorized by acceptance and have no command selection scope. */
export function refreshPluginPatchChemistry(before: ChemDraftDocument, draft: ChemDraftDocument,
  rebased: NormalizedProposedDocumentPatch, writeScopeObjectIds?: readonly string[], signal?: AbortSignal
): Promise<ChemDraftDocument> | undefined {
  const scope = writeScopeObjectIds && new Set(writeScopeObjectIds);
  const inserted = new Set<string>();
  const atomUpdates = new Set<string>();
  const positions = writePatchOps(rebased.patch).filter(op => {
    if (op.op === "addObject") inserted.add(op.object.id);
    if (op.op === "updateObject" && "atoms" in op.changes) atomUpdates.add(op.objectId);
    return op.op === "addObject" || op.op === "addAnnotation" || op.op === "removeObject" ||
      op.op === "removeAnnotation" || op.op === "reorderObject" || op.op === "setObjectOrder";
  });
  // Replay ordering and membership changes so molecule slots identify the same occurrence,
  // even if a batch reordered duplicate ids or edited a molecule it had just inserted.
  const baseline = positions.length ? applyPatches(before, positions, {
    preserveRepeatUnitBrackets: true, deferGroupCleanup: true, now: draft.updatedAt
  }) : before;
  const context = desktopWriteInspectionContext(signal);
  const edits: Promise<void>[] = [];
  const pages = draft.pages.map((page, pageIndex) => {
    // Reviewed edits can also remove orphaned brackets and groups during patch application.
    const prior = baseline.pages[pageIndex]!.objects.filter(object => object.type === "molecule");
    let moleculeIndex = 0;
    let objects = page.objects;
    for (const [index, object] of page.objects.entries()) {
      if (object.type !== "molecule") continue;
      const previous = prior[moleculeIndex++];
      const isInsertion = inserted.has(object.id);
      if (previous?.id !== object.id || (scope && !isInsertion && !scope.has(object.id))) continue;
      const verifyInsertion = !!scope && isInsertion;
      // An authored atom move can change 2D stereo, but only where geometry defines stereo, and
      // never when every atom moved together keeping every stereo side. Host placement
      // translates an insertion as a unit.
      const graphChanged = object !== previous && (graphSignature(previous) !== graphSignature(object) ||
        atomUpdates.has(object.id) && hasGeometryStereo(object) &&
        !(movedAsUnit(previous, object) && keptStereoSides(previous, object)));
      if (!verifyInsertion && !graphChanged) continue;
      // Records the canvas itself derives from this graph cannot disagree with it.
      if (verifyInsertion && !graphChanged && storesNativeDerivation(object)) continue;
      // Give existing scope refusals priority over chemistry inspection of a draft that cannot commit.
      if (!edits.length && writeScopeObjectIds) assertPluginDocumentWriteScope(before, draft, rebased, writeScopeObjectIds);
      if (objects === page.objects) objects = [...objects];
      edits.push((async () => {
        try {
          if (!object.atoms.length) throw new Error("The molecule has no editable atoms to verify.");
          if (verifyInsertion && !graphChanged) {
            // Verification only: an insertion that matches its graph keeps its records as authored.
            const insertion = withoutBracketContext(object);
            await verifiedChemicalRecord(context, insertion, await inspectMolecule(context, insertion));
            return;
          }
          const original = withoutBracketContext(previous);
          if (verifyInsertion) {
            await verifiedChemicalRecord(context, original, await inspectMolecule(context, original));
          } else if (previous.structure || previous.compatibility?.unknown.smiles !== undefined) {
            const graph = await inspectMolecule(context, original);
            await verifyStoredSources(context, previous, { graph, reference: storedCtabReference(previous) });
          }
          const graph = await inspectMolecule(context, withoutBracketContext(object));
          await verifyStoredSources(context, object, { graph, alreadyVerified: previous });
          const refreshed = refreshVerifiedMoleculeChemistry(object, graph, previous.structureFormat);
          if (refreshed.structureFormat === "molfile-v3000") await verifyStoredSources(context, refreshed, { graph });
          objects[index] = refreshed;
        } catch (error) {
          signal?.throwIfAborted();
          throw new Error(`Plugin write refused: cannot refresh stored chemistry for molecule "${object.id}". ${describePatchFailure(error)}`);
        }
      })());
    }
    return objects === page.objects ? page : { ...page, objects };
  });
  if (edits.length) return Promise.all(edits).then(() => adoptDerivedDocument(draft, { ...draft, pages }));
}

function graphSignature(molecule: MoleculeObject): string {
  return JSON.stringify([
    molecule.atoms.map(atom => JSON.stringify([atom.id, atom.element, atom.formalCharge, atom.isotope,
      atom.markRadicals, atom.schemeAbbreviation, atom.labelLiteral, atom.hydrogenCount,
      atom.labelBondSide?.side, atom.labelBondSide?.atomId])).sort(),
    molecule.bonds.map(bond => {
      const style = bond.display?.bondStyle;
      const stereo = bond.order === "single" && (style === "wedge" || style === "hashed" || style === "wavy") ? style : undefined;
      const dative = isDativeBond(bond);
      const endpoints = [bond.fromAtomId, bond.toAtomId];
      if (!stereo && !dative) endpoints.sort();
      return JSON.stringify([endpoints, bond.order, bond.stereo, stereo, dative]);
    }).sort()
  ]);
}

/** 2D coordinates define stereo only through wedges and hashes, or across a double bond whose
 * ends both carry another substituent. Elsewhere a coordinate change cannot change chemistry. */
function hasGeometryStereo({ bonds }: MoleculeObject): boolean {
  const degree = new Map<string, number>();
  for (const bond of bonds) {
    for (const id of [bond.fromAtomId, bond.toAtomId]) degree.set(id, (degree.get(id) ?? 0) + 1);
  }
  return bonds.some(bond => bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed" ||
    bond.order === "double" && degree.get(bond.fromAtomId)! > 1 && degree.get(bond.toAtomId)! > 1);
}

/** True when the same atoms moved by one translation, rotation and uniform scale. Such a move
 * keeps every wedge's handedness and every double bond's sides; a reflection or a reshaped
 * molecule does not count. */
function movedAsUnit(before: MoleculeObject, after: MoleculeObject): boolean {
  const start = new Map(before.atoms.map(atom => [atom.id, atom]));
  const pairs = after.atoms.map(atom => [start.get(atom.id), atom] as const);
  if (pairs.length !== start.size || pairs.some(([from]) => !from)) return false;
  if (!pairs.length) return true;
  const centre = (points: readonly { x: number; y: number }[]) => ({
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length
  });
  const a = centre(pairs.map(([from]) => from!)), b = centre(pairs.map(([, to]) => to));
  const offsets = pairs.map(([from, to]) => ({ ux: from!.x - a.x, uy: from!.y - a.y, vx: to.x - b.x, vy: to.y - b.y }));
  // The least-squares similarity maps u to z·u, with z = Σ v·conj(u) / Σ |u|² as a complex number.
  let spread = 0, real = 0, imaginary = 0, extent = 0;
  for (const { ux, uy, vx, vy } of offsets) {
    spread += ux * ux + uy * uy;
    real += vx * ux + vy * uy;
    imaginary += vy * ux - vx * uy;
    extent = Math.max(extent, Math.hypot(ux, uy), Math.hypot(vx, vy));
  }
  const tolerance = 1e-6 * Math.max(1, extent);
  if (!(spread > 0)) return offsets.every(({ vx, vy }) => Math.hypot(vx, vy) <= tolerance);
  const zx = real / spread, zy = imaginary / spread;
  if (!(Math.hypot(zx, zy) > 1e-9)) return false;
  return offsets.every(({ ux, uy, vx, vy }) => Math.hypot(vx - (zx * ux - zy * uy), vy - (zx * uy + zy * ux)) <= tolerance);
}

/** Smallest |sin| of the angle between a stereo bond and its reference that still reads as a side.
 * Fixed rather than scaled by the molecule's size, so a near-collinear substituent never counts as
 * kept, however large the drawing. */
const STEREO_SIDE_EPSILON = 1e-3;

/** True when every orientation that 2D geometry gives stereo is clearly the same before and after:
 * each substituent's side of a stereo double bond, and the turn between each pair of neighbours of
 * a wedged or hashed bond's atoms. `movedAsUnit` alone allows a residual that grows with the
 * molecule's extent, which can hide a substituent crossing an axis; this check cannot. */
function keptStereoSides(before: MoleculeObject, after: MoleculeObject): boolean {
  const start = new Map(before.atoms.map(atom => [atom.id, atom]));
  const end = new Map(after.atoms.map(atom => [atom.id, atom]));
  const neighbours = new Map<string, string[]>();
  for (const bond of after.bonds) {
    neighbours.set(bond.fromAtomId, [...neighbours.get(bond.fromAtomId) ?? [], bond.toAtomId]);
    neighbours.set(bond.toAtomId, [...neighbours.get(bond.toAtomId) ?? [], bond.fromAtomId]);
  }
  // +1 or -1 for the side of `other` relative to the ray from `centre` to `reference`, 0 if degenerate.
  const side = (atoms: typeof start, centre: string, reference: string, other: string) => {
    const c = atoms.get(centre), r = atoms.get(reference), o = atoms.get(other);
    if (!c || !r || !o) return 0;
    const rx = r.x - c.x, ry = r.y - c.y, ox = o.x - c.x, oy = o.y - c.y;
    const lengths = Math.hypot(rx, ry) * Math.hypot(ox, oy);
    if (!(lengths > 0) || !Number.isFinite(lengths)) return 0;
    const sine = (rx * oy - ry * ox) / lengths;
    return Math.abs(sine) >= STEREO_SIDE_EPSILON ? Math.sign(sine) : 0;
  };
  const kept = (centre: string, reference: string, other: string) => {
    const was = side(start, centre, reference, other);
    return was !== 0 && was === side(end, centre, reference, other);
  };
  for (const bond of after.bonds) {
    const ends = [bond.fromAtomId, bond.toAtomId] as const;
    if (bond.order === "double") {
      const substituents = ends.map((centre, index) => (neighbours.get(centre) ?? []).filter(id => id !== ends[1 - index]));
      if (substituents.every(list => list.length) && ends.some((centre, index) =>
        substituents[index]!.some(other => !kept(centre, ends[1 - index]!, other)))) return false;
    }
    if (bond.display?.bondStyle === "wedge" || bond.display?.bondStyle === "hashed") {
      for (const centre of ends) {
        const around = neighbours.get(centre) ?? [];
        for (let i = 0; i < around.length; i++) {
          for (let j = i + 1; j < around.length; j++) if (!kept(centre, around[i]!, around[j]!)) return false;
        }
      }
    }
  }
  return true;
}

/** chem-core regenerates this page-context note on every commit. It does not describe the graph:
 * the stored chemistry of a repeat-unit member is that of the one drawn copy. */
function withoutBracketContext(molecule: MoleculeObject): MoleculeObject {
  const warnings = molecule.chemistry?.warnings;
  if (!warnings?.some(warning => warning.code === "chemistry.bracket_multiplier")) return molecule;
  return { ...molecule, chemistry: { ...molecule.chemistry!,
    warnings: warnings.filter(warning => warning.code !== "chemistry.bracket_multiplier") } };
}

/** The structure, cached SMILES and chemistry are exactly what the canvas derives from this graph
 * (`refreshNativeSingleBondGraph`), so they cannot be stale. Limited to plain elements with no
 * radicals, no unusual bonds and no geometry-defined stereo, which the native writer cannot record. */
function storesNativeDerivation(molecule: MoleculeObject): boolean {
  const { atoms, bonds } = molecule;
  if (!atoms.length || molecule.superatoms.length || molecule.rGroups.length || molecule.structureFormat !== "smiles") return false;
  if (atoms.some(atom => atom.labelLiteral || atom.schemeAbbreviation || atom.markRadicals || !nativeElementFromAtomLabel(atom.element))) {
    return false;
  }
  if (bonds.some(bond => bond.stereo !== undefined || bond.display?.bondStyle === "wavy" || isDativeBond(bond) ||
      (bond.order !== "single" && bond.order !== "double" && bond.order !== "triple")) || hasGeometryStereo(molecule)) {
    return false;
  }
  const native = tryNativeSingleBondGraphSmiles(atoms, bonds);
  if (!("smiles" in native) || !native.smiles || native.smiles !== molecule.structure) return false;
  const retained = molecule.compatibility?.unknown ?? {};
  if (Object.keys(retained).some(key => key !== "smiles") ||
      (retained.smiles !== undefined && retained.smiles !== molecule.structure)) return false;
  return !molecule.chemistry ||
    stableRecord(withoutBracketContext(molecule).chemistry) === stableRecord(nativeSingleBondGraphMetadata(atoms, bonds));
}

/**
 * Apply a validated plugin patch through chem-core, then select surviving inserted and changed objects.
 * Insertion, placement and selection are assembled before the caller commits the returned document,
 * so the desktop records exactly one history entry per plugin applyPatch call.
 */
export function applyPluginDocumentPatch(
  document: ChemDraftDocument,
  proposed: NormalizedProposedDocumentPatch,
  options: PluginPatchPlacementOptions = {}
): AppliedPluginDocumentPatch {
  const now = options.now ?? new Date();
  proposed = rebasePluginPatch(document, proposed, false);
  let patched = applyPatch(document, proposed.patch, { preserveRepeatUnitBrackets: true, deferGroupCleanup: true, ...options, now });
  const inserted = new Set(writePatchOps(proposed.patch).flatMap(op => op.op === "addObject" ? [op.object.id] :
    op.op === "addAnnotation" ? [op.annotation.id] : []));
  const existingIds = new Set(document.pages.flatMap(page => page.objects.map(object => object.id)));
  // Placement, insertion and selection are all prepared before the ONE history commit.
  // Measure the surviving inserted group after all batch edits, and preserve its relative layout.
  for (const page of patched.pages) {
    if (options.avoidInsertionOverlap) {
      patched = placeInsertedObjectsInFreeSpace(patched, page.id, [...inserted]);
      continue;
    }
    const objects = page.objects.filter(object => inserted.has(object.id));
    // Moving even one member away from an existing anchor can detach a charge or warp an
    // arrow. Preserve the entire authored group, including off-page and oversized groups.
    if (objects.some(object => referencesExistingObject(object, existingIds))) continue;
    const bounds = pluginInsertionBounds(objects);
    if (!bounds) continue;
    const outside = bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > page.width || bounds.y + bounds.height > page.height;
    if (!outside) continue;
    if (bounds.width > page.width || bounds.height > page.height) {
      // Preserve authored geometry. The desktop's shared pre-commit question offers growth,
      // or keeps this exact placement on the existing page, as one history entry either way.
      continue;
    }
    const overlaps = bounds.x < page.width && bounds.y < page.height &&
      bounds.x + bounds.width > 0 && bounds.y + bounds.height > 0;
    // Keep partially visible drawings as close as possible to their authored position.
    let x = Math.max(0, Math.min(page.width - bounds.width, bounds.x));
    let y = Math.max(0, Math.min(page.height - bounds.height, bounds.y));
    if (!overlaps) {
      const target = options.insertionTarget?.pageId === page.id ? options.insertionTarget : undefined;
      const visible = target?.bounds;
      const left = Math.max(0, visible?.x ?? 0);
      const top = Math.max(0, visible?.y ?? 0);
      const right = Math.min(page.width, visible ? visible.x + visible.width : page.width);
      const bottom = Math.min(page.height, visible ? visible.y + visible.height : page.height);
      const centerX = right > left ? (left + right) / 2 : page.width / 2;
      const centerY = bottom > top ? (top + bottom) / 2 : page.height / 2;
      x = Math.max(0, Math.min(page.width - bounds.width, centerX - bounds.width / 2));
      y = Math.max(0, Math.min(page.height - bounds.height, centerY - bounds.height / 2));
    }
    patched = translateInsertedDocumentObjects(patched, objects.map(object => object.id), x - bounds.x, y - bounds.y);
  }
  const touched = new Set<string>();
  for (const op of writePatchOps(proposed.patch)) {
    switch (op.op) {
      case "addObject": touched.add(op.object.id); break;
      case "addAnnotation": touched.add(op.annotation.id); break;
      case "updateObject":
      case "moveObject":
      case "reorderObject": touched.add(op.objectId); break;
      case "setObjectOrder": op.objectIds.forEach((id) => touched.add(id)); break;
    }
  }
  const objectIds = patched.pages.flatMap((page) =>
    page.objects.filter((object) => touched.has(object.id)).map((object) => object.id)
  );

  let selected = patched;
  if (objectIds.length > 0) {
    const page = patched.pages.find((candidate) =>
      objectIds.every((objectId) => candidate.objects.some((object) => object.id === objectId))
    );
    if (page) {
      selected = applyPatch(
        patched,
        { op: "setSelection", pageId: page.id, objectIds },
        { ...options, now }
      );
    }
  } else {
    selected = applyPatch(patched, { op: "setSelection", objectIds: [] }, { ...options, now });
  }

  return {
    document: selected,
    receipt: AppliedPatchReceiptSchema.parse({ applied: true, objectIds })
  };
}

/** Move an overlapping inserted group together, only when free space fits on this page. */
export function placeInsertedObjectsInFreeSpace(
  document: ChemDraftDocument,
  pageId: string,
  insertedIds: readonly string[],
  options: { viewport?: ViewportRect; covered?: readonly ViewportRect[] } = {}
): ChemDraftDocument {
  const page = document.pages.find(candidate => candidate.id === pageId);
  if (!page) return document;
  const inserted = new Set(insertedIds);
  const objects = page.objects.filter(object => inserted.has(object.id));
  const existingIds = new Set(document.pages.flatMap(candidate =>
    candidate.objects.filter(object => !inserted.has(object.id)).map(object => object.id)));
  // Keep anchored groups intact rather than detach them from existing content.
  if (objects.some(object => referencesExistingObject(object, existingIds))) return document;
  const bounds = pluginInsertionBounds(objects);
  if (!bounds) return document;
  const occupied = [...page.objects.filter(object => !inserted.has(object.id)).map(objectRect), ...(options.covered ?? [])];
  const visibleBounds = unionRects([bounds, ...objects.map(objectRect)]);
  const content = pageContentRect(page);
  const viewport = options.viewport;
  const left = Math.max(content.x, viewport?.x ?? 0);
  const top = Math.max(content.y, viewport?.y ?? 0);
  const right = Math.min(content.x + content.width, viewport ? viewport.x + viewport.width : page.width);
  const bottom = Math.min(content.y + content.height, viewport ? viewport.y + viewport.height : page.height);
  if (right <= left || bottom <= top) return document;
  const withinVisible = visibleBounds.x >= left && visibleBounds.y >= top &&
    visibleBounds.x + visibleBounds.width <= right && visibleBounds.y + visibleBounds.height <= bottom;
  if (!occupied.some(other => boundsOverlap(visibleBounds, other)) && (!viewport || withinVisible)) return document;
  const placement = choosePlacement({ page: { ...page,
    margin: { left, top, right: page.width - right, bottom: page.height - bottom } }, size: visibleBounds, occupied,
    preferred: visibleBounds, gap: RELATIVE_GAP });
  // Never grow the page or move the view to make room. A full/covered viewport retains the insert.
  if (!placement.fits) return document;
  return translateInsertedDocumentObjects(document, objects.map(object => object.id),
    placement.rect.x - visibleBounds.x, placement.rect.y - visibleBounds.y);
}

/** Keep existing object bounds, but never trust a molecule frame to enclose its atoms. */
function pluginInsertionBounds(objects: readonly DocumentObject[]) {
  const bounds = selectionBounds(objects, objects.map(object => object.id));
  if (!bounds) return undefined;
  let left = bounds.x;
  let top = bounds.y;
  let right = bounds.x + bounds.width;
  let bottom = bounds.y + bounds.height;
  for (const object of objects) {
    if (object.type !== "molecule") continue;
    for (const atom of object.atoms) {
      left = Math.min(left, atom.x);
      top = Math.min(top, atom.y);
      right = Math.max(right, atom.x);
      bottom = Math.max(bottom, atom.y);
    }
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Native placement references only; opaque chemistry, text and plugin metadata are not anchors. */
function referencesExistingObject(object: DocumentObject, existingIds: ReadonlySet<string>): boolean {
  const references: Array<string | undefined> = [];
  if (object.type === "text") references.push(object.arrowAttachment?.parentObjectId);
  switch (object.type) {
    case "reaction-arrow":
      references.push(object.start.objectId, object.end.objectId, ...object.labels);
      break;
    case "mechanism-arrow":
      references.push(object.source.objectId, object.target.objectId);
      break;
    case "electron-mark": references.push(object.anchor.objectId); break;
    case "reaction":
      references.push(...object.components.map(component => component.objectId), ...object.conditionsTextObjectIds,
        ...(object.arrowObjectIds ?? []), ...(object.plusObjectIds ?? []));
      break;
    case "bracket":
      references.push(...object.containedObjectIds, ...(object.crossingBondIds ?? []).map(ref => ref.objectId));
      break;
    case "group": references.push(...object.childObjectIds); break;
    case "annotation": references.push(...object.targetObjectIds); break;
    case "superatom": references.push(...object.metadata.attachmentPoints.map(anchor => anchor.objectId)); break;
    case "r-group-label": references.push(...object.display.attachmentPoints.map(anchor => anchor.objectId)); break;
    case "molecule":
      references.push(...[...object.superatoms, ...object.rGroups].flatMap(group => group.attachmentPoints.map(anchor => anchor.objectId)));
      break;
  }
  return references.some(id => id !== undefined && existingIds.has(id));
}

/**
 * One plain sentence for why a plugin patch could not be applied. A schema failure arrives as a Zod
 * error whose message is its whole issue list in JSON — unreadable in a one-line status — so name the
 * first issue by its path instead.
 */
export function describePatchFailure(error: unknown): string {
  const issues = (error as { issues?: unknown } | null)?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    const [first] = issues as { path?: unknown; message?: unknown }[];
    const path = Array.isArray(first?.path) ? first.path.join(".") : "";
    const detail = typeof first?.message === "string" ? first.message : "invalid value";
    return `the proposed structure is not valid (${path ? `${path}: ` : ""}${detail})`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0]!.replace(/\.$/, "") || "unknown error";
}

/**
 * A USER-accepted proposal, laid onto the document it is accepted into. A proposal is laid out against
 * the document that was active when it was made — its page id, its object id, a position centred on that
 * page — and the user may accept it later, in another document. Applied verbatim, it then fails forever
 * ("object mol_ocsr_004 already exists") or names a page that does not exist here.
 *
 * So an insertion whose object id is taken gets a fresh one, and an insertion onto a page this document
 * does not have goes onto its first page, a molecule re-centred there. Nothing else changes: atoms,
 * bonds, charges, stereo and every other chemical field are carried over exactly (AGENTS.md §7).
 * Direct writes also rebase colliding ids, but must target an existing page.
 */
export function applyAcceptedPluginProposal(
  document: ChemDraftDocument,
  proposed: NormalizedProposedDocumentPatch,
  options: ApplyPatchOptions = {}
): AppliedPluginDocumentPatch {
  return applyPluginDocumentPatch(document, rebaseProposedInsertion(document, proposed), {
    preserveRepeatUnitBrackets: false, deferGroupCleanup: false, ...options
  });
}

/** The proposal with its insertion re-targeted at `document` (see `applyAcceptedPluginProposal`). */
export function rebaseProposedInsertion(
  document: ChemDraftDocument,
  proposed: NormalizedProposedDocumentPatch
): NormalizedProposedDocumentPatch {
  return rebasePluginPatch(document, proposed, true);
}

/**
 * Plugin document writes that must wait for a canvas gesture to finish. A drag (and every gesture like
 * it) previews from a snapshot taken when it started and commits `snapshot → result` as one undo entry;
 * a write committed in the middle is overwritten by the next preview frame and dropped from the history
 * by the commit, while the plugin was told it was applied. Deferring the write until the gesture has
 * committed or cancelled keeps both: the gesture's entry, then the write's own entry on top of it.
 *
 * The gate asks `isGestureActive` rather than being told when each of the many gestures ends, so a new
 * gesture needs no wiring here. It re-checks after every `flush()` (the host calls it on pointer and key
 * release) and on a short timer while anything is waiting, and runs nothing when idle.
 */
export interface PluginWriteGate {
  /** Runs `apply` now when no gesture is active; otherwise queues it, in order, until one is not. The
   *  promise settles with `apply`'s result (or its error) only once it has actually run. */
  run<T>(apply: () => T): Promise<T>;
  /** Runs what is queued if no gesture is active any more. */
  flush(): void;
  /** How many writes are waiting. */
  pending(): number;
  /** Stops the timer; queued writes are rejected (the window is going away). */
  dispose(): void;
}

/** How long a write waits for the canvas before it is refused rather than left hanging. A typed rotate or
 *  resize entry can stay open as long as the user likes, and a session whose end was never delivered
 *  would otherwise hold the plugin's command open for good. */
export const PLUGIN_WRITE_MAX_WAIT_MS = 60_000;

export class PluginWriteGateTimeoutError extends Error {}

export function createPluginWriteGate({
  isGestureActive,
  pollMs = 50,
  maxWaitMs = PLUGIN_WRITE_MAX_WAIT_MS,
  now = Date.now,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}: {
  isGestureActive: () => boolean;
  pollMs?: number;
  maxWaitMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): PluginWriteGate {
  const queue: Array<{ write: () => void; abandon: (error: Error) => void; queuedAt: number }> = [];
  let timer: unknown;
  let disposed = false;

  const schedule = (): void => {
    if (timer !== undefined || queue.length === 0 || disposed) return;
    timer = setTimer(() => {
      timer = undefined;
      flush();
    }, pollMs);
  };

  const flush = (): void => {
    // In order, and each against the document the one before it left.
    while (queue.length > 0 && !isGestureActive()) queue.shift()!.write();
    // Still busy: refuse what has waited too long, plainly, rather than apply it into the session.
    while (queue.length > 0 && now() - queue[0]!.queuedAt >= maxWaitMs) {
      queue.shift()!.abandon(new PluginWriteGateTimeoutError("The canvas stayed busy with another edit; nothing was inserted. Try again."));
    }
    schedule();
  };

  return {
    run<T>(apply: () => T): Promise<T> {
      if (disposed) return Promise.reject(new Error("The document window closed; nothing was inserted."));
      return new Promise<T>((resolve, reject) => {
        queue.push({
          write: () => {
            try {
              resolve(apply());
            } catch (error) {
              reject(error);
            }
          },
          abandon: reject,
          queuedAt: now()
        });
        flush();
      });
    },
    flush,
    pending: () => queue.length,
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      for (const entry of queue.splice(0)) {
        entry.abandon(new Error("The document window closed; nothing was inserted."));
      }
    }
  };
}
