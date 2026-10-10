// Native molecule construction from molfiles and SMILES depictions, bond-length scaling, and double-bond side placement.
// Moved verbatim from apps/desktop/src/documentWorkflow.ts; see this package's README.

import {
  applyPatches,
  type ChemDraftDocument,
  ChemDraftSyntheticStylePreset,
  type DocumentObject,
  type MoleculeAtom,
  type MoleculeBond,
  type MoleculeObject,
  moleculeToMolfileV2000,
  UnknownBondOrderError,
  type MoleculeTransformState,
  stylePresetToObjectStyle
} from "@chemdraft/chem-core";
import { type ParsedMolfileGraph, parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { isDefaultCenteredDoubleBond, nativeBondOrderResolution, ringInteriorDoubleBondSides } from "@chemdraft/layout-engine";
import { nativeElementFromAtomLabel, nativeSingleBondGraphMetadata } from "./atoms";
import {
  clamp,
  distance,
  firstPage,
  nextObjectId,
  type PagePoint,
  phase4Timestamp
} from "./shared";

export type NativeDoubleBondSide = NonNullable<MoleculeBond["display"]>["doubleBondSide"];

export const defaultNativeMoleculeTransform: MoleculeTransformState = {
  scaleX: 1,
  scaleY: 1,
  rotationDegrees: 0
};

export const nativeSingleBondDimensions = {
  width: 48,
  height: 32
} as const;

export const nativeBondLengthPx = ChemDraftSyntheticStylePreset.drawing.bondLengthPx;

// Coordinate-free SMILES need a little more room than hand-drawn/native structures. At the
// 22 px drawing default, a 15 px heteroatom label and a stereobond consume most of a fused-ring
// bond. A 28 px target keeps the normal line/font weights while giving generated polycycles the
// same open proportions users expect from a chemical depiction engine.
export const smilesPasteBondLengthPx = 28;

const nativeMoleculePadding = 8;

/** A 2D depiction (atoms + wedge-aware bonds) produced from a SMILES by the OCL
 *  adapter's `depictSmiles2D`. Kept structural so this module never imports the
 *  engine (which stays behind a dynamic import to keep it out of the static graph). */
export interface PastedStructureDepiction {
  atoms: ReadonlyArray<{ element: string; x: number; y: number; charge: number }>;
  bonds: ReadonlyArray<{ from: number; to: number; order: MoleculeBond["order"]; wedge: "wedge" | "hashed" | null }>;
}

/**
 * Read a generated 2D molfile into the structural depiction consumed by SMILES paste. Keeping
 * this conversion beside `insertSmilesMolecule` means RDKit and the OpenChemLib fallback share
 * the app's existing molfile parser, including its fixed-column and wedge-direction handling.
 */
export function pastedStructureDepictionFromMolfile(molfile: string): PastedStructureDepiction {
  const graph = parseMolfileGraph(molfile);
  const atomIndexById = new Map(graph.atoms.map((atom, index) => [atom.id, index]));
  return {
    atoms: graph.atoms.map((atom) => ({
      element: atom.element,
      x: atom.x,
      y: atom.y,
      charge: atom.formalCharge
    })),
    bonds: graph.bonds.flatMap((bond) => {
      const from = atomIndexById.get(bond.fromAtomId);
      const to = atomIndexById.get(bond.toAtomId);
      if (from === undefined || to === undefined) return [];
      return [{
        from,
        to,
        // Carried through, not collapsed. `MoleculeBond["order"]` — which this interface already
        // declares — accepts both, the insert path stores whatever arrives, and the OCL adapter
        // explicitly refuses this same collapse citing AGENTS.md section 5.7. Flattening an
        // un-kekulized aromatic ring to all-single bonds is a silent chemistry change.
        order: bond.order,
        // Dative (dashed) bonds parse with a display style, not a wedge — they fall to null here
        // and keep their style through the structural insert path.
        wedge: bond.bondStyle === "wedge" || bond.bondStyle === "hashed" ? bond.bondStyle : null
      }];
    })
  };
}

/** Query bonds can round-trip as data, but do not establish a chemical identity for an engine. */
export function assertMolfileHasKnownBondOrders(molfile: string): void {
  const ids = parseMolfileGraph(molfile).bonds.filter((bond) => bond.order === "unknown").map((bond) => bond.id);
  if (ids.length > 0) throw new UnknownBondOrderError(ids);
}

/**
 * Place a SMILES-derived 2D depiction as an editable native molecule, preserving
 * stereochemistry. The depiction is engine-frame y-UP with wedge/hash bonds; the
 * molfile scaler negates y (→ document y-down) and KEEPS the wedges unchanged —
 * which preserves chirality per the coordinate-frame contract (negate y, never swap
 * wedges; proven by the Phase 6 oracle round-trip). Double-bond sides are recomputed
 * from the placed geometry so ring double bonds draw toward the ring interior.
 */
/** Where a SMILES-derived molecule came from, so the object records it honestly. */
export interface SmilesMoleculeSource {
  objectIdPrefix: string;
  styleSource: string;
  warningCode: string;
  warningMessage: string;
  /**
   * Ids already handed out but not yet in the document, so the next one skips them.
   *
   * Paste does not need this: it inserts immediately, so the document always reflects every id
   * already issued. A plugin's structure does — it is BUILT and then waits in the review queue, so
   * two structures built before either is accepted both saw an unchanged document and both minted
   * `mol_plugin_001`. Accepting the second threw `object "mol_plugin_001" already exists`.
   *
   * The caller owns the set and adds to it, because only the caller knows when an id has been issued.
   */
  reservedObjectIds?: Set<string>;
}

export const SMILES_PASTE_SOURCE: SmilesMoleculeSource = {
  objectIdPrefix: "mol_clipboard",
  styleSource: "clipboard-smiles",
  warningCode: "clipboard.smiles_imported",
  warningMessage: "Generated an editable 2D structure from pasted SMILES."
};

/**
 * Build the molecule object a SMILES depiction becomes, without touching the document.
 *
 * Split out of {@link insertSmilesMolecule} so the plugin boundary can reach it: a plugin proposes a
 * patch carrying an object, and has no business applying one. Both callers therefore produce the same
 * object — same scaling, same double-bond side recomputation, same compatibility record — which is
 * what stops "insert from name" and "paste a SMILES" drifting into two different structures for the
 * same input.
 *
 * `source` distinguishes them where it matters: the style and the compatibility warning record where
 * the structure came from, and "pasted" would be a false provenance claim for a converted name.
 */
export function createSmilesMolecule(
  document: ChemDraftDocument,
  point: PagePoint,
  depiction: PastedStructureDepiction,
  smilesText: string,
  source: SmilesMoleculeSource = SMILES_PASTE_SOURCE
): DocumentObject {
  if (depiction.atoms.length === 0) {
    throw new Error("Cannot build a molecule: no atoms were generated.");
  }
  const page = firstPage(document);

  const pseudoGraph: ParsedMolfileGraph = {
    format: "molfile-v2000",
    atoms: depiction.atoms.map((atom, index) => ({
      id: `a${index}`,
      element: atom.element,
      x: atom.x,
      y: atom.y,
      formalCharge: atom.charge
    })),
    bonds: depiction.bonds.map((bond, index) => ({
      id: `b${index}`,
      fromAtomId: `a${bond.from}`,
      toAtomId: `a${bond.to}`,
      order: bond.order
    })),
    warnings: []
  };

  const atoms: MoleculeAtom[] = scaleParsedMolfileAtoms(
    pseudoGraph,
    point,
    page,
    smilesPasteBondLengthPx
  ).map((atom) => ({
    id: atom.id,
    element: atom.element,
    x: atom.x,
    y: atom.y,
    formalCharge: atom.formalCharge
  }));
  const atomIds = new Set(atoms.map((atom) => atom.id));
  const baseBonds: MoleculeBond[] = depiction.bonds
    .map((bond, index): MoleculeBond => {
      const base: MoleculeBond = {
        id: `b${index}`,
        fromAtomId: `a${bond.from}`,
        toAtomId: `a${bond.to}`,
        order: bond.order
      };
      return bond.wedge ? { ...base, display: { bondStyle: bond.wedge } } : base;
    })
    .filter((bond) => atomIds.has(bond.fromAtomId) && atomIds.has(bond.toAtomId));

  // Recompute each double bond's drawn side from the placed 2D geometry.
  const geometry = moleculeGeometryFromAtoms(atoms);
  const sideMolecule: MoleculeObject = {
    id: "smiles-side",
    type: "molecule",
    rotation: 0,
    style: {},
    structureFormat: "molfile-v2000",
    structure: "",
    atoms,
    bonds: baseBonds,
    superatoms: [],
    rGroups: [],
    ...geometry
  };
  const bonds: MoleculeBond[] = baseBonds.map((bond) => {
    if (bond.order !== "double") return bond;
    const doubleBondSide = defaultDoubleBondSide(sideMolecule, bond);
    return doubleBondSide === undefined ? bond
      : { ...bond, display: { ...bond.display, doubleBondSide } };
  });

  // Stored-structure spelling: molecule.structure is a standard export molfile (an abbreviated
  // label as the dummy "*"), which is what RDKit, Copy As and the loaders read. CIP perception
  // never reads this field — it spells its own molfile (stereoPerceptionMolfile, R-groups).
  const structureWarnings: string[] = [];
  const structure = moleculeToMolfileV2000({ ...sideMolecule, bonds }, {
    fromDocFrame: true,
    warnings: structureWarnings,
    kekuleBondOrders: nativeBondOrderResolution(atoms, bonds).kekuleOrders
  }).contents;

  return normalizeNativeMoleculeGeometry({
    id: nextObjectId(document, source.objectIdPrefix, source.reservedObjectIds),
    type: "molecule",
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    transform: defaultNativeMoleculeTransform,
    style: {
      ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset),
      bondLengthPx: smilesPasteBondLengthPx,
      source: source.styleSource
    },
    compatibility: {
      sourceFormat: "smiles",
      warnings: [
        { code: source.warningCode, message: source.warningMessage },
        // What the stored molfile could not carry is recorded, not dropped.
        ...structureWarnings.map((message) => ({ code: "molfile.stored_structure_lossy", message }))
      ],
      unknown: { smiles: smilesText }
    },
    structureFormat: "molfile-v2000",
    structure,
    chemistry: nativeSingleBondGraphMetadata(atoms, bonds),
    atoms,
    bonds,
    superatoms: [],
    rGroups: []
  });
}

