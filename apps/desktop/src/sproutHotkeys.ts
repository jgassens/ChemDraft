import { applyPatches, clearChangedAtomHydrogenHints, type ChemDraftDocument, type MoleculeAtom, type MoleculeBond, type MoleculeObject } from "@chemdraft/chem-core";
import {
  atomBondOrderUsageMap, nativeAtomLabelReading, nativeAtomValidationState, nativeElementFromAtomLabel,
  nativeImplicitHydrogenCount, nativeSingleBondGraphMetadata, normalizeNativeMoleculeGeometry, phase4Timestamp,
  tryNativeSingleBondGraphSmiles, withNativeLabelBondSides
} from "@chemdraft/document-workflow-core";
import {
  nativeAtomSproutHotkeyTarget, nativeCarbonylHotkeyAtAtomTarget, nativeRingHotkeyAttachAtAtomTarget,
  nativeRingHotkeyFuseAtBondTarget, nativeSingleBondHotkeyAtAtomTarget, previewNativeMoleculeBondGrowth,
  type NativeAtomSproutHotkeyResult, type NativeBondGrowthPlan, type NativeMoleculeDeleteTarget
} from "./documentWorkflow";
import type { FragmentSproutKind } from "./commands";
import { loadDrawingSettings } from "./drawingSettings";
export type { FragmentSproutKind } from "./commands";

function moleculeAt(document: ChemDraftDocument, target: NativeMoleculeDeleteTarget): MoleculeObject | undefined {
  return document.pages[0].objects.find((object): object is MoleculeObject => object.id === target.objectId && object.type === "molecule");
}

/** Finish a graph edit through the same chemistry and geometry derivations as native drawing. */
function commitGraph(document: ChemDraftDocument, before: MoleculeObject, atoms: MoleculeAtom[], bonds: MoleculeBond[]): NativeAtomSproutHotkeyResult {
  atoms = withNativeLabelBondSides({ atoms: clearChangedAtomHydrogenHints(before, atoms, bonds), bonds }).atoms;
  // Keep today's drawing gate: an already invalid atom remains editable, but a valid atom may
  // not become invalid. Suppressing its warning does not bypass the gate.
  for (const atom of atoms) {
    const old = before.atoms.find(candidate => candidate.id === atom.id);
    const bare = { ...atom, warningSuppressed: false };
    if (old && nativeAtomValidationState({ ...old, warningSuppressed: false }, before.bonds, old.formalCharge, before.atoms).valid &&
      !nativeAtomValidationState(bare, bonds, atom.formalCharge, atoms).valid) {
      return { document, refusal: "atom-no-free-valence" };
    }
  }
  const stored = tryNativeSingleBondGraphSmiles(atoms, bonds);
  const next = normalizeNativeMoleculeGeometry({ ...before, atoms, bonds, structureFormat: "smiles",
    structure: "smiles" in stored ? stored.smiles : "", chemistry: nativeSingleBondGraphMetadata(atoms, bonds) });
  return { document: applyPatches(document, [
    { op: "updateObject", objectId: before.id, changes: next },
    { op: "setSelection", pageId: document.pages[0].id, objectIds: [before.id] }
  ], { now: phase4Timestamp }) };
}

function rollback(document: ChemDraftDocument, result: NativeAtomSproutHotkeyResult): NativeAtomSproutHotkeyResult {
  return { document, refusal: result.refusal ?? "sprout-no-free-direction" };
}

function addedAtom(document: ChemDraftDocument, before: MoleculeObject, target: NativeMoleculeDeleteTarget): MoleculeAtom | undefined {
  return moleculeAt(document, target)?.atoms.find(atom => !before.atoms.some(old => old.id === atom.id));
}

