/**
 * Layered chemical-identity snapshots and diffs (Phase 1A — app-owned layer).
 *
 * This is the safety foundation for the 3D spin → flatten feature
 * (`docs`/`bright-spinning-panda.md`). Before a molecule is handed to any 3D
 * engine, and again after the flattened result is committed, we snapshot its
 * chemical identity and diff the two. If identity drifts — a stereocenter
 * inverts, specified stereo becomes unknown (or vice-versa), an atom/bond
 * appears or vanishes, charge/isotope/radical changes — the caller must warn or
 * refuse the commit (priority #1 in AGENTS.md: chemical identity must not be
 * silently changed).
 *
 * The snapshot is deliberately *layered* so the conformer engine can never also
 * be the sole stereo-safety authority (correlated-failure trap):
 *
 *   1. `graph` — APP-OWNED, engine-free invariants computed here from the native
 *      `MoleculeObject` graph. Element/charge multiset, bond-order multiset, a
 *      Weisfeiler-Lehman connectivity signature, and a display-level stereo-marker
 *      fingerprint (wedge/hash bonds). Coordinate-independent by construction.
 *   2. `canonical` — ENGINE-BACKED (OpenChemLib canonical/parity, or RDKit in the
 *      test oracle). Injected via `SnapshotIdentityOptions.canonicalize`; absent in
 *      Phase 1A, which is honest: the diff then reports perceived R/S·E/Z as
 *      *not comparable* rather than falsely asserting "identical".
 *
 * Notes / known layer-1 limits (resolved by layer 2 + the Phase 1B/1C corpus):
 *   - WL is a 2D-graph hash; it does not by itself distinguish stereoisomers.
 *     That is exactly why the stereo-marker fingerprint and the engine layer
 *     exist alongside it.
 *   - Isotopes and radicals are not fields on `MoleculeAtom`; they are read from
 *     `molecule.chemistry` metadata, recorded with `isotopeRadicalSource` so the
 *     diff is honest about provenance.
 *     TODO(chem-core): upgrade isotope/radical capture to a native V3000 parse of
 *     `molecule.structure` once a first-party molfile parser lands.
 *   - Stereo markers are keyed by WL atom invariants, so symmetric environments
 *     can collide; such cases are deferred to the perceived-stereo engine layer.
 */

import type { MoleculeObject, MoleculeAtom, MoleculeBond } from "./schemas";

/** Bond display styles that encode stereochemistry (vs. `bold`/`dashed` cosmetics). */
export type StereoMarkerStyle = "wedge" | "hashed";

/** A wedge/hash marker, keyed by the WL invariants of its endpoints (id-independent). */
export interface StereoMarkerFingerprint {
  /** Invariant of the narrow-end (origin) atom — molfile wedge convention. */
  fromInvariant: string;
  /** Invariant of the wide-end (destination) atom. */
  toInvariant: string;
  style: StereoMarkerStyle;
}

export type IsotopeRadicalSource = "metadata" | "none";

/** Layer 1: engine-free, coordinate-independent graph identity. */
export interface MoleculeGraphIdentity {
  atomCount: number;
  bondCount: number;
  /** Sorted multiset of `"element:formalCharge"`. */
  atomMultiset: string[];
  /** Sorted multiset of bond orders. */
  bondOrderMultiset: string[];
  /** Sum of formal charges over atoms. */
  netCharge: number;
  /** Hash of the sorted Weisfeiler-Lehman atom colors. */
  connectivitySignature: string;
  /** Display-level stereo markers, canonicalized and sorted. */
  stereoMarkers: StereoMarkerFingerprint[];
  /** Sorted isotope labels (metadata-backed in Phase 1A). */
  isotopeLabels: string[];
  radicalCount: number;
  isotopeRadicalSource: IsotopeRadicalSource;
}

/** Layer 2: engine-provided canonical/perceived identity (injected later). */
export interface CanonicalChemicalIdentity {
  /** Canonical isomeric / CX representation from a chemistry engine. */
  canonicalString: string;
  engine: string;
}