export function insertSmilesMolecule(
  document: ChemDraftDocument,
  point: PagePoint,
  depiction: PastedStructureDepiction,
  smilesText: string
): ChemDraftDocument {
  const object = createSmilesMolecule(document, point, depiction, smilesText);
  const page = firstPage(document);

  return applyPatches(
    document,
    [
      { op: "addObject", pageId: page.id, object },
      { op: "setSelection", pageId: page.id, objectIds: [object.id] }
    ],
    { now: phase4Timestamp }
  );
}

export function applyMoleculeTargetBondLength(
  document: ChemDraftDocument,
  moleculeObjectIds: readonly string[],
  targetBondLengthPx: number
): ChemDraftDocument {
  if (!Number.isFinite(targetBondLengthPx) || targetBondLengthPx <= 0) {
    return document;
  }

  const targetIds = new Set(moleculeObjectIds);
  if (targetIds.size === 0) {
    return document;
  }

  const patches = document.pages.flatMap((page) =>
    page.objects.flatMap((object) => {
      if (object.type !== "molecule" || !targetIds.has(object.id)) {
        return [];
      }

      const representative = representativeNativeMoleculeBondLength(object);
      const nextStyle = {
        ...object.style,
        bondLengthPx: targetBondLengthPx
      };
      const scaled = representative
        ? scaledMoleculeToTargetBondLength(object, targetBondLengthPx, representative, nextStyle)
        : normalizeNativeMoleculeGeometry({ ...object, style: nextStyle });
      const changes = moleculeObjectChanges(object, scaled);
      return Object.keys(changes).length === 0
        ? []
        : [{
            op: "updateObject" as const,
            objectId: object.id,
            changes
          }];
    })
  );

  return patches.length > 0 ? applyPatches(document, patches, { now: phase4Timestamp }) : document;
}

