import { parseMolfileGraph, type ParsedMolfileGraph } from "@chemdraft/clipboard-adapter";
import type { MoleculeObject } from "@chemdraft/chem-core";
import type { StereoTags } from "./structureIdentity";

type SerializedGraph = { molfile: string; atomIds: readonly string[]; stereoTags?: StereoTags };
const bondKey = (from: string, to: string) => JSON.stringify([from, to].sort());

// A wedge, hash or wave belongs to its narrow-end atom. Either on a double
// bond belongs to the bond itself and is independent of endpoint order.
function stereoAnnotation(from: string, style?: string, stereo?: "either") {
  return style === "wedge" || style === "hashed" || style === "wavy"
    ? JSON.stringify([style, from]) : stereo;
}

/** The native writer emits tetrahedral stereo on directed bonds. An independent atom
 * parity (including parity 3, explicitly unknown) cannot round-trip through that writer. */
function hasAtomParity(molfile: string, format: ParsedMolfileGraph["format"]) {
  const lines = molfile.split(/\r?\n/);
  if (format === "molfile-v2000") {
    const atomCount = Number(lines[3]!.slice(0, 3));
    return lines.slice(4, 4 + atomCount).some(line => Number(line.slice(39, 42)) !== 0);
  }
  const start = lines.findIndex(line => /^M  V30 BEGIN ATOM\s*$/.test(line));
  const end = lines.findIndex(line => /^M  V30 END ATOM\s*$/.test(line));
  return lines.slice(start + 1, end).some(line => /\bCFG=(?!0\b)\d+/.test(line));
}

const unmapped = () => new Error("Cannot uniquely map the stored stereo annotations to the editable graph.");

/** Owner of the serialization supplies these IDs in the order it actually wrote. */
function writerIds(graph: ParsedMolfileGraph, atomIds: readonly string[]) {
  const ids = new Map(graph.atoms.map((atom, index) => [atom.id, atomIds[index]!]));
  if (ids.size !== graph.atoms.length || ids.size !== atomIds.length || new Set(atomIds).size !== ids.size) throw unmapped();
  return ids;
}

function atomMapNumbers(molfile: string, graph: ParsedMolfileGraph) {
  const lines = molfile.split(/\r?\n/);
  if (graph.format === "molfile-v2000") {
    return lines.slice(4, 4 + graph.atoms.length).map(line => Number(line.slice(60, 63)));
  }
  const start = lines.findIndex(line => line.trimEnd() === "M  V30 BEGIN ATOM");
  const end = lines.findIndex(line => line.trimEnd() === "M  V30 END ATOM");
  return lines.slice(start + 1, end).map(line => Number(line.trim().split(/\s+/)[7]));
}

function coordinateFrame({ atoms }: ParsedMolfileGraph) {
  const xs = atoms.map(atom => atom.x), ys = atoms.map(atom => atom.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, span: Math.max(Math.max(...xs) - x, Math.max(...ys) - y) };
}

function neighbors(graph: ParsedMolfileGraph) {
  const adjacent = new Map(graph.atoms.map(atom => [atom.id, new Map<string, string>()]));
  for (const bond of graph.bonds) {
    const from = adjacent.get(bond.fromAtomId), to = adjacent.get(bond.toAtomId);
    if (!from || !to || from.has(bond.toAtomId)) throw unmapped();
    from.set(bond.toAtomId, bond.order);
    to.set(bond.fromAtomId, bond.order);
  }
  return adjacent;
}

/** A CTAB atom number is local to that record. Compare explicit atom maps when
 * present on both sides. MOL import translates and uniformly scales the
 * drawing. In CTAB coordinates its axes retain their direction. Never break ties
 * with the atom list order, a nearest neighbour, or the stereo being verified. */