export interface MoleculeIdentitySnapshot {
  graph: MoleculeGraphIdentity;
  /** Undefined in Phase 1A (no engine) → perceived stereo is "not comparable". */
  canonical?: CanonicalChemicalIdentity;
}

export interface SnapshotIdentityOptions {
  /** Engine-agnostic canonicalizer; omit for an app-owned graph-only snapshot. */
  canonicalize?: (molecule: MoleculeObject) => CanonicalChemicalIdentity;
}

export type IdentityVerdict =
  | "identical" // graph identical AND (canonical identical, or no specified stereo to perceive)
  | "changed" // a graph or display-stereo invariant differs
  | "indeterminate"; // graph identical but perceived stereo could not be compared (no engine)

export interface StereoMarkerDiff {
  /** Plain bond → wedge/hash. */
  becameSpecified: number;
  /** Wedge/hash → plain. */
  becameUnspecified: number;
  /** Same local environment, different wedge/hash style. */
  directionOrStyleFlipped: number;
}

export interface MoleculeIdentityDiff {
  verdict: IdentityVerdict;
  atomCountDelta: number;
  bondCountDelta: number;
  atomMultisetChanged: boolean;
  bondOrderMultisetChanged: boolean;
  netChargeDelta: number;
  connectivityChanged: boolean;
  stereoMarkers: StereoMarkerDiff;
  isotopeLabelsChanged: boolean;
  radicalCountDelta: number;
  /** True only when both snapshots carry a canonical (engine) layer. */
  perceivedStereoComparable: boolean;
  /** Defined only when `perceivedStereoComparable`. */
  canonicalChanged?: boolean;
  /** Human-readable drivers of the verdict. */
  reasons: string[];
}

/** FNV-1a 32-bit hash → 8-char hex. Deterministic, dependency-free, bounded. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function atomInitialColor(atom: MoleculeAtom): string {
  return `${atom.element}:${atom.formalCharge ?? 0}`;
}

/**
 * 1-dimensional Weisfeiler-Lehman color refinement over the bond graph. Produces
 * an order- and id-independent color per atom that encodes its rooted neighborhood
 * (element + charge + incident bond orders) out to `rounds` hops.
 */
function weisfeilerLehmanColors(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  rounds = 3
): Map<string, string> {
  const adjacency = new Map<string, Array<{ neighbor: string; order: string }>>();
  atoms.forEach((atom) => adjacency.set(atom.id, []));
  bonds.forEach((bond) => {
    adjacency.get(bond.fromAtomId)?.push({ neighbor: bond.toAtomId, order: bond.order });
    adjacency.get(bond.toAtomId)?.push({ neighbor: bond.fromAtomId, order: bond.order });
  });

  let colors = new Map(atoms.map((atom) => [atom.id, atomInitialColor(atom)] as const));
  for (let round = 0; round < rounds; round += 1) {
    const next = new Map<string, string>();
    for (const atom of atoms) {
      const neighborhood = (adjacency.get(atom.id) ?? [])
        .map((edge) => `${edge.order}#${colors.get(edge.neighbor) ?? "?"}`)
        .sort()
        .join(",");
      next.set(atom.id, fnv1a(`${colors.get(atom.id) ?? "?"}|${neighborhood}`));
    }
    colors = next;
  }
  return colors;
}

function isStereoStyle(style: string | undefined): style is StereoMarkerStyle {
  return style === "wedge" || style === "hashed";
}

function compareMarkers(left: StereoMarkerFingerprint, right: StereoMarkerFingerprint): number {
  return (
    left.fromInvariant.localeCompare(right.fromInvariant) ||
    left.toInvariant.localeCompare(right.toInvariant) ||
    left.style.localeCompare(right.style)
  );
}

/**
 * Snapshot a molecule's chemical identity. Phase 1A fills the engine-free `graph`
 * layer; an injected `canonicalize` (engine) fills `canonical`.
 */