function representativeNativeMoleculeBondLength(molecule: MoleculeObject): number | undefined {
  const atomById = new Map(molecule.atoms.map((atom) => [atom.id, atom]));
  const heavyDistances: number[] = [];
  const allDistances: number[] = [];
  for (const bond of molecule.bonds) {
    const from = atomById.get(bond.fromAtomId);
    const to = atomById.get(bond.toAtomId);
    if (!from || !to) {
      continue;
    }
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    if (!Number.isFinite(distance) || distance <= 0) {
      continue;
    }
    allDistances.push(distance);
    if (nativeElementFromAtomLabel(from.element) !== "H" && nativeElementFromAtomLabel(to.element) !== "H") {
      heavyDistances.push(distance);
    }
  }
  return medianNumber(heavyDistances.length > 0 ? heavyDistances : allDistances);
}

function scaledMoleculeToTargetBondLength(
  molecule: MoleculeObject,
  targetBondLengthPx: number,
  representativeBondLengthPx: number,
  nextStyle: Record<string, unknown>
): MoleculeObject {
  const scale = targetBondLengthPx / representativeBondLengthPx;
  if (!Number.isFinite(scale) || scale <= 0) {
    return normalizeNativeMoleculeGeometry({ ...molecule, style: nextStyle });
  }

  const center = moleculeAtomBoundsCenter(molecule.atoms);
  if (!center) {
    return normalizeNativeMoleculeGeometry({ ...molecule, style: nextStyle });
  }

  const atoms = molecule.atoms.map((atom) => ({
    ...atom,
    x: center.x + (atom.x - center.x) * scale,
    y: center.y + (atom.y - center.y) * scale,
    ...(atom.labelOffset ? {
      labelOffset: {
        x: atom.labelOffset.x * scale,
        y: atom.labelOffset.y * scale
      }
    } : {})
  }));

  return normalizeNativeMoleculeGeometry({
    ...molecule,
    style: nextStyle,
    atoms
  });
}