/** Grow a complete substituent; callers commit the returned document once, making one undo step. */
export function nativeFragmentSproutTarget(document: ChemDraftDocument, target: NativeMoleculeDeleteTarget, kind: FragmentSproutKind, plan?: NativeBondGrowthPlan): NativeAtomSproutHotkeyResult {
  if (target.kind !== "atom") return { document, refusal: "target-unavailable" };
  const before = moleculeAt(document, target);
  const first = nativeSingleBondHotkeyAtAtomTarget(document, target, plan && !plan.targetAtomId ? plan : undefined);
  if (!before || first.document === document) return rollback(document, first);
  const root = addedAtom(first.document, before, target);
  if (!root) return rollback(document, first);
  const rootTarget = { ...target, atomId: root.id };
  let result = first;

  if (kind === "cyclopropyl" || kind === "cyclobutyl" || kind === "phenyl" || kind === "cyclopentadienyl") {
    const template = kind === "cyclopropyl" ? "cyclopropane" : kind === "cyclobutyl" ? "cyclobutane" : kind === "phenyl" ? "benzene" : "cyclopentane";
    result = nativeRingHotkeyAttachAtAtomTarget(first.document, rootTarget, template);
    if (result.document === first.document) return rollback(document, result);
    if (kind === "cyclopentadienyl") return addDiene(document, before, moleculeAt(result.document, target)!, root.id);
  } else if (kind === "alkyne") {
    const source = before.atoms.find(atom => atom.id === target.atomId)!;
    const offset = { x: root.x - source.x, y: root.y - source.y };
    const length = Math.hypot(offset.x, offset.y);
    if (length === 0) return { document, refusal: "sprout-no-free-direction" };
    const direction = { x: offset.x / length, y: offset.y / length };
    const endpoint = { x: root.x + offset.x, y: root.y + offset.y };
    const page = document.pages[0];
    const insidePage = (point: { x: number; y: number }) =>
      point.x >= 0 && point.x <= page.width && point.y >= 0 && point.y <= page.height;
    if (!insidePage(root) || !insidePage(endpoint)) return { document, refusal: "sprout-page-edge" };
    result = nativeSingleBondHotkeyAtAtomTarget(first.document, rootTarget, {
      newAtomPoint: endpoint, direction
    });
    if (result.document === first.document) return rollback(document, result);
    const graph = moleculeAt(result.document, target)!;
    const last = addedAtom(result.document, moleculeAt(first.document, target)!, target)!;
    return commitGraph(document, before, graph.atoms, graph.bonds.map(bond =>
      (bond.fromAtomId === root.id && bond.toAtomId === last.id) || (bond.toAtomId === root.id && bond.fromAtomId === last.id)
        ? { ...bond, order: "triple" } : bond));
  }
  const graph = moleculeAt(result.document, target)!;
  return commitGraph(document, before, graph.atoms, graph.bonds);
}

function addDiene(document: ChemDraftDocument, before: MoleculeObject, graph: MoleculeObject, saturatedAtomId?: string, sharedBond?: MoleculeBond): NativeAtomSproutHotkeyResult {
  const newBonds = graph.bonds.filter(bond => !before.bonds.some(old => old.id === bond.id));
  // A shared pi bond already supplies one of the diene's double bonds. At a Kekule
  // single edge both shared atoms may instead participate in the surrounding pi
  // system (benzene -> indene); retain that system and add one internal double.
  const sharedAtomsWithPiBonds = sharedBond ? [sharedBond.fromAtomId, sharedBond.toAtomId].filter(id =>
    before.bonds.some(bond => (bond.fromAtomId === id || bond.toAtomId === id) &&
      (bond.order === "double" || bond.order === "aromatic"))) : [];
  const counts = sharedBond && (sharedBond.order === "double" || sharedBond.order === "aromatic")
    ? [1] : sharedAtomsWithPiBonds.length === 2 ? [2, 1] : [2];
  let refusal: NativeAtomSproutHotkeyResult["refusal"] = "ring-geometry-unavailable";
  for (const needed of counts) {
    // There are at most five new ring edges: enumerate every non-adjacent pattern
    // and let the same valence gate as ordinary drawing judge the complete graph.
    for (let mask = 0; mask < 2 ** newBonds.length; mask += 1) {
      const doubles = newBonds.filter((_bond, index) => mask & (1 << index));
      if (doubles.length !== needed) continue;
      const used = new Set(saturatedAtomId ? [saturatedAtomId] : []);
      // Valence alone permits cumulenes; shared atoms already in a pi system
      // must not receive another double bond from the new ring.
      for (const id of sharedAtomsWithPiBonds) used.add(id);
      if (doubles.some(bond => {
        if (used.has(bond.fromAtomId) || used.has(bond.toAtomId)) return true;
        used.add(bond.fromAtomId); used.add(bond.toAtomId);
        return false;
      })) continue;
      const ids = new Set(doubles.map(bond => bond.id));
      const result = commitGraph(document, before, graph.atoms, graph.bonds.map(bond => ids.has(bond.id)
        ? { ...bond, order: "double", display: { ...bond.display, doubleBondSide: "center" } } : bond));
      if (!result.refusal) return result;
      refusal = result.refusal;
    }
  }
  return { document, refusal };
}

/** Fuse a cyclopentadiene, retaining the hovered bond's order and all original atoms. */
export function nativeDieneFuseTarget(document: ChemDraftDocument, target: NativeMoleculeDeleteTarget): NativeAtomSproutHotkeyResult {
  const before = moleculeAt(document, target);
  const result = nativeRingHotkeyFuseAtBondTarget(document, target, "cyclopentane");
  if (!before || result.document === document) return result;
  const shared = target.kind === "bond" ? before.bonds.find(bond => bond.id === target.bondId) : undefined;
  return addDiene(document, before, moleculeAt(result.document, target)!, undefined, shared);
}