function storedAtomIds(source: string, stored: ParsedMolfileGraph, original: SerializedGraph, prior: ParsedMolfileGraph,
  reference: ParsedMolfileGraph) {
  if (stored.atoms.length !== prior.atoms.length || stored.bonds.length !== prior.bonds.length) throw unmapped();
  const sourceMaps = atomMapNumbers(source, stored), nativeMaps = atomMapNumbers(original.molfile, prior);
  const validMaps = (maps: number[]) => {
    const named = maps.filter(n => n !== 0);
    return maps.length === stored.atoms.length && named.every(n => Number.isSafeInteger(n) && n > 0) &&
      new Set(named).size === named.length;
  };
  if (!validMaps(sourceMaps) || !validMaps(nativeMaps)) throw unmapped();
  const sourceFrame = coordinateFrame(stored), drawnFrame = coordinateFrame(reference);
  const scale = !sourceFrame.span && !drawnFrame.span ? 1 : drawnFrame.span / sourceFrame.span;
  // Both native writers round CTAB positions to four decimal places. Allow for
  // that rounding in the positions and the bounding boxes used for alignment.
  const tolerance = 0.0002 * (1 + scale);
  const options = new Map<string, string[]>();
  const storedNeighbors = neighbors(stored), nativeNeighbors = neighbors(prior);
  stored.atoms.forEach((atom, i) => {
    const x = (atom.x - sourceFrame.x) * scale + drawnFrame.x;
    const y = (atom.y - sourceFrame.y) * scale + drawnFrame.y;
    const candidates: string[] = [];
    prior.atoms.forEach((candidate, j) => {
      if (atom.element !== candidate.element || atom.formalCharge !== candidate.formalCharge ||
          atom.isotope !== candidate.isotope || sourceMaps[i] !== nativeMaps[j]) return;
      const position = reference.atoms[j]!;
      const matchesPosition = Number.isFinite(scale) && scale > 0 &&
        Math.abs(x - position.x) <= tolerance && Math.abs(y - position.y) <= tolerance;
      if (matchesPosition && storedNeighbors.get(atom.id)!.size === nativeNeighbors.get(candidate.id)!.size) {
        candidates.push(candidate.id);
      }
    });
    if (!candidates.length) throw unmapped();
    options.set(atom.id, candidates);
  });
  // Coincident atoms can still be distinguished by their bonds to established sites.
  // Only eliminate impossible matches. If connectivity leaves a tie, refuse.
  while ([...options.values()].some(matches => matches.length > 1)) {
    const assigned = new Set([...options.values()].filter(matches => matches.length === 1).map(matches => matches[0]!));
    let changed = false;
    for (const [atom, matches] of options) {
      if (matches.length === 1) continue;
      const retained = matches.filter(candidate => !assigned.has(candidate) &&
        [...storedNeighbors.get(atom)!].every(([other, order]) =>
          options.get(other)!.some(id => nativeNeighbors.get(candidate)!.get(id) === order)));
      if (!retained.length) throw unmapped();
      if (retained.length < matches.length) {
        options.set(atom, retained);
        changed = true;
      }
    }
    if (!changed) throw unmapped();
  }
  const nativeIds = writerIds(prior, original.atomIds);
  const ids = new Map([...options].map(([atom, matches]) => [atom, nativeIds.get(matches[0]!)!]));
  if (ids.size !== stored.atoms.length || new Set(ids.values()).size !== ids.size) throw unmapped();
  return ids;
}

function mappedBonds(graph: ParsedMolfileGraph, ids: ReadonlyMap<string, string>) {
  const bonds = new Map<string, { order: string; stereo?: string }>();
  for (const bond of graph.bonds) {
    const from = ids.get(bond.fromAtomId), to = ids.get(bond.toAtomId);
    if (!from || !to) throw new Error("Cannot map a stored stereo bond endpoint.");
    const key = bondKey(from, to);
    if (bonds.has(key)) throw new Error("Ambiguous bond mapping for stored stereochemistry.");
    bonds.set(key, { order: bond.order, stereo: stereoAnnotation(from, bond.bondStyle, bond.stereo) });
  }
  return bonds;
}