function moleculeAtomBoundsCenter(atoms: readonly MoleculeAtom[]): PagePoint | undefined {
  if (atoms.length === 0) {
    return undefined;
  }
  const minX = Math.min(...atoms.map((atom) => atom.x));
  const maxX = Math.max(...atoms.map((atom) => atom.x));
  const minY = Math.min(...atoms.map((atom) => atom.y));
  const maxY = Math.max(...atoms.map((atom) => atom.y));
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2
  };
}

export function moleculeObjectChanges(previous: MoleculeObject, next: MoleculeObject): Partial<MoleculeObject> {
  const changes: Partial<MoleculeObject> = {};
  if (JSON.stringify(previous.style) !== JSON.stringify(next.style)) {
    changes.style = next.style;
  }
  if (JSON.stringify(previous.atoms) !== JSON.stringify(next.atoms)) {
    changes.atoms = next.atoms;
  }
  if (previous.x !== next.x) {
    changes.x = next.x;
  }
  if (previous.y !== next.y) {
    changes.y = next.y;
  }
  if (previous.width !== next.width) {
    changes.width = next.width;
  }
  if (previous.height !== next.height) {
    changes.height = next.height;
  }
  return changes;
}

function medianNumber(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle];
}

/**
 * The molfile the app hands its OWN CIP perceiver (OpenChemLib). Abbreviated labels ("Ph", a typed
 * "CH3") go in as R-group pseudo-atoms, never as the export dummy "*": OpenChemLib reads "*" as a
 * carbon, so a center bearing "Ph" and a methyl looked like two identical substituents — no
 * stereocenter, nothing in the reference map for the flatten read-back guard to check, and a
 * flatten that inverted that center committed silently. Each distinct label ranks apart from every
 * element and from every other label, which is all the guard needs: it compares the drawing's
 * reading before and after, and both reads use this same spelling.
 */
