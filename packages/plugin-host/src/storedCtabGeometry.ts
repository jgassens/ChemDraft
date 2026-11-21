import type { MoleculeObject } from "@chemdraft/chem-core";

const key = "requestWriteCtabGeometry";

/** Preserve the coordinate evidence that belongs to this exact retained CTAB. A redraw
 * can exchange symmetry-related positions without changing any native atom or bond ID. */
export function retainedCtabCompatibility(original: MoleculeObject, edited: MoleculeObject) {
  const compatibility = original.compatibility;
  if (!original.structure || !original.structureFormat.startsWith("molfile-") ||
      original.structure !== edited.structure || original.atoms.length !== edited.atoms.length ||
      !original.atoms.length || original.atoms === edited.atoms) return compatibility;
  const snapshot = compatibility?.unknown[key];
  if (snapshot && typeof snapshot === "object" && "structure" in snapshot && snapshot.structure === original.structure) {
    return compatibility;
  }
  const dx = edited.atoms[0]!.x - original.atoms[0]!.x, dy = edited.atoms[0]!.y - original.atoms[0]!.y;
  if (original.atoms.every((atom, i) => edited.atoms[i]!.id === atom.id &&
      edited.atoms[i]!.x - atom.x === dx && edited.atoms[i]!.y - atom.y === dy)) return compatibility;
  return { warnings: [], ...compatibility, unknown: { ...compatibility?.unknown, [key]: {
    structure: original.structure, points: original.atoms.map(({ id, x, y }) => ({ id, x, y }))
  } } };
}

export function storedCtabReference(molecule: MoleculeObject): MoleculeObject {
  const snapshot = molecule.compatibility?.unknown[key];
  if (!snapshot || typeof snapshot !== "object" || !("structure" in snapshot) || snapshot.structure !== molecule.structure) {
    return molecule;
  }
  const invalid = () => new Error("Cannot map the retained stereo coordinates to the editable graph.");
  if (!("points" in snapshot) || !Array.isArray(snapshot.points) || snapshot.points.length !== molecule.atoms.length) throw invalid();
  const points = new Map<string, { x: number; y: number }>();
  for (const point of snapshot.points) {
    if (typeof point?.id !== "string" || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw invalid();
    points.set(point.id, { x: point.x, y: point.y });
  }
  return { ...molecule, atoms: molecule.atoms.map(atom => {
    const point = points.get(atom.id);
    if (!point) throw invalid();
    return { ...atom, ...point };
  }) };
}

/** A regenerated CTAB belongs to the newly written coordinates. */
export function clearStoredCtabReference(compatibility: MoleculeObject["compatibility"]) {
  if (!compatibility || !(key in compatibility.unknown)) return compatibility;
  const { [key]: _reference, ...unknown } = compatibility.unknown;
  return { ...compatibility, unknown };
}