/** Check the graph writer as well as the input. Wedges and hashes signify stereo only on single bonds. */
export function verifyWrittenBonds(molecule: MoleculeObject, written: SerializedGraph, parsed = parseMolfileGraph(written.molfile)) {
  const encoded = mappedBonds(parsed, writerIds(parsed, written.atomIds));
  for (const bond of molecule.bonds) {
    const key = bondKey(bond.fromAtomId, bond.toAtomId);
    const style = bond.display?.bondStyle;
    const stereoStyle = bond.order !== "single" && (style === "wedge" || style === "hashed") ? undefined : style;
    const writtenBond = encoded.get(key);
    if (!writtenBond) throw new Error(`The editable bond ${key} cannot be written.`);
    if (writtenBond.stereo !== stereoAnnotation(bond.fromAtomId, stereoStyle, bond.stereo)) {
      throw new Error(`The editable stereo annotation on bond ${key} cannot be written.`);
    }
  }
  return encoded;
}

/** RDKit reports atom and double-bond descriptors in each input's local order. Compare
 * their sites under the same correspondence as the explicit CTAB bond annotations. */
function mappedStereoTags(tags: StereoTags, ids: readonly string[]) {
  const at = (index: number) => {
    const id = ids[index];
    if (!id) throw unmapped();
    return id;
  };
  return JSON.stringify([
    (tags.CIP_atoms ?? []).map(([i, tag]) => JSON.stringify([at(i), tag])).sort(),
    (tags.CIP_bonds ?? []).map(([a, b, tag]) => JSON.stringify([bondKey(at(a), at(b)), tag])).sort()
  ]);
}

const hasCipTags = (tags: StereoTags) => !!(tags.CIP_atoms?.length || tags.CIP_bonds?.length);

/** Verify the retained source against the pre-edit graph. A proposed graph cannot
 * authorize a chemical edit by happening to reproduce a previously conflicting mark.
 * `sharedIdentity` is the isomeric SMILES the caller has already verified both records share. */
export function assertStoredCtabStereo(source: string, sourceTags: StereoTags | undefined,
  original: SerializedGraph, molecule: MoleculeObject, referenceMolfile = original.molfile, sharedIdentity?: string) {
  const stored = parseMolfileGraph(source);
  if (hasAtomParity(source, stored.format)) {
    throw new Error("The chemical edit cannot preserve stored atom stereo parity.");
  }
  const prior = parseMolfileGraph(original.molfile);
  // With no stereo on either side there is nothing to place, so the stored coordinates need not
  // line up with the drawing (an insertion stretched along one axis, say).
  if (sharedIdentity !== undefined && !/[@\\/]/.test(sharedIdentity) && sourceTags && original.stereoTags &&
      !hasCipTags(sourceTags) && !hasCipTags(original.stereoTags) &&
      stored.bonds.every(bond => stereoAnnotation(bond.fromAtomId, bond.bondStyle, bond.stereo) === undefined) &&
      [...verifyWrittenBonds(molecule, original, prior).values()].every(bond => bond.stereo === undefined)) {
    return;
  }
  const reference = referenceMolfile === original.molfile ? prior : parseMolfileGraph(referenceMolfile);
  const storedIds = storedAtomIds(source, stored, original, prior, reference);
  const before = verifyWrittenBonds(molecule, original, prior);
  for (const [key, annotation] of mappedBonds(stored, storedIds)) {
    const old = before.get(key);
    if (old?.order !== annotation.order) throw unmapped();
    if (old.stereo !== annotation.stereo) {
      throw new Error(`The stored stereo annotation on bond ${key} differs from the editable graph.`);
    }
  }
  if (!sourceTags || !original.stereoTags) throw new Error("Cannot verify stored atom and double-bond stereo.");
  if (mappedStereoTags(sourceTags, stored.atoms.map(atom => storedIds.get(atom.id)!)) !==
      mappedStereoTags(original.stereoTags, original.atomIds)) {
    throw new Error("The stored atom or double-bond stereo differs from the editable graph.");
  }
}