export function stereoPerceptionMolfile(molecule: MoleculeObject, warnings?: string[]): string {
  return moleculeToMolfileV2000(molecule, {
    // OCL loses a distant tetrahedral descriptor when it reads a type-8 query bond.
    unknownBondOrders: "refuse",
    fromDocFrame: true,
    abbreviations: "rgroup",
    warnings,
    kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders
  }).contents;
}

export function scaleParsedMolfileAtoms(
  graph: ParsedMolfileGraph,
  point: PagePoint,
  page: ChemDraftDocument["pages"][number],
  targetBondLengthPx: number = nativeBondLengthPx
): ParsedMolfileGraph["atoms"] {
  const averageBondLength = averageParsedMolfileBondLength(graph);
  const scale = averageBondLength > 0 ? targetBondLengthPx / averageBondLength : targetBondLengthPx / 1.5;
  const scaledAtoms = graph.atoms.map((atom) => ({
    ...atom,
    x: atom.x * scale,
    y: -atom.y * scale
  }));
  const xs = scaledAtoms.map((atom) => atom.x);
  const ys = scaledAtoms.map((atom) => atom.y);
  const center = {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2
  };
  let atoms = scaledAtoms.map((atom) => ({
    ...atom,
    x: atom.x + point.x - center.x,
    y: atom.y + point.y - center.y
  }));
  const geometry = moleculeGeometryFromAtoms(atoms);
  const boundedX = clamp(geometry.x, 0, Math.max(0, page.width - geometry.width));
  const boundedY = clamp(geometry.y, 0, Math.max(0, page.height - geometry.height));
  const shiftX = boundedX - geometry.x;
  const shiftY = boundedY - geometry.y;

  if (Math.abs(shiftX) > 0.001 || Math.abs(shiftY) > 0.001) {
    atoms = atoms.map((atom) => ({
      ...atom,
      x: atom.x + shiftX,
      y: atom.y + shiftY
    }));
  }

  return atoms;
}

function averageParsedMolfileBondLength(graph: ParsedMolfileGraph): number {
  const atomById = new Map(graph.atoms.map((atom) => [atom.id, atom]));
  const lengths = graph.bonds
    .map((bond) => {
      const fromAtom = atomById.get(bond.fromAtomId);
      const toAtom = atomById.get(bond.toAtomId);
      return fromAtom && toAtom ? Math.hypot(fromAtom.x - toAtom.x, fromAtom.y - toAtom.y) : 0;
    })
    .filter((length) => length > 0.0001);

  if (lengths.length === 0) {
    return 0;
  }

  return lengths.reduce((sum, length) => sum + length, 0) / lengths.length;
}

// Per-molecule cache of the ring-interior side map (molecule objects are immutable, so a new
// object is produced on every edit). Avoids recomputing ring perception for each bond when
// defaultDoubleBondSide is called inside a bond .map.
const ringInteriorSideCache = new WeakMap<MoleculeObject, Map<string, NativeDoubleBondSide>>();

function ringInteriorSideForBond(molecule: MoleculeObject, bondId: string): NativeDoubleBondSide | undefined {
  let sides = ringInteriorSideCache.get(molecule);
  if (!sides) {
    sides = ringInteriorDoubleBondSides(molecule);
    ringInteriorSideCache.set(molecule, sides);
  }
  return sides.get(bondId);
}