export function snapshotChemicalIdentity(
  molecule: MoleculeObject,
  options: SnapshotIdentityOptions = {}
): MoleculeIdentitySnapshot {
  const atoms = molecule.atoms;
  const bonds = molecule.bonds;
  const colors = weisfeilerLehmanColors(atoms, bonds);

  const atomMultiset = atoms.map(atomInitialColor).sort();
  const bondOrderMultiset = bonds.map((bond) => bond.order).sort();
  const netCharge = atoms.reduce((total, atom) => total + (atom.formalCharge ?? 0), 0);
  const connectivitySignature = fnv1a([...colors.values()].sort().join(";"));

  const stereoMarkers = bonds
    .filter((bond) => isStereoStyle(bond.display?.bondStyle))
    .map((bond) => ({
      fromInvariant: colors.get(bond.fromAtomId) ?? "?",
      toInvariant: colors.get(bond.toAtomId) ?? "?",
      style: bond.display?.bondStyle as StereoMarkerStyle
    }))
    .sort(compareMarkers);

  const chemistry = molecule.chemistry;
  const graph: MoleculeGraphIdentity = {
    atomCount: atoms.length,
    bondCount: bonds.length,
    atomMultiset,
    bondOrderMultiset,
    netCharge,
    connectivitySignature,
    stereoMarkers,
    isotopeLabels: [...(chemistry?.isotopeLabels ?? [])].sort(),
    radicalCount: chemistry?.radicalCount ?? 0,
    isotopeRadicalSource: chemistry ? "metadata" : "none"
  };

  const snapshot: MoleculeIdentitySnapshot = { graph };
  if (options.canonicalize) {
    snapshot.canonical = options.canonicalize(molecule);
  }
  return snapshot;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function markerStyleByKey(markers: readonly StereoMarkerFingerprint[]): Map<string, string> {
  // key = directional endpoint invariants; value = sorted styles (handles rare
  // symmetric collisions deterministically, deferring true parity to the engine layer).
  const byKey = new Map<string, string[]>();
  for (const marker of markers) {
    const key = `${marker.fromInvariant}>${marker.toInvariant}`;
    const styles = byKey.get(key) ?? [];
    styles.push(marker.style);
    byKey.set(key, styles);
  }
  const collapsed = new Map<string, string>();
  for (const [key, styles] of byKey) {
    collapsed.set(key, [...styles].sort().join("+"));
  }
  return collapsed;
}

function diffStereoMarkers(
  before: readonly StereoMarkerFingerprint[],
  after: readonly StereoMarkerFingerprint[]
): StereoMarkerDiff {
  const beforeByKey = markerStyleByKey(before);
  const afterByKey = markerStyleByKey(after);
  let becameSpecified = 0;
  let becameUnspecified = 0;
  let directionOrStyleFlipped = 0;

  for (const [key, afterStyle] of afterByKey) {
    const beforeStyle = beforeByKey.get(key);
    if (beforeStyle === undefined) {
      becameSpecified += 1;
    } else if (beforeStyle !== afterStyle) {
      directionOrStyleFlipped += 1;
    }
  }
  for (const key of beforeByKey.keys()) {
    if (!afterByKey.has(key)) {
      becameUnspecified += 1;
    }
  }
  return { becameSpecified, becameUnspecified, directionOrStyleFlipped };
}

/**
 * Diff two identity snapshots. Verdict semantics:
 *  - `changed`: a graph invariant or a display-stereo marker differs.
 *  - `identical`: graph identical AND (canonical identical, or there is no
 *    specified stereo on either side, so there is nothing to perceive).
 *  - `indeterminate`: graph identical and stereo markers unchanged, but specified
 *    stereo exists and no engine layer was available to compare perceived R/S·E/Z.
 *    This is an HONEST non-guarantee — callers should require an engine layer (and
 *    a passing corpus) before treating such a flatten as safe.
 */
export function diffChemicalIdentity(
  before: MoleculeIdentitySnapshot,
  after: MoleculeIdentitySnapshot
): MoleculeIdentityDiff {
  const reasons: string[] = [];

  const atomCountDelta = after.graph.atomCount - before.graph.atomCount;
  const bondCountDelta = after.graph.bondCount - before.graph.bondCount;
  const atomMultisetChanged = !arraysEqual(before.graph.atomMultiset, after.graph.atomMultiset);
  const bondOrderMultisetChanged = !arraysEqual(
    before.graph.bondOrderMultiset,
    after.graph.bondOrderMultiset
  );
  const netChargeDelta = after.graph.netCharge - before.graph.netCharge;
  const connectivityChanged =
    before.graph.connectivitySignature !== after.graph.connectivitySignature;
  const isotopeLabelsChanged = !arraysEqual(
    before.graph.isotopeLabels,
    after.graph.isotopeLabels
  );
  const radicalCountDelta = after.graph.radicalCount - before.graph.radicalCount;
  const stereoMarkers = diffStereoMarkers(
    before.graph.stereoMarkers,
    after.graph.stereoMarkers
  );

  if (atomCountDelta !== 0) reasons.push(`atom count changed by ${atomCountDelta}`);
  if (bondCountDelta !== 0) reasons.push(`bond count changed by ${bondCountDelta}`);
  if (atomMultisetChanged) reasons.push("element/charge multiset changed");
  if (bondOrderMultisetChanged) reasons.push("bond-order multiset changed");
  if (netChargeDelta !== 0) reasons.push(`net charge changed by ${netChargeDelta}`);
  if (connectivityChanged) reasons.push("connectivity signature changed");
  if (isotopeLabelsChanged) reasons.push("isotope labels changed");
  if (radicalCountDelta !== 0) reasons.push(`radical count changed by ${radicalCountDelta}`);
  if (stereoMarkers.becameSpecified > 0)
    reasons.push(`${stereoMarkers.becameSpecified} stereo marker(s) newly specified`);
  if (stereoMarkers.becameUnspecified > 0)
    reasons.push(`${stereoMarkers.becameUnspecified} stereo marker(s) became unspecified`);
  if (stereoMarkers.directionOrStyleFlipped > 0)
    reasons.push(`${stereoMarkers.directionOrStyleFlipped} stereo marker(s) flipped`);

  const graphChanged =
    atomCountDelta !== 0 ||
    bondCountDelta !== 0 ||
    atomMultisetChanged ||
    bondOrderMultisetChanged ||
    netChargeDelta !== 0 ||
    connectivityChanged ||
    isotopeLabelsChanged ||
    radicalCountDelta !== 0;
  const stereoMarkersChanged =
    stereoMarkers.becameSpecified > 0 ||
    stereoMarkers.becameUnspecified > 0 ||
    stereoMarkers.directionOrStyleFlipped > 0;

  const perceivedStereoComparable =
    before.canonical !== undefined && after.canonical !== undefined;
  const canonicalChanged = perceivedStereoComparable
    ? before.canonical?.canonicalString !== after.canonical?.canonicalString
    : undefined;
  if (canonicalChanged) reasons.push("canonical representation changed");

  const hasSpecifiedStereo =
    before.graph.stereoMarkers.length > 0 || after.graph.stereoMarkers.length > 0;

  let verdict: IdentityVerdict;
  if (graphChanged || stereoMarkersChanged || canonicalChanged === true) {
    verdict = "changed";
  } else if (perceivedStereoComparable) {
    verdict = "identical"; // canonical present and unchanged
  } else if (hasSpecifiedStereo) {
    verdict = "indeterminate";
    reasons.push(
      "graph and stereo markers identical, but perceived R/S·E/Z not compared (no engine layer)"
    );
  } else {
    verdict = "identical"; // no specified stereo → nothing left to perceive
  }

  return {
    verdict,
    atomCountDelta,
    bondCountDelta,
    atomMultisetChanged,
    bondOrderMultisetChanged,
    netChargeDelta,
    connectivityChanged,
    stereoMarkers,
    isotopeLabelsChanged,
    radicalCountDelta,
    perceivedStereoComparable,
    canonicalChanged,
    reasons
  };
}
