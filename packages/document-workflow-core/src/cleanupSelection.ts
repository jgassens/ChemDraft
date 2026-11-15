import { applyPatches, nativeDrawingStyleFromObjectStyle, type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { moleculeGeometryFromAtoms, stereoPerceptionMolfile, type PastedStructureDepiction } from "./molecule";
import { phase4Timestamp } from "./shared";

export interface CleanupMoleculeSelection {
  atomIds: readonly string[];
  bondIds: readonly string[];
}

export interface ConstrainedCleanupEngines {
  relayout(molfile: string, options: { fixedAtomIndices: readonly number[] }): PastedStructureDepiction;
  assertIdentity(before: string, after: string): void;
}

/** A selected bond includes both endpoints; unrelated metals/high-degree atoms are never added. */
export function cleanupSelectionAtomIds(molecule: MoleculeObject, selection: CleanupMoleculeSelection): Set<string> {
  const ids = new Set(selection.atomIds);
  const bonds = new Set(selection.bondIds);
  for (const bond of molecule.bonds) {
    if (bonds.has(bond.id)) {
      ids.add(bond.fromAtomId);
      ids.add(bond.toAtomId);
    }
  }
  return new Set(molecule.atoms.filter(atom => ids.has(atom.id)).map(atom => atom.id));
}

/** Lay out only selected connected parts. Unselected atom records and every bond are retained.
 * Isolated selected atoms are deliberately no-ops. Full selections use the caller's existing
 * whole-molecule path. No reflection or wedge reassignment is allowed: a stereo change refuses
 * the operation, including changes at fixed centres with a moving ligand or across an alkene.
 * Engines are injected so the same pure operation is available to desktop and headless callers.
 */
export function cleanUpMoleculeSelection2d(
  molecule: MoleculeObject, selection: CleanupMoleculeSelection, engines: ConstrainedCleanupEngines
): MoleculeObject {
  const selected = cleanupSelectionAtomIds(molecule, selection);
  if (!selected.size || selected.size === molecule.atoms.length) return molecule;
  const index = new Map(molecule.atoms.map((atom, i) => [atom.id, i]));
  const edges = molecule.bonds.map(bond => [index.get(bond.fromAtomId)!, index.get(bond.toAtomId)!] as const);
  const adjacency = molecule.atoms.map(() => [] as number[]);
  for (const [a, b] of edges) { adjacency[a]!.push(b); adjacency[b]!.push(a); }
  // The permitted single-atom no-op also applies to isolated atoms in a disjoint selection.
  const movable = new Set(molecule.atoms.flatMap((atom, i) => selected.has(atom.id) &&
    adjacency[i]!.some(j => selected.has(molecule.atoms[j]!.id)) ? [i] : []));
  if (!movable.size) return molecule;

  const source = stereoPerceptionMolfile(molecule);
  const depiction = engines.relayout(source, {
    fixedAtomIndices: molecule.atoms.flatMap((_, i) => movable.has(i) ? [] : [i])
  });
  if (depiction.atoms.length !== molecule.atoms.length || depiction.atoms.some(atom =>
    !Number.isFinite(atom.x) || !Number.isFinite(atom.y))) {
    throw new Error("Clean Up Selection refused: the layout engine returned incomplete coordinates.");
  }
  const generated = depiction.atoms.map(atom => ({ x: atom.x, y: -atom.y }));
  const target = nativeDrawingStyleFromObjectStyle(molecule.style).bondLengthPx;
  const points = molecule.atoms.map(atom => ({ x: atom.x, y: atom.y }));
  const remaining = new Set(movable);
  const placed = new Set<number>();

  while (remaining.size) {
    const start = remaining.values().next().value!;
    const members = [start];
    remaining.delete(start);
    for (let k = 0; k < members.length; k++) {
      for (const next of adjacency[members[k]!]!) {
        if (remaining.delete(next)) members.push(next);
      }
    }
    const memberSet = new Set(members);
    const anchors = [...new Set(members.flatMap(i => adjacency[i]!.filter(j => !movable.has(j))))];
    const internal = edges.filter(([a, b]) => memberSet.has(a) && memberSet.has(b));
    const lengths = internal.map(([a, b]) => Math.hypot(generated[a]!.x - generated[b]!.x,
      generated[a]!.y - generated[b]!.y)).filter(length => length > 1e-8).sort((a, b) => a - b);
    if (!lengths.length) throw new Error("Clean Up Selection refused: the selected bonds have no usable layout.");
    const scale = target / lengths[Math.floor(lengths.length / 2)]!;
    const centre = (indices: readonly number[], coords: readonly { x: number; y: number }[]) => ({
      x: indices.reduce((sum, i) => sum + coords[i]!.x, 0) / indices.length,
      y: indices.reduce((sum, i) => sum + coords[i]!.y, 0) / indices.length
    });
    const origin = centre(anchors.length ? anchors : members, generated);
    const destination = centre(anchors.length ? anchors : members, molecule.atoms);
    // A single attachment uses the fixed anchor's other neighbours as orientation references.
    // Already fitted fragments share that reference too: independently fitting two fragments
    // against their old positions would distort the angle between them at their fixed centre.
    // A metal with no fixed neighbours instead retains the drawn metal-to-donor direction.
    const references = anchors.length === 1
      ? adjacency[anchors[0]!]!.filter(i => !movable.has(i) || placed.has(i)) : anchors;
    const orientation = references.length ? references : members;
    let dot = 0, cross = 0;
    for (const i of orientation) {
      const ex = generated[i]!.x - origin.x, ey = generated[i]!.y - origin.y;
      const dx = points[i]!.x - destination.x, dy = points[i]!.y - destination.y;
      dot += ex * dx + ey * dy;
      cross += ex * dy - ey * dx;
    }
    const angle = Math.atan2(cross, dot), cos = Math.cos(angle), sin = Math.sin(angle);
    for (const i of members) {
      const x = (generated[i]!.x - origin.x) * scale, y = (generated[i]!.y - origin.y) * scale;
      points[i] = { x: destination.x + cos * x - sin * y, y: destination.y + sin * x + cos * y };
    }
    if (anchors.length === 1) {
      const anchor = anchors[0]!, root = members.find(i => adjacency[i]!.includes(anchor))!;
      // Translate the clean fragment to exactly one standard attachment length, preserving
      // all its internal angles and lengths (the engine may use a different metal bond length).
      const dx = points[root]!.x - points[anchor]!.x, dy = points[root]!.y - points[anchor]!.y;
      const length = Math.hypot(dx, dy);
      if (length > 1e-8) {
        const tx = dx * (target / length - 1), ty = dy * (target / length - 1);
        for (const i of members) points[i] = { x: points[i]!.x + tx, y: points[i]!.y + ty };
      }
    }
    for (const i of members) placed.add(i);
  }

  // Several fixed attachments may not admit an ideal template. Project affected bond lengths
  // onto the fixed boundary without ever writing to a fixed point. Refuse incompatible anchors
  // instead of relaxing them, stretching attachment bonds, or changing the rest of the molecule.
  const affected = edges.filter(([a, b]) => movable.has(a) || movable.has(b));
  for (let pass = 0; pass < 400; pass++) {
    let maxError = 0;
    for (const [a, b] of affected) {
      const dx = points[b]!.x - points[a]!.x, dy = points[b]!.y - points[a]!.y;
      const length = Math.hypot(dx, dy);
      maxError = Math.max(maxError, Math.abs(length - target) / target);
      if (length < 1e-8) continue;
      const weight = movable.has(a) && movable.has(b) ? 0.5 : 1;
      const correction = (length - target) / length * weight;
      if (movable.has(a)) points[a] = { x: points[a]!.x + dx * correction, y: points[a]!.y + dy * correction };
      if (movable.has(b)) points[b] = { x: points[b]!.x - dx * correction, y: points[b]!.y - dy * correction };
    }
    if (maxError < 0.0001) break;
  }
  if (affected.some(([a, b]) => Math.abs(Math.hypot(points[b]!.x - points[a]!.x,
    points[b]!.y - points[a]!.y) / target - 1) > 0.01)) {
    throw new Error("Clean Up Selection refused: standard bond lengths cannot be reached while keeping the unselected atoms fixed.");
  }
  // Length projection alone could straighten a zigzag to span incompatible fixed ends.
  // Keep the inventor's chemical/ring angles (within five degrees) rather than calling that
  // a tidy layout. The engine owns the angle choice; this does not re-decide hybridisation.
  const angleAt = (coords: readonly { x: number; y: number }[], centre: number, a: number, b: number) => {
    const ax = coords[a]!.x - coords[centre]!.x, ay = coords[a]!.y - coords[centre]!.y;
    const bx = coords[b]!.x - coords[centre]!.x, by = coords[b]!.y - coords[centre]!.y;
    return Math.atan2(Math.abs(ax * by - ay * bx), ax * bx + ay * by);
  };
  let idealBoundary: typeof generated | undefined;
  for (let i = 0; i < adjacency.length; i++) {
    const neighbours = adjacency[i]!;
    // High-coordinate fixed centres retain their established coordination drawing. For the
    // ordinary fixed boundary, every angle touched by a moving ligand must match the inventor
    // within one degree; angles between two fixed neighbours are outside the cleanup scope.
    if (!movable.has(i) && neighbours.length > 4) continue;
    for (let a = 0; a < neighbours.length; a++) {
      for (let b = a + 1; b < neighbours.length; b++) {
        if (!movable.has(i) && !movable.has(neighbours[a]!) && !movable.has(neighbours[b]!)) continue;
        // The marked inventor may preserve an already distorted angle between fixed atoms.
        // Judge the fixed centre against an unconstrained template, never that distortion.
        if (!movable.has(i) && !idealBoundary) {
          const ideal = engines.relayout(source, { fixedAtomIndices: [] });
          if (ideal.atoms.length !== molecule.atoms.length || ideal.atoms.some(atom =>
            !Number.isFinite(atom.x) || !Number.isFinite(atom.y))) {
            throw new Error("Clean Up Selection refused: the layout engine returned incomplete coordinates.");
          }
          idealBoundary = ideal.atoms.map(atom => ({ x: atom.x, y: -atom.y }));
        }
        const tolerance = movable.has(i) ? Math.PI / 36 : Math.PI / 180;
        if (Math.abs(angleAt(points, i, neighbours[a]!, neighbours[b]!) -
          angleAt(movable.has(i) ? generated : idealBoundary!, i, neighbours[a]!, neighbours[b]!)) > tolerance) {
          throw new Error("Clean Up Selection refused: standard bond angles cannot be reached while keeping the unselected atoms fixed.");
        }
      }
    }
  }
  const atoms = molecule.atoms.map((atom, i) => movable.has(i) ? { ...atom, ...points[i] } : atom);
  if (atoms.every((atom, i) => atom.x === molecule.atoms[i]!.x && atom.y === molecule.atoms[i]!.y)) return molecule;
  // Rotation uses the stored frame's centre as its SVG pivot. Keep that frame for a rotated
  // partial edit so unchanged native coordinates also keep their exact rendered positions.
  const result = { ...molecule, atoms, ...(molecule.rotation === 0 ? moleculeGeometryFromAtoms(atoms) : {}) };
  // The native records, not the engine's rebuilt graph, are the chemistry source of truth.
  engines.assertIdentity(source, stereoPerceptionMolfile(result));
  return result;
}

/** Prepare every partial target before applying any patch; callers commit once with one label. */
export function cleanUpMoleculeSelections2d(
  document: ChemDraftDocument, selections: readonly (CleanupMoleculeSelection & { objectId: string })[],
  engines: ConstrainedCleanupEngines
): ChemDraftDocument {
  const movedAtoms = new Map<string, Map<string, { x: number; y: number }>>();
  const patches = selections.flatMap(selection => {
    const molecule = document.pages.flatMap(page => page.objects).find(object => object.id === selection.objectId);
    if (molecule?.type !== "molecule") return [];
    const cleaned = cleanUpMoleculeSelection2d(molecule, selection, engines);
    if (cleaned !== molecule) {
      const offsets = new Map<string, { x: number; y: number }>();
      for (let i = 0; i < molecule.atoms.length; i++) {
        const before = molecule.atoms[i]!, after = cleaned.atoms[i]!;
        if (before.x !== after.x || before.y !== after.y) {
          offsets.set(before.id, { x: after.x - before.x, y: after.y - before.y });
        }
      }
      const transform = molecule.transform;
      const transformed = molecule.rotation !== 0 || (transform !== undefined && (
        transform.scaleX !== 1 || transform.scaleY !== 1 || transform.rotationDegrees !== 0 ||
        (transform.tiltXDegrees ?? 0) !== 0 || (transform.tiltYDegrees ?? 0) !== 0));
      // Released documents associate marks in native coordinates. Moving a marked atom in a
      // transformed frame cannot safely preserve that convention, so refuse before any patch.
      if (transformed && document.pages.some(page => page.objects.some(object =>
        object.type === "electron-mark" && object.anchor.kind === "atom" &&
        object.anchor.objectId === molecule.id && object.anchor.atomId !== undefined &&
        offsets.has(object.anchor.atomId)))) {
        throw new Error("Clean Up Selection: can't move atoms with electron marks in a rotated or transformed structure yet. Clean up the whole structure, or remove the transform first.");
      }
      movedAtoms.set(molecule.id, offsets);
    }
    return cleaned === molecule ? [] : [{ op: "updateObject" as const, objectId: molecule.id, changes: cleaned }];
  });
  // Marks render from their own stored frame. Carry every atom-anchored mark by its atom's
  // native offset before the caller reconciles charges/radicals during commit normalization.
  const markPatches = document.pages.flatMap(page => page.objects.flatMap(object => {
    if (object.type !== "electron-mark" || object.anchor.kind !== "atom" ||
      !object.anchor.objectId || !object.anchor.atomId) return [];
    const offset = movedAtoms.get(object.anchor.objectId)?.get(object.anchor.atomId);
    return offset ? [{ op: "updateObject" as const, objectId: object.id,
      changes: { x: object.x + offset.x, y: object.y + offset.y } }] : [];
  }));
  return patches.length ? applyPatches(document, [...patches, ...markPatches], { now: phase4Timestamp }) : document;
}