function oxygenGraph(graph: MoleculeObject, atomId: string, document: ChemDraftDocument, plan?: NativeBondGrowthPlan): MoleculeObject | undefined {
  const atom = graph.atoms.find(candidate => candidate.id === atomId);
  if (!atom) return undefined;
  const page = document.pages[0];
  // A spelled SH/PH label can accept a higher valence oxo even when the ordinary single-bond
  // planner sees its minimum free valence as full. Plan geometry using only its element head.
  const reading = nativeAtomLabelReading(atom.element);
  const geometryAtom = reading.kind === "spelled" ? { ...atom, element: reading.element, labelLiteral: false } : atom;
  const geometryGraph = geometryAtom === atom ? graph : { ...graph, atoms: graph.atoms.map(candidate => candidate.id === atom.id ? geometryAtom : candidate) };
  const preview = plan && !plan.targetAtomId ? plan : previewNativeMoleculeBondGrowth(geometryGraph, geometryAtom, page.width, page.height);
  if (!preview || preview.targetAtomId) return undefined;
  const nextId = (prefix: string, ids: string[]) => {
    let i = 1;
    while (ids.includes(`${prefix}_${i}`)) i += 1;
    return `${prefix}_${i}`;
  };
  const oxygen: MoleculeAtom = { id: nextId("atom", graph.atoms.map(candidate => candidate.id)), element: "O", formalCharge: 0, ...preview.newAtomPoint };
  return { ...graph, atoms: [...graph.atoms, oxygen], bonds: [...graph.bonds, {
    id: nextId("bond", graph.bonds.map(bond => bond.id)), fromAtomId: atomId, toAtomId: oxygen.id, order: "double",
    ...(loadDrawingSettings().defaultDoubleBond === "centred" ? { display: { doubleBondSide: "center" as const } } : {})
  }] };
}

/** Key 2 adds oxygen directly to S/P, preserving their explicit labels, charge and isotope. */
export function nativeOxoHotkeyTarget(document: ChemDraftDocument, target: NativeMoleculeDeleteTarget, plan?: NativeBondGrowthPlan): NativeAtomSproutHotkeyResult {
  const graph = moleculeAt(document, target);
  const atom = target.kind === "atom" ? graph?.atoms.find(candidate => candidate.id === target.atomId) : undefined;
  const reading = atom ? nativeAtomLabelReading(atom.element) : undefined;
  const element = reading?.kind === "element" || reading?.kind === "spelled" ? reading.element : undefined;
  if (!atom || !graph || (element !== "S" && element !== "P")) return nativeCarbonylHotkeyAtAtomTarget(document, target, plan);
  const next = oxygenGraph(graph, atom.id, document, plan);
  if (!next) return { document, refusal: "sprout-no-free-direction" };
  // Oxidation must retain the source's implicit H even if the bare product validates
  // (CP -> CP=O would silently lose two H). Spell a changed H count so the existing
  // SH/PH label path validates the complete hypervalent state and preserves its formula.
  // Atoms without implicit H and literal, charged, isotopic or radical atoms keep their gates.
  if (reading?.kind === "element" && atom.labelLiteral !== true && atom.formalCharge === 0 &&
    atom.isotope === undefined && !(atom.markRadicals ?? 0)) {
    const usage = atomBondOrderUsageMap(graph.atoms, graph.bonds).get(atom.id) ?? 0;
    const hydrogens = nativeImplicitHydrogenCount(element, usage, atom.formalCharge);
    const nextUsage = atomBondOrderUsageMap(next.atoms, next.bonds).get(atom.id) ?? 0;
    if (hydrogens > 0 && hydrogens !== nativeImplicitHydrogenCount(element, nextUsage, atom.formalCharge)) {
      next.atoms = next.atoms.map(candidate => candidate.id === atom.id
        ? { ...candidate, element: `${element}H${hydrogens === 1 ? "" : hydrogens}`, labelLiteral: true }
        : candidate);
    }
  }
  return commitGraph(document, graph, next.atoms, next.bonds);
}

/** Key 9 uses one source valence for isopropyl when two methyls would overfill carbon. */
export function nativeBranchedHotkeyTarget(document: ChemDraftDocument, target: NativeMoleculeDeleteTarget, plan?: NativeBondGrowthPlan): NativeAtomSproutHotkeyResult {
  const graph = moleculeAt(document, target);
  const atom = target.kind === "atom" ? graph?.atoms.find(candidate => candidate.id === target.atomId) : undefined;
  const usage = graph && atom ? atomBondOrderUsageMap(graph.atoms, graph.bonds).get(atom.id) ?? 0 : 0;
  if (!graph || !atom || nativeElementFromAtomLabel(atom.element) !== "C" || usage <= 2) return nativeAtomSproutHotkeyTarget(document, target, "gemDimethyl", plan);
  const first = nativeSingleBondHotkeyAtAtomTarget(document, target, plan && !plan.targetAtomId ? plan : undefined);
  if (first.document === document) return first;
  const root = addedAtom(first.document, graph, target);
  if (!root) return rollback(document, first);
  const result = nativeAtomSproutHotkeyTarget(first.document, { ...target, kind: "atom", atomId: root.id }, "gemDimethyl");
  if (result.document === first.document) return rollback(document, result);
  const next = moleculeAt(result.document, target)!;
  return commitGraph(document, graph, next.atoms, next.bonds);
}