export function defaultDoubleBondSide(molecule: MoleculeObject, bond: MoleculeBond): NativeDoubleBondSide {
  // Leave these bonds automatic so the app, CLI and MCP all use the renderer's joined Center
  // geometry. Explicit user display choices are preserved by callers, not defaulted here.
  if (isDefaultCenteredDoubleBond(molecule, bond)) return undefined;

  // A ring double bond's inner line belongs inside the ring — the authoritative default,
  // matching what layout-engine renders. Only fall back to the substituent heuristic for
  // non-ring (chain) double bonds.
  const ringSide = ringInteriorSideForBond(molecule, bond.id);
  if (ringSide) {
    return ringSide;
  }

  const geometry = bondGeometry(molecule, bond);
  if (!geometry) {
    return "left";
  }

  const { fromAtom, toAtom, normal } = geometry;
  const score = molecule.bonds.reduce((sum, candidate) => {
    const neighborId =
      candidate.id === bond.id
        ? undefined
        : candidate.fromAtomId === fromAtom.id
          ? candidate.toAtomId
          : candidate.toAtomId === fromAtom.id
            ? candidate.fromAtomId
            : candidate.fromAtomId === toAtom.id
              ? candidate.toAtomId
              : candidate.toAtomId === toAtom.id
                ? candidate.fromAtomId
                : undefined;
    const sourceAtom =
      candidate.fromAtomId === fromAtom.id || candidate.toAtomId === fromAtom.id
        ? fromAtom
        : candidate.fromAtomId === toAtom.id || candidate.toAtomId === toAtom.id
          ? toAtom
          : undefined;
    const neighborAtom = neighborId
      ? molecule.atoms.find((atom) => atom.id === neighborId)
      : undefined;
    if (!sourceAtom || !neighborAtom) {
      return sum;
    }

    return sum + (neighborAtom.x - sourceAtom.x) * normal.x + (neighborAtom.y - sourceAtom.y) * normal.y;
  }, 0);

  return score >= 0 ? "left" : "right";
}

export function bondGeometry(
  molecule: MoleculeObject,
  bond: MoleculeBond
): {
  fromAtom: MoleculeAtom;
  toAtom: MoleculeAtom;
  normal: PagePoint;
} | undefined {
  const fromAtom = molecule.atoms.find((atom) => atom.id === bond.fromAtomId);
  const toAtom = molecule.atoms.find((atom) => atom.id === bond.toAtomId);
  if (!fromAtom || !toAtom) {
    return undefined;
  }

  const dx = toAtom.x - fromAtom.x;
  const dy = toAtom.y - fromAtom.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return undefined;
  }

  return {
    fromAtom,
    toAtom,
    normal: {
      x: -dy / length,
      y: dx / length
    }
  };
}

export function normalizeNativeMoleculeGeometry(molecule: MoleculeObject): MoleculeObject {
  if (molecule.atoms.length === 0) {
    return {
      ...molecule,
      width: 0,
      height: 0
    };
  }

  const geometry = moleculeGeometryFromAtoms(molecule.atoms);
  return {
    ...molecule,
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    height: geometry.height
  };
}

export function moleculeGeometryFromAtoms(atoms: readonly MoleculeAtom[]): Pick<MoleculeObject, "x" | "y" | "width" | "height"> {
  const xs = atoms.map((atom) => atom.x);
  const ys = atoms.map((atom) => atom.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const x = minX - nativeMoleculePadding;
  const y = minY - nativeSingleBondDimensions.height / 2;

  return {
    x,
    y,
    width: Math.max(nativeSingleBondDimensions.width, maxX - minX + nativeMoleculePadding * 2),
    height: Math.max(nativeSingleBondDimensions.height, maxY - minY + nativeSingleBondDimensions.height)
  };
}
