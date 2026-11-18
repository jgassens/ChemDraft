import { isDeepStrictEqual } from "node:util";
import { indexedChargeChange, testResonance, type ResonanceGraph, type ResonanceResult } from "./resonance";
import { compareExactGraph, compareSigma, type MappedFeature, type SigmaComparison } from "./sigma";
import { stepArrowLosses } from "./survival";
import { compareAtomSite, compareBondSite, pairUnique, placementTolerance, positionIndex, samePlacement, type AtomSite, type BondSite, type MoleculeSites, type Placement, type Point, type SiteComparison } from "./placement";

export type Format = "cdx" | "cdxml";
export const errorStages = ["copy", "detect", "import", "summary", "export-cdx", "export-cdxml", "reimport-cdx", "reimport-cdxml", "cross", "truth"] as const;
export type ErrorStage = typeof errorStages[number];
export interface WorkerProgress {
  type: "progress";
  stage: ErrorStage;
  format: Format | "unknown";
  parseOk: boolean;
  size: number;
  elapsedMs: number;
  stageMs: Partial<Record<ErrorStage, number>>;
}
export interface StageError {
  stage: ErrorStage;
  code: string;
  category: string;
  message: string;
  rdkitReason?: string;
  /** Private diagnostics only; never copied into reports or stderr. */
  stack?: string[];
}
export const chemistryFeatures = ["stereo", "stereo-display", "charge", "isotope", "radical", "abbreviation", "r-group", "reaction-roles", "reaction-step-arrow", "display-object", "bracket-pair", "bracket-usage", "bracket-repeat-count", "bracket-repeat-unit", "bracket-members", "bracket-crossing-bonds", "bracket-drawing", "atom-bond-count", "connectivity", "bond-order", "other", "sanitization-changed"] as const;
export type Feature = typeof chemistryFeatures[number];
export const drawingFeatures = ["arrows", "brackets", "text-styling", "colours", "pages", "other-graphics"] as const;
export type DrawingFeature = typeof drawingFeatures[number];
export function publicSanitizationReason(reason: unknown): string {
  return typeof reason === "string" && (/^valence(?::[A-Z][a-z]?)?$/.test(reason) || ["kekulize", "aromaticity", "ring-info", "parse", "other", "dative", "query-bond", "abbreviation", "r-group", "generic"].includes(reason)) ? reason : "other";
}
export interface Warning {
  category: string;
  message: string;
  features: Feature[];
  objectId?: string;
}
export interface MoleculeSummary {
  /** Interchange identity, distinct from the importer's positional native object ID. */
  originalId?: string;
  /** Private native drawing metadata; absent in legacy or standalone summaries. */
  pairing?: { page: number; centroid: [number, number]; bondLength: number; elements: string[]; labels: string[]; bonds: number };
  strict: boolean;
  recovery?: "fresh-molfile" | "fresh-molfile-unsanitized";
  species?: {
    version?: 2;
    inchiKey?: string;
    fixedHInchi?: string;
    explicitHSmiles?: string;
    graph?: ResonanceGraph;
    /** Legacy evidence is read only so rescore can replace it; never used as proof. */
    skeleton?: string;
    resonanceKey?: string;
  };
  sanitization?: {
    reason: string;
    rdkitReason?: string;
    /** Private RDKit diagnostic; never copied to public reports. */
    message?: string;
  };
  dummyAtoms: { kind: "abbreviation" | "r-group" | "generic"; label: string; count: number }[];
  atomCount: number;
  smiles: string;
  withoutStereo: string;
  connectivity: string;
  featureKeys: { charge: string; isotope: string; radical: string; stereo: string };
  featureAtoms?: { z: number; h: number; degree: number; charge: number; isotope: number; radical: number }[];
  /** RDKit graph evidence also retained for non-strict and recovery summaries. */
  featureBonds?: ResonanceGraph["bonds"];
  formula: string;
  hydrogenCount: number;
  charge: number;
  isotopes: { atom: number; mass: number }[];
  radicals: { atom: number; electrons: number }[];
  tetrahedral: { atom: number; cip: string }[];
  doubleBonds: { atoms: number[]; stereo: string }[];
  displays: { wedge: number; hash: number; either: number; wavy: number };
  wavyBondKeys?: string[]; // Legacy keys lacked a stable direction and atom identity.
  wavyBonds?: BondSite[];
  sites?: MoleculeSites;
  heavyAtoms: number;
  bonds: number;
  abbreviations: { label: string; expandedFragment?: string }[];
  rGroups: { label: string; semantics: string }[];
  objectId?: string;
}
/** Strings retain canonical molecular SMILES, including labelled dummy graphs. Other kinds
 * describe what was drawn without claiming a molecule identity. Kept distinct from SMILES. */
export type ReactionParticipantSummary = string
  | { kind: "text"; text: string }
  | { kind: "superatom" | "r-group-label"; label: string }
  | { kind: "unidentified"; objectType: string };
export interface BracketSummary {
  bracketKind: string | null; bracketUsage: string | null | (string | null)[]; repeatCount: number | string | null | (number | string | null)[];
  label: string | null; repeatUnit: string | boolean | null | (boolean | null)[]; memberCount: number; crossingBondCount: number;
  memberKeys?: string[];
  crossingBondKeys?: string[];
  objectIds?: string[];
  placements?: [Placement, Placement];
  members?: BracketMember[];
  crossings?: [BracketCrossing[], BracketCrossing[]];
}
export type BracketMember = { object: Placement; atom?: AtomSite } | { unresolved: string };
type InnerAtom = AtomSite | { unresolved: string };
export type BracketCrossing = ({ object: Placement; bond: BondSite } | { unresolved: [string, string] }) & { inner?: InnerAtom };
export interface Colour { role: string[]; value: string; atom?: AtomSite; bond?: BondSite }
interface NonTextColourSummary extends Placement {
  id?: string;
  colours?: string[];
  roles?: Colour[];
}
export interface Summary {
  survival?: import("./survival").SurvivalCounts;
  molecules: MoleculeSummary[];
  summaryErrors?: { objectId: string; summaryError: StageError }[];
  reactions: { reactants: ReactionParticipantSummary[]; products: ReactionParticipantSummary[]; agents: ReactionParticipantSummary[]; conditions: string[]; arrowKinds: string[]; objectId?: string }[];
  brackets?: BracketSummary[];
  unpairedBrackets?: number;
  standaloneAbbreviations: unknown[];
  standaloneRGroups: unknown[];
  nonTextColours?: NonTextColourSummary[];
  placements?: Placement[];
  drawing: Record<DrawingFeature, unknown>;
}
export interface Difference {
  feature: Feature;
  warned: boolean;
  molecule?: { before?: string; after?: string; change?: "added" | "removed" };
  delta?: { atomsAdded: string[]; atomsRemoved: string[]; bondsAdded: number; bondsRemoved: number; labelsAdded: string[]; labelsRemoved: string[] };
  classification?: "same-species-different-drawing" | "drawing-object-loss";
  identityCheck?: "standard-inchi" | "electron-pair-resonance";
  identityEvidence?: {
    standardInchi: "match" | "different" | "unavailable";
    fixedHydrogen: "fixed-h-inchi" | "explicit-h-smiles" | "mismatch" | "unavailable";
    resonance: ResonanceResult | "not-run";
    decision: "same-species" | "fixed-hydrogen-mismatch" | "resonance-rejected" | "protected-feature";
  };
  before: unknown;
  after: unknown;
}
export interface RoundTrip {
  route: string;
  verdict: "PASS" | "WARNED" | "FAIL" | "ERROR" | "SKIPPED" | "DRAWN-DIFFERENTLY";
  reason?: string;
  error?: StageError;
  errors?: StageError[];
  warnings: Warning[];
  differences: Difference[];
  /** Incomplete comparisons are neither measured losses nor equality. */
  undetermined?: { feature: typeof undeterminedFeatures[number]; molecule?: { before?: string; after?: string }; reason?: typeof missingStoredEvidence }[];
  drawingLoss: DrawingFeature[];
  summary?: Summary;
  comparisonInternalErrors?: number;
  identityPasses?: number;
  chemistryPassReason?: "identity";
  legs?: { before: Summary; after: Summary; warnings: Warning[] }[];
  bytes?: number;
  ms: number;
}
export const undeterminedFeatures = ["connectivity", "bond-order", "molecule-placement", "colour-placement",
  "wavy-placement", "wavy-direction", "bracket-placement", "bracket-members", "bracket-crossing-bonds"] as const;
export const missingStoredEvidence = "Missing stored placement or endpoint evidence. Re-run the harness because rescore cannot reconstruct it.";
export interface Result {
  truthSru?: { molecules: MoleculeSummary[]; notes: string[] };
  sourceSurvival?: import("./survival").SurvivalCounts;
  importComparison?: Comparison;
  id: string;
  group: string;
  era: string;
  format: Format | "unknown";
  size: number;
  parseOk: boolean;
  status: "ok" | "import-error" | "processing-error" | "crash" | "timeout" | "oom" | "copy-error";
  timeoutKind?: "import-hang" | "harness-slow";
  errorCategory?: string;
  errorMessage?: string;
  error?: StageError;
  errors?: StageError[];
  exitCode?: number | null;
  signal?: string | null;
  warnings: Warning[];
  summary?: Summary;
  roundTrips: RoundTrip[];
  timings: { totalMs: number; importMs?: number; summaryMs?: number; stageMs?: Partial<Record<ErrorStage, number>> };
}
export type Comparison = Pick<RoundTrip, "verdict" | "differences" | "undetermined" | "drawingLoss" | "comparisonInternalErrors" | "identityPasses" | "chemistryPassReason">;
export const jsonEqual = (a: unknown, b: unknown) => isDeepStrictEqual(a, b);
export const sorted = <T>(items: T[]): T[] => items.sort((a, b) => {
  const first = JSON.stringify(a), second = JSON.stringify(b);
  return first < second ? -1 : first > second ? 1 : 0;
});

// Explicit warning-category → feature contract. Unrecognised categories cannot excuse a loss.
// The message must ALSO name the feature: a general category never grants a blanket exemption.
const categoryFeatures: Readonly<Record<string, readonly Feature[]>> = {
  "cdxml.open_double_bond_native_only": ["stereo"],
  "cdxml.bond_display_unsupported": ["stereo"],
  "cdxml.atom_radical_unsupported": ["radical", "atom-bond-count"],
  "cdxml.abbreviation_not_expanded": ["abbreviation"],
  "cdxml.label_bond_side_turned": ["abbreviation", "other"],
  "cdxml.bonded_element_label_exported": ["abbreviation", "other"],
  "cdxml.atom_element_symbol_exported": ["other"],
  "cdxml.atom_element_unknown": ["other"],
  "cdxml.bond_endpoints_invalid": ["atom-bond-count"],
  "cdxml.empty_fragment_skipped": ["atom-bond-count"],
  "cdxml.unknown_bond_order": ["bond-order"],
  "cdxml.bond_order_import_unsupported": ["bond-order"],
  "cdxml.aromatic_bond_approximation": ["bond-order"],
  "cdxml.aromatic_bond_import_approximation": ["bond-order"],
  "cdxml.dashed_single_read_as_dative": ["bond-order"],
  "cdxml.reaction_scheme_export_partial": ["reaction-roles"],
  "cdxml.reaction_reference_unresolved": ["reaction-step-arrow"],
  "cdxml.reaction_step_preserved": ["reaction-step-arrow"],
  "cdxml.bracket_loss": ["bracket-pair", "bracket-usage", "bracket-repeat-count", "bracket-repeat-unit", "bracket-members", "bracket-crossing-bonds", "bracket-drawing"],
  "cdxml.bracket_payload_only": ["bracket-pair"],
  "cdxml.bracket_type_preserved": ["display-object", "bracket-drawing"],
  "cdxml.bracket_group_preserved": ["display-object", "bracket-pair", "bracket-usage", "bracket-repeat-count", "bracket-members", "bracket-crossing-bonds"],
  "cdxml.bracket_nested_group_preserved": ["display-object", "bracket-pair", "bracket-usage", "bracket-repeat-count", "bracket-members", "bracket-crossing-bonds"],
  "cdxml.object_export_unsupported": ["abbreviation", "r-group", "display-object"],
  "cdxml.object_import_unsupported": ["abbreviation", "r-group", "display-object"],
  "cdxml.molecule_metadata_payload_only": [], // Aggregates; this diagnostic says isotopes survive.
  "cdx.property_skipped": chemistryFeatures,
  "cdx.unencodable_data": chemistryFeatures,
  "cdx.text_encoding_loss": ["abbreviation", "r-group"],
  // Stable, feature-specific categories also used by injected synthetic conversion diagnostics.
  "cdxml.charge_loss": ["charge"], "cdxml.charge_not_saved": ["charge"],
  "cdxml.isotope_loss": ["isotope"], "cdxml.isotope_not_saved": ["isotope"]
};
const namedFeatures: [Feature, RegExp][] = [
  ["stereo", /\b(stereo(?:chemistry|centres?|centers?)?|E\/Z|CIP)\b/i],
  ["stereo-display", /\b(wedge(?:hash)?(?:begin|end|s)?|wedgedhash(?:begin|end)?|hash(?:es)?|wavy|display)\b/i],
  ["charge", /\b(charges?|charged)\b/i],
  ["isotope", /\b(isotopes?|isotopic)\b/i],
  ["radical", /\b(radicals?|unpaired electrons?)\b/i],
  ["abbreviation", /\b(abbreviations?|superatoms?|condensed labels?|group labels?)\b/i],
  ["r-group", /\bR[- ]?groups?\b/i],
  ["reaction-roles", /\b(reaction scheme|reaction role|reactant|product|agent role)\b/i],
  ["reaction-step-arrow", /\b(ReactionStepArrows|step[- ]arrow|arrow link)\b/i],
  ["display-object", /\b(graphic|circle|oval|line|rectangle|arc|curve|arrow|text|bracket|embeddedobject|table|spectrum)s?\b/i],
  ["bracket-pair", /\bbrackets?\b(?!\s+(?:usage|repeat|members?|label|kind))/i],
  ["bracket-usage", /\bbracket usage\b/i],
  ["bracket-repeat-count", /\b(repeat count|multiplier)\b/i],
  ["bracket-repeat-unit", /\brepeat unit\b/i],
  ["bracket-members", /\b(contained objects?|bracket members?)\b/i],
  ["bracket-crossing-bonds", /\bcrossing bonds?\b/i],
  ["bracket-drawing", /\bbracket (?:label|kind)\b/i],
  ["atom-bond-count", /\b(atom count|bond count|fragment skipped|atoms? (?:was|were) (?:skipped|removed)|bond endpoints)\b/i],
  ["bond-order", /\b(bond order|aromatic bond|dative|coordination)\b/i],
  ["other", /\batom element\b/i]
];
export function warning(input: { code: string; message: string; sourceObjectId?: string; objectId?: string }): Warning {
  return {
    category: /^[a-z][a-z0-9_.-]{0,100}$/i.test(input.code) ? input.code : "warning.unclassified",
    message: input.message,
    features: namedFeatures.filter(([feature, pattern]) => categoryFeatures[input.code]?.includes(feature) && pattern.test(input.message)
      // A generic preservation warning cannot excuse a step-link loss. Both the step
      // identity and the arrow-link attribute must be present in its diagnostic.
      && (feature !== "reaction-step-arrow" || /\bstep\s+(?!\(unknown\))[^\s:]+\s*:/i.test(input.message)
        && /\bReactionStepArrows\b/.test(input.message))).map(([feature]) => feature),
    objectId: input.sourceObjectId ?? input.objectId
  };
}

function moleculeValue(m: MoleculeSummary, feature: Feature): unknown {
  const atoms = m.featureAtoms ?? (m.species?.graph ? m.species.graph.atoms.map((atom, i) => ({ ...atom, degree: m.species!.graph!.bonds.filter(b => b.atoms.includes(i)).length })) : undefined);
  const atomFeature = (key: "charge" | "isotope" | "radical") => atoms
    ? sorted(atoms.filter(a => a[key]).map(a => [a.z, a[key], a.h, a.degree])) : undefined;
  switch (feature) {
    case "stereo": return { tetrahedral: sorted(m.tetrahedral.map(t => t.cip)), doubles: sorted(m.doubleBonds.map(b => b.stereo).filter(s => s !== "unspecified")) };
    case "stereo-display": return m.displays;
    case "charge": return [m.charge, atomFeature("charge")];
    case "isotope": return [sorted(m.isotopes.map(a => a.mass)), atomFeature("isotope")];
    case "radical": return [sorted(m.radicals.map(a => a.electrons)), atomFeature("radical")];
    case "atom-bond-count": return [m.heavyAtoms, m.bonds];
    case "sanitization-changed": return m.strict ?? true;
    case "connectivity": return [m.connectivity, m.hydrogenCount];
    case "bond-order": return m.connectivity;
    case "other": return [m.hydrogenCount, m.dummyAtoms ?? [], m.atomCount ?? m.heavyAtoms];
    case "abbreviation": return sorted([...m.abbreviations]);
    case "r-group": return sorted([...m.rGroups]);
  }
}

/** Pair objects before counting losses so an unchanged neutral feature on another molecule
 * cannot cancel a gain/loss and make two changed molecules look like one.
 */
function warningsCover<T extends { objectId?: string; smiles?: string; connectivity?: string }>(before: T[], after: T[], value: (item: T) => unknown, warnings: Warning[], feature: Feature): boolean {
  const a = [...before], b = [...after];
  const changed: { before?: T; after?: T; paired: boolean }[] = [];
  const record = (left: T | undefined, right: T | undefined, paired: boolean) => {
    if (!left || !right || !jsonEqual(value(left), value(right))) changed.push({ before: left, after: right, paired });
  };
  for (const key of ["objectId", "smiles", "connectivity"] as const) {
    for (let i = a.length - 1; i >= 0; i--) {
      const candidate = a[i][key];
      if (candidate === undefined) continue;
      const matches = b.flatMap((other, index) => other[key] === candidate ? [index] : []);
      if (!matches.length) continue;
      record(a.splice(i, 1)[0], b.splice(matches[0], 1)[0], matches.length === 1);
    }
  }
  // Remaining graphs changed identity, or have no identity metadata. Prefer equal feature
  // values; arbitrary pairings may use a source warning but never a guessed destination ID.
  while (a.length || b.length) {
    const left = a.shift();
    let index = left ? b.findIndex(right => jsonEqual(value(left), value(right))) : -1;
    const paired = a.length === 0 && b.length === 1;
    if (index < 0 && b.length) index = 0;
    record(left, index >= 0 ? b.splice(index, 1)[0] : undefined, paired);
  }
  if (!changed.length) return false;
  const available = warnings.filter(w => w.features.includes(feature));
  for (const pair of changed) {
    const match = available.findIndex(w => w.objectId === undefined
      ? changed.length === 1
      : w.objectId === pair.before?.objectId || (pair.paired && w.objectId === pair.after?.objectId));
    if (match < 0) return false;
    available.splice(match, 1);
  }
  return true;
}

const reactionValue = (r: Summary["reactions"][number]) => ({
  reactants: sorted([...r.reactants]), products: sorted([...r.products]),
  agents: sorted([...r.agents]), conditions: sorted([...r.conditions]), arrowKinds: sorted([...r.arrowKinds])
});

export const bracketValue = ({ objectIds: _objectIds, placements: _placements, ...value }: BracketSummary) => value;


function placementPairs<T>(before: readonly T[], after: readonly T[], same: (a: T, b: T) => boolean, locate: (item: T) => (Point & { scope: string | number }) | undefined) {
  return pairUnique(before, after, same, items => {
    const index = positionIndex(items, locate);
    return item => index(locate(item), other => same(item, other));
  });
}

const placementKind = (p: Placement) => JSON.stringify([p.page, p.type, p.graphicKind]);
const placementScope = (p: Placement) => ({ ...p, scope: JSON.stringify([placementKind(p), p.structure]) });
const placementKey = (p: Placement) => JSON.stringify([p.page, p.id]);
type PlacementComparison = ReturnType<typeof comparePlacements>;

const hasAtomEvidence = (site: AtomSite) => Array.isArray(site.neighbours);
const hasBondEvidence = (bond: BondSite) => bond.length === 2 && bond.every(hasAtomEvidence);
const hasSiteInventory = (sites?: MoleculeSites) =>
  !!sites?.atoms?.length && Array.isArray(sites.bonds) && sites.atoms.every(hasAtomEvidence) && sites.bonds.every(hasBondEvidence);

function placementEvidence(summary: Summary) {
  const placements = summary.placements ?? [];
  const incompleteKinds = new Set(placements.filter(p => p.id === undefined ||
    p.type === "molecule" && p.structure === undefined).map(placementKind));
  const byId = new Map(placements.map(p => [placementKey(p), p]));
  const graphs = new Map(summary.molecules.filter(m => hasSiteInventory(m.sites)).map(m => [m.objectId, m.sites]));
  const hasCandidates = (ref: Placement) => !!summary.placements && !incompleteKinds.has(placementKind(ref));
  return {
    placements, byId, hasCandidates,
    hasObject(ref: Placement) {
      const object = byId.get(placementKey(ref));
      return ref.id !== undefined && hasCandidates(ref) && !!object &&
        (ref.type !== "molecule" || ref.structure !== undefined) && samePlacement(ref, object);
    },
    graph: (ref: Placement) => graphs.get(ref.id)
  };
}

export function comparePlacements(before: Summary, after: Summary) {
  const left = placementEvidence(before), right = placementEvidence(after);
  const matches = placementPairs(left.placements, right.placements, samePlacement, placementScope);
  return {
    left, right,
    objects(a: Placement, b: Placement): SiteComparison {
      if (!left.hasObject(a) || !right.hasObject(b)) return "ambiguous";
      const x = left.byId.get(placementKey(a))!, y = right.byId.get(placementKey(b))!;
      if (matches.ambiguousBefore.has(x) || matches.ambiguousAfter.has(y)) return "ambiguous";
      return matches.paired.get(x) === y ? "match" : "changed";
    },
    ambiguous(a: Placement, side: "before" | "after") {
      const site = (side === "before" ? left : right).byId.get(placementKey(a));
      return site !== undefined && (side === "before" ? matches.ambiguousBefore : matches.ambiguousAfter).has(site);
    },
    match(a: Placement) {
      const site = left.byId.get(placementKey(a));
      return site && matches.paired.get(site);
    },
    graph: (object: Placement, side: "before" | "after") =>
      (side === "before" ? left : right).graph(object)
  };
}

function compareReferences<T>(before: T[], after: T[], identity: (a: T, b: T) => SiteComparison, value?: (a: T, b: T) => SiteComparison): SiteComparison {
  let ambiguous = false;
  const left = before.map(value => ({ value, side: "before" }));
  const right = after.map(value => ({ value, side: "after" }));
  const { paired, ambiguousBefore, ambiguousAfter } = pairUnique(left, right, (a, b) => {
    if (a.side === b.side) return a === b;
    const result = a.side === "before" ? identity(a.value, b.value) : identity(b.value, a.value);
    if (result === "ambiguous") ambiguous = true;
    return result === "match";
  });
  if (ambiguous || ambiguousBefore.size || ambiguousAfter.size) return "ambiguous";
  if (paired.size !== before.length || paired.size !== after.length) return "changed";
  let changed = false;
  if (value) for (const [a, b] of paired) {
    const result = value(a.value, b.value);
    if (result === "ambiguous") return "ambiguous";
    if (result === "changed") changed = true;
  }
  return changed ? "changed" : "match";
}

const byValue = (a: unknown, b: unknown): SiteComparison => jsonEqual(a, b) ? "match" : "changed";

function nonTextColoursComparison(before: Summary, after: Summary, placement: PlacementComparison): SiteComparison {
  const left = before.nonTextColours ?? [], right = after.nonTextColours ?? [];
  const ambiguous = (item: NonTextColourSummary, side: "before" | "after") => {
    if (placement.ambiguous(item, side)) return true;
    const graph = placement.graph(item, side);
    return item.roles?.some(({ atom, bond }) =>
      (atom && compareAtomSite(atom, atom, graph, graph) === "ambiguous") ||
      (bond && compareBondSite(bond, bond, graph, graph) === "ambiguous"));
  };
  if (left.some(item => ambiguous(item, "before")) || right.some(item => ambiguous(item, "after"))) return "ambiguous";
  // Look up each colour on the match from the full inventory, including uncoloured objects.
  const rightById = new Map(right.map(p => [placementKey(p), p]));
  let matched = 0, changed = false;
  for (const a of left) {
    const object = placement.match(a);
    const b = object && rightById.get(placementKey(object));
    if (!b) continue;
    matched++;
    const leftGraph = placement.graph(a, "before"), rightGraph = placement.graph(b, "after");
    const result = compareReferences(a.roles!, b.roles!, (x, y) => {
      if (!jsonEqual(x.role, y.role)) return "changed";
      if (x.atom && y.atom) return compareAtomSite(x.atom, y.atom, leftGraph, rightGraph);
      if (x.bond && y.bond) return compareBondSite(x.bond, y.bond, leftGraph, rightGraph);
      return byValue([x.atom, x.bond], [y.atom, y.bond]);
    }, (x, y) => byValue(x.value, y.value));
    if (result === "ambiguous") return "ambiguous";
    if (result === "changed") changed = true;
  }
  return changed || matched !== left.length || matched !== right.length ? "changed" : "match";
}

function compareMember(a: BracketMember, b: BracketMember, placement: PlacementComparison): SiteComparison {
  if ("unresolved" in a || "unresolved" in b) return byValue(a, b);
  const objects = placement.objects(a.object, b.object);
  if (objects !== "match") return objects;
  return a.atom && b.atom ? compareAtomSite(a.atom, b.atom, placement.graph(a.object, "before"), placement.graph(b.object, "after"))
    : byValue(a.atom, b.atom);
}

function compareCrossingBond(a: BracketCrossing, b: BracketCrossing, placement: PlacementComparison): SiteComparison {
  if ("unresolved" in a || "unresolved" in b) {
    return byValue("unresolved" in a ? a.unresolved : null, "unresolved" in b ? b.unresolved : null);
  }
  const objects = placement.objects(a.object, b.object);
  if (objects !== "match") return objects;
  return compareBondSite(a.bond, b.bond, placement.graph(a.object, "before"), placement.graph(b.object, "after"));
}

function compareInner(a: BracketCrossing, b: BracketCrossing, placement: PlacementComparison): SiteComparison {
  if (!a.inner || !b.inner || "unresolved" in a.inner || "unresolved" in b.inner) return byValue(a.inner, b.inner);
  return compareAtomSite(a.inner, b.inner,
    "object" in a ? placement.graph(a.object, "before") : undefined,
    "object" in b ? placement.graph(b.object, "after") : undefined);
}

function glyphAlignments(a: BracketSummary, b: BracketSummary): (0 | 1)[] {
  const left = a.placements, right = b.placements;
  if (!left || !right) return [];
  return ([0, 1] as const).filter(index => samePlacement(left[0], right[index]) && samePlacement(left[1], right[1 - index]));
}

function missingBracketEvidence(bracket: BracketSummary, evidence: ReturnType<typeof placementEvidence>) {
  const missing: ("bracket-members" | "bracket-crossing-bonds")[] = [];
  if (!bracket.members || bracket.members.length < bracket.memberCount || bracket.members.some(member =>
    "object" in member && (!evidence.hasObject(member.object) ||
      !!member.atom && (!hasAtomEvidence(member.atom) || !evidence.graph(member.object))))) missing.push("bracket-members");
  const crossings = bracket.crossings?.flat() ?? [];
  if (!bracket.crossings || crossings.length < bracket.crossingBondCount || crossings.some(crossing =>
    "object" in crossing && (!evidence.hasObject(crossing.object) || !evidence.graph(crossing.object) ||
      !hasBondEvidence(crossing.bond) || !!crossing.inner && !("unresolved" in crossing.inner) && !hasAtomEvidence(crossing.inner)))) {
    missing.push("bracket-crossing-bonds");
  }
  return missing;
}

const hasDrawingItems = (items: unknown) => Array.isArray(items) && items.length > 0;
export const lacksBracketPlacements = (summary: Summary) => summary.brackets
  ? summary.brackets.some(bracket => !bracket.placements)
  : hasDrawingItems(summary.drawing.brackets);

function lacksColourEvidence(summary: Summary, evidence: ReturnType<typeof placementEvidence>, other: ReturnType<typeof placementEvidence>) {
  return !summary.placements || !summary.nonTextColours || summary.nonTextColours.some(item =>
    !evidence.hasObject(item) || !other.hasCandidates(item) || !item.roles || item.roles.some(({ atom, bond }) =>
      (!!atom && !hasAtomEvidence(atom) || !!bond && !hasBondEvidence(bond) || !!(atom || bond) && !evidence.graph(item))));
}

/** Stored evidence must be sufficient both when comparing and when reading an old verdict. */
export function missingComparisonEvidence(before: Summary, after: Summary,
  left = placementEvidence(before), right = placementEvidence(after)) {
  const features = new Set<typeof undeterminedFeatures[number]>();
  for (const [summary, evidence] of [[before, left], [after, right]] as const) {
    if (lacksBracketPlacements(summary)) features.add("bracket-placement");
    for (const bracket of summary.brackets ?? []) for (const feature of missingBracketEvidence(bracket, evidence)) features.add(feature);
    if (summary.molecules.some(lacksWavyDirection)) features.add("wavy-direction");
  }
  const hasColour = (summary: Summary) => summary.nonTextColours?.length ||
    !summary.nonTextColours && hasDrawingItems(summary.drawing.colours);
  if ((hasColour(before) || hasColour(after)) && (lacksColourEvidence(before, left, right) || lacksColourEvidence(after, right, left))) {
    features.add("colour-placement");
  }
  return features;
}

export function compareBracket(a: BracketSummary, b: BracketSummary, placement: PlacementComparison) {
  const differences: { feature: Feature; before: unknown; after: unknown }[] = [];
  const ambiguous: ("bracket-members" | "bracket-crossing-bonds")[] = [];
  const missing = [...missingBracketEvidence(a, placement.left), ...missingBracketEvidence(b, placement.right)];
  const alignment = glyphAlignments(a, b)[0];
  const fields = [["bracket-usage", "bracketUsage"], ["bracket-repeat-count", "repeatCount"], ["bracket-repeat-unit", "repeatUnit"],
    ["bracket-members", "memberCount"], ["bracket-crossing-bonds", "crossingBondCount"], ["bracket-drawing", "bracketKind"], ["bracket-drawing", "label"]] as const;
  for (const [feature, field] of fields) {
    let left: unknown = a[field], right: unknown = b[field];
    if (left === right && field === "memberCount") {
      if (missing.includes("bracket-members")) continue;
      if (a.members && b.members) {
        const status = compareReferences(a.members, b.members, (x, y) => compareMember(x, y, placement));
        if (status === "match") continue;
        if (status === "ambiguous") { ambiguous.push("bracket-members"); continue; }
        left = a.members; right = b.members;
      }
    }
    if (left === right && field === "crossingBondCount") {
      if (missing.includes("bracket-crossing-bonds")) continue;
      if (a.crossings && b.crossings) {
        const ordered = [b.crossings[alignment], b.crossings[1 - alignment]];
        const statuses = a.crossings.map((attachment, i) => compareReferences(attachment, ordered[i],
          (x, y) => compareCrossingBond(x, y, placement), (x, y) => compareInner(x, y, placement)));
        if (statuses.every(status => status === "match")) continue;
        if (statuses.includes("ambiguous")) ambiguous.push("bracket-crossing-bonds");
        if (!statuses.includes("changed")) continue;
        left = a.crossings; right = ordered;
      }
    }
    if (!jsonEqual(left, right)) differences.push({ feature, before: left, after: right });
  }
  return { differences, ambiguous, missing };
}

export function pairBrackets(before: BracketSummary[], after: BracketSummary[]) {
  const same = (a: BracketSummary, b: BracketSummary) => glyphAlignments(a, b).length > 0;
  const { paired, ambiguousBefore, ambiguousAfter } = pairUnique(before, after, same, items => {
    const glyphs = items.flatMap(bracket => bracket.placements?.map((site, i, sites) => ({ bracket, site, other: sites[1 - i] })) ?? []);
    const index = positionIndex(glyphs, glyph => placementScope(glyph.site));
    return bracket => {
      if (!bracket.placements) return [];
      const [first, second] = bracket.placements;
      const matches = index(placementScope(first), ({ site, other }) => samePlacement(first, site) && samePlacement(second, other));
      return matches.map(glyph => glyph.bracket);
    };
  });
  for (const a of before) if (a.placements && glyphAlignments(a, a).length > 1) ambiguousBefore.add(a);
  for (const b of after) if (b.placements && glyphAlignments(b, b).length > 1) ambiguousAfter.add(b);
  for (const [a, b] of paired) {
    if (ambiguousBefore.has(a) || ambiguousAfter.has(b) || glyphAlignments(a, b).length > 1) {
      ambiguousBefore.add(a); ambiguousAfter.add(b); paired.delete(a);
    }
  }
  const used = new Set(paired.values());
  return [
    ...before.map(a => ({ before: a, after: paired.get(a), ambiguous: ambiguousBefore.has(a) })),
    ...after.filter(b => !used.has(b)).map(b => ({ before: undefined, after: b, ambiguous: ambiguousAfter.has(b) }))
  ];
}

export const moleculeIdentity = (m: MoleculeSummary) => JSON.stringify([m.smiles, sorted([...(m.dummyAtoms ?? [])])]);

function moleculePositionMatches(before: MoleculeSummary[], after: MoleculeSummary[]) {
  const locations = new Map<MoleculeSummary, Point & { scope: string }>();
  for (const m of [...before, ...after]) if (m.pairing && !locations.has(m)) {
    const { centroid: [x, y], page } = m.pairing;
    locations.set(m, { x, y, scope: JSON.stringify([page, moleculeIdentity(m)]) });
  }
  return placementPairs(before, after, () => true, m => locations.get(m));
}

/** Match repeated chemical identities at their drawing positions before using source IDs. */
export function pairMolecules(before: MoleculeSummary[], after: MoleculeSummary[]) {
  const { paired, ambiguousBefore, ambiguousAfter } = moleculePositionMatches(before, after);
  const used = new Set(paired.values());
  const bestMatched = new Set<MoleculeSummary>();
  const unmatchedLeft = () => before.filter(a => !paired.has(a) && !ambiguousBefore.has(a));
  const unmatchedRight = () => after.filter(b => !used.has(b) && !ambiguousAfter.has(b));
  const add = (a: MoleculeSummary, b: MoleculeSummary) => { paired.set(a, b); used.add(b); };
  const pairByKey = (key: (m: MoleculeSummary) => string | undefined) => {
    const buckets = (items: MoleculeSummary[]) => {
      const result = new Map<string, MoleculeSummary | null>();
      for (const item of items) {
        const id = key(item);
        if (id) result.set(id, result.has(id) ? null : item);
      }
      return result;
    };
    const right = buckets(unmatchedRight());
    for (const [id, a] of buckets(unmatchedLeft())) {
      const b = right.get(id);
      if (a && b) add(a, b);
    }
  };
  pairByKey(moleculeIdentity);
  pairByKey(m => m.originalId);

  // Require identical heavy-element multisets and a unique mutual closest pair.
  const heavyElements = (elements: string[]) => sorted(elements.filter(e => !["H", "D", "T"].includes(e)));
  const location = new Map([...unmatchedLeft(), ...unmatchedRight()].flatMap(m => m.pairing
    ? [[m, { ...m.pairing, heavy: JSON.stringify(heavyElements(m.pairing.elements)) }] as const] : []));
  const best = (source: MoleculeSummary, targets: MoleculeSummary[], ambiguous: Set<MoleculeSummary>) => {
    const x = location.get(source);
    if (!x) return undefined;
    let best: MoleculeSummary | undefined, distance = Infinity, next = Infinity;
    for (const candidate of targets) {
      const y = location.get(candidate);
      if (!y || x.page !== y.page || x.heavy !== y.heavy) continue;
      const score = Math.hypot(x.centroid[0] - y.centroid[0], x.centroid[1] - y.centroid[1]);
      if (score > Math.max(x.bondLength, y.bondLength)) continue;
      if (score < distance) { next = distance; distance = score; best = candidate; }
      else if (score < next) next = score;
    }
    if (next - distance <= placementTolerance) { ambiguous.add(source); return undefined; }
    return best;
  };
  const left = unmatchedLeft(), right = unmatchedRight();
  const closestLeft = new Map(right.map(b => [b, best(b, left, ambiguousAfter)]));
  for (const a of left) {
    const b = best(a, right, ambiguousBefore);
    if (b && closestLeft.get(b) === a) { add(a, b); bestMatched.add(a); }
    else if (b && ambiguousAfter.has(b)) ambiguousBefore.add(a);
  }
  for (const [b, a] of closestLeft) if (a && ambiguousBefore.has(a)) ambiguousAfter.add(b);
  // Positional native IDs can change when other display objects are dropped.
  pairByKey(m => m.objectId);
  const residualLeft = unmatchedLeft(), residualRight = unmatchedRight();
  if (residualLeft.length === 1 && residualRight.length === 1 && !residualLeft[0].objectId && !residualRight[0].objectId) {
    add(residualLeft[0], residualRight[0]);
  }
  return [
    ...before.map(a => ({ before: a, after: paired.get(a), bestMatch: bestMatched.has(a), ambiguous: ambiguousBefore.has(a) })),
    ...after.filter(b => !used.has(b)).map(b => ({ before: undefined, after: b, bestMatch: false, ambiguous: ambiguousAfter.has(b) }))
  ];
}

export function pairWavyMolecules(before: MoleculeSummary[], after: MoleculeSummary[]) {
  return new Map(pairMolecules(before, after).flatMap(({ before: a, after: b }) => a && b ? [[a, b]] : []));
}

export const lacksWavyDirection = (m: MoleculeSummary) => (m.displays?.wavy ?? 0) > 0 &&
  (!hasSiteInventory(m.sites) || !m.sites?.bonds.length || m.wavyBonds?.length !== m.displays.wavy || !m.wavyBonds.every(hasBondEvidence));

/** Track marked bonds using all native sites as candidates, including unmarked bonds. */
export function matchWavyBonds(before: MoleculeSummary, after: MoleculeSummary) {
  const a = before.wavyBonds ?? [], b = after.wavyBonds ?? [];
  const status = (x: BondSite, y: BondSite) => compareBondSite(x, y, before.sites, after.sites, true);
  const { paired, ambiguousBefore, ambiguousAfter } = pairUnique(a, b, (x, y) => status(x, y) === "match");
  const checks = (sites: BondSite[], graph?: MoleculeSites) => sites.some(site =>
    compareBondSite(site, site, graph, graph, true) === "ambiguous");
  const ambiguous = checks(a, before.sites) || checks(b, after.sites) ||
    !!ambiguousBefore.size || !!ambiguousAfter.size ||
    a.some(x => b.some(y => status(x, y) === "ambiguous"));
  return { paired, ambiguous };
}

/** Last guard for every feature, including special-case and future diagnostics. */
export function guardDifferences(differences: Difference[]): { differences: Difference[]; comparisonInternalErrors: number } {
  const kept = differences.filter(d => !jsonEqual(d.before, d.after));
  return { differences: kept, comparisonInternalErrors: differences.length - kept.length };
}

function sameSpecies(a: MoleculeSummary, b: MoleculeSummary): { check?: Difference["identityCheck"]; evidence: NonNullable<Difference["identityEvidence"]> } {
  const evidence: NonNullable<Difference["identityEvidence"]> = {
    standardInchi: a.species?.inchiKey && b.species?.inchiKey ? a.species.inchiKey === b.species.inchiKey ? "match" : "different" : "unavailable",
    fixedHydrogen: "unavailable", resonance: "not-run", decision: "protected-feature"
  };
  if (!a.strict || !b.strict || a.recovery || b.recovery || a.formula !== b.formula || a.charge !== b.charge
    || a.hydrogenCount !== b.hydrogenCount
    || a.atomCount !== b.atomCount || a.heavyAtoms !== b.heavyAtoms || a.bonds !== b.bonds
    || !jsonEqual(moleculeValue(a, "isotope"), moleculeValue(b, "isotope"))
    || !jsonEqual(moleculeValue(a, "radical"), moleculeValue(b, "radical"))
    || !jsonEqual(moleculeValue(a, "stereo"), moleculeValue(b, "stereo"))
    || !jsonEqual(a.dummyAtoms, b.dummyAtoms) || !jsonEqual(a.abbreviations, b.abbreviations) || !jsonEqual(a.rGroups, b.rGroups)
    // Conservatively decline changes involving tetrahedral centres or assigned E/Z.
    || ((a.tetrahedral.length || b.tetrahedral.length || [...a.doubleBonds, ...b.doubleBonds].some(d => d.stereo !== "unspecified"))
      && a.featureKeys.stereo !== b.featureKeys.stereo)) return { evidence };
  const x = a.species, y = b.species;
  if (x?.version === 2 && y?.version === 2) {
    if (x.fixedHInchi && y.fixedHInchi) evidence.fixedHydrogen = x.fixedHInchi === y.fixedHInchi ? "fixed-h-inchi" : "mismatch";
    // Conservative fallback: explicit atom H counts and formal charges in canonical
    // SMILES must agree. No tautomer-normalised identifier can override this check.
    else if (x.explicitHSmiles && y.explicitHSmiles) evidence.fixedHydrogen = x.explicitHSmiles === y.explicitHSmiles ? "explicit-h-smiles" : "mismatch";
  }
  if (evidence.fixedHydrogen === "mismatch" || evidence.fixedHydrogen === "unavailable") {
    evidence.decision = "fixed-hydrogen-mismatch";
    return { evidence };
  }
  evidence.resonance = x?.graph && y?.graph ? testResonance(x.graph, y.graph) : "undetermined";
  evidence.decision = evidence.resonance === "reachable" ? "same-species" : "resonance-rejected";
  return { evidence, ...(evidence.decision === "same-species" ? { check: evidence.standardInchi === "match" ? "standard-inchi" as const : "electron-pair-resonance" as const } : {}) };
}

export function chemistryVerdict(differences: Difference[], undetermined = false): RoundTrip["verdict"] {
  const losses = differences.filter(d => !d.classification);
  return losses.some(d => !d.warned) ? "FAIL" : undetermined ? "ERROR" : losses.length ? "WARNED" : differences.some(d => d.classification) ? "DRAWN-DIFFERENTLY" : "PASS";
}

/** Count losses only. The source tree supplies drawing intent, not a second chemistry engine. */
export function compareSurvival(before: import("./survival").SurvivalCounts, after: import("./survival").SurvivalCounts, warnings: Warning[]): Comparison {
  const differences: Difference[] = [];
  const drawingLoss: DrawingFeature[] = [];
  const arrowLoss = stepArrowLosses(before, [after]);
  if (arrowLoss.links) {
    differences.push({ feature: "reaction-step-arrow",
      before: { totalLinks: before.stepArrows, linksPerStep: before.stepArrowLinks ?? [before.stepArrows] },
      after: { totalLinks: after.stepArrows, linksPerStep: after.stepArrowLinks ?? [after.stepArrows] },
      // Reclassify stored diagnostics too: older runs did not map step_preserved to
      // this feature. Stored feature arrays must not turn a generic warning into cover.
      warned: arrowLoss.lostStepIds.every(id => id !== null && warnings.some(w =>
        warning({ code: w.category, message: w.message, objectId: w.objectId }).features.includes("reaction-step-arrow")
        && /\bstep\s+([^\s:]+)\s*:/i.exec(w.message)?.[1] === id)) });
  }
  if (before.abbreviations > after.abbreviations) {
    const warned = warnings.some(w => w.features.includes("abbreviation"));
    differences.push({ feature: "abbreviation", before: before.abbreviations, after: after.abbreviations, warned,
      ...(!warned ? { classification: "drawing-object-loss" as const } : {}) });
    drawingLoss.push("other-graphics");
  }
  for (const [kind, count] of Object.entries(before.display)) {
    const next = after.display[kind] ?? 0;
    if (count <= next) continue;
    const name = kind === "bracketedgroup" ? "bracket group" : kind === "t" ? "text" : kind.split(".").at(-1)!.toLowerCase();
    const namesKind = (w: Warning) => w.features.includes("display-object") && new RegExp(`\\b${name}s?\\b`, "i").test(w.message);
    const sourceIds = before.displayObjectIds?.[kind];
    const remainingIds = [...(after.displayObjectIds?.[kind] ?? [])];
    const missingIds = sourceIds?.filter(id => {
      const index = remainingIds.indexOf(id);
      if (index < 0) return true;
      remainingIds.splice(index, 1); return false;
    });
    const available = warnings.filter(namesKind);
    // Consume each warning once. Prefer scoped warnings so a generic diagnostic can
    // still cover another lost object; a diagnostic for a survivor covers no loss.
    let covered = 0;
    if (missingIds) {
      const unmatched = missingIds.filter(id => {
        const index = available.findIndex(w => w.objectId === id);
        if (index < 0) return true;
        available.splice(index, 1); covered++; return false;
      });
      if (kind !== "graphic.Bracket" && kind !== "bracketedgroup") {
        covered += Math.min(unmatched.length, available.filter(w => !w.objectId).length);
      }
    } else covered = available.length; // Legacy summaries have only aggregate counts.
    const warned = covered >= count - next;
    differences.push({ feature: "display-object", before: { kind, count }, after: { kind, count: next }, warned,
      ...(!warned ? { classification: "drawing-object-loss" as const } : {}) });
    const feature = kind === "arrow" ? "arrows" : kind === "bracketedgroup" || kind === "graphic.Bracket" ? "brackets" : kind === "t" ? "text-styling" : "other-graphics";
    if (!drawingLoss.includes(feature)) drawingLoss.push(feature);
  }
  return { differences, drawingLoss, verdict: chemistryVerdict(differences) };
}

function pairedValues(left: MoleculeSummary, right: MoleculeSummary, feature: Feature, sigma?: SigmaComparison, exact?: SigmaComparison["status"]): [unknown, unknown] {
  const x = moleculeValue(left, feature), y = moleculeValue(right, feature);
  if (feature === "connectivity" && jsonEqual(x, y)) return [x, y];
  if (feature === "connectivity" || feature === "bond-order") {
    if (left.smiles === right.smiles || exact === "isomorphic" || exact === "undetermined") return [null, null];
  }
  if (feature === "connectivity") {
    if (sigma?.status === "isomorphic") {
      // A changed canonical graph with no demonstrated order change still lacks
      // a bond-order-only explanation (including incomplete legacy evidence).
      return left.connectivity !== right.connectivity && jsonEqual(...sigma.orders!) ? [x, y] : [null, null];
    }
    // A completed exact check has ruled out equality; sigma evidence can still
    // distinguish a bond-order-only change from changed connectivity.
    return [x, y];
  }
  // Canonical aromatic keys intentionally collapse equivalent Kekule drawings.
  if (feature === "bond-order") return left.connectivity !== right.connectivity ? sigma?.orders ?? [null, null] : [null, null];
  if ((feature === "charge" || feature === "isotope" || feature === "radical" || feature === "stereo") && jsonEqual(x, y)) {
    if (sigma?.status === "isomorphic") return sigma.changes?.[feature] ?? [x, y];
    if (left.connectivity === right.connectivity) return [[x, left.featureKeys[feature]], [y, right.featureKeys[feature]]];
  }
  return [x, y];
}

/** Callers supply diagnostics from this conversion leg, never baseline import warnings. */
export function compare(before: Summary, after: Summary, warnings: Warning[], options: { exactGraphBudget?: number } = {}): Comparison {
  const differences: Difference[] = [];
  const placement = comparePlacements(before, after);
  const missing = missingComparisonEvidence(before, after, placement.left, placement.right);
  const undetermined: NonNullable<Comparison["undetermined"]> = [...missing]
    .filter(feature => feature !== "wavy-direction").map(feature => ({ feature, reason: missingStoredEvidence }));
  const moleculePairs = pairMolecules(before.molecules, after.molecules).map(pair => {
    const a = pair.before, b = pair.after;
    const molecule = { before: a?.objectId, after: b?.objectId };
    if (pair.ambiguous) undetermined.push({ feature: "molecule-placement", molecule });
    if ([a, b].some(m => m && lacksWavyDirection(m))) {
      undetermined.push({ feature: "wavy-direction", molecule, reason: missingStoredEvidence });
    } else if (a && b && (a.displays?.wavy || b.displays?.wavy)) {
      const wavy = matchWavyBonds(a, b);
      if (wavy.ambiguous) undetermined.push({ feature: "wavy-placement", molecule });
      return { ...pair, wavyChanged: !wavy.ambiguous && (wavy.paired.size !== a.displays.wavy || wavy.paired.size !== b.displays.wavy) };
    }
    return { ...pair, wavyChanged: false };
  });
  // Preserve every stored chemistry field, including graph evidence and display intent.
  // Compare as a multiset without depending on object IDs, geometry or ordering.
  const chemistry = ({ objectId: _objectId, originalId: _originalId, pairing: _pairing, wavyBondKeys: _wavyBondKeys, wavyBonds: _wavyBonds, sites: _sites, ...m }: MoleculeSummary) => m;
  const identical = !undetermined.length && before.molecules.length > 0 && before.molecules.length === after.molecules.length
    && !moleculePairs.some(pair => pair.wavyChanged || (!pair.before || !pair.after) && (pair.before ?? pair.after)?.displays?.wavy)
    && (() => {
      const remaining = after.molecules.map(chemistry);
      return before.molecules.every(m => {
        const index = remaining.findIndex(candidate => jsonEqual(chemistry(m), candidate));
        if (index < 0) return false;
        remaining.splice(index, 1);
        return true;
      });
    })();
  const pairs = (identical ? [] : moleculePairs.filter(pair => !pair.ambiguous)).map(pair => {
    const a = pair.before, b = pair.after;
    // Recovery skips secondary RDKit calls. An equal full canonical identity can
    // borrow derived keys from its normal peer, while all measured counts, charge,
    // formula, strictness and native stereo displays still compare independently.
    if (a && b && a.smiles === b.smiles && !!a.recovery !== !!b.recovery) {
      const normal = a.recovery ? b : a;
      const align = (m: MoleculeSummary) => m.recovery ? { ...m, connectivity: normal.connectivity, featureKeys: normal.featureKeys, tetrahedral: normal.tetrahedral, doubleBonds: normal.doubleBonds } : m;
      return { ...pair, before: align(a), after: align(b) };
    }
    return pair;
  }).map(pair => {
    const a = pair.before, b = pair.after;
    const allowed = new Set(warnings.filter(w => !w.objectId || w.objectId === a?.objectId || w.objectId === b?.objectId).flatMap(w => w.features).filter((f): f is MappedFeature => ["charge", "isotope", "radical", "stereo"].includes(f)));
    const exact = a && b && a.smiles !== b.smiles && !jsonEqual(moleculeValue(a, "connectivity"), moleculeValue(b, "connectivity"))
      ? compareExactGraph(a, b, options.exactGraphBudget) : undefined;
    return { ...pair, exact, sigma: a && b ? compareSigma(a, b, allowed) : undefined };
  });
  for (const pair of pairs) {
    const a = pair.before, b = pair.after;
    const subtract = (left: string[], right: string[]) => { const rest = [...right]; return sorted(left.filter(item => { const i = rest.indexOf(item); if (i < 0) return true; rest.splice(i, 1); return false; })); };
    const x = a?.pairing, y = b?.pairing;
    const delta = x && y && pair.bestMatch ? {
      atomsAdded: subtract(y.elements, x.elements), atomsRemoved: subtract(x.elements, y.elements),
      bondsAdded: Math.max(0, y.bonds - x.bonds), bondsRemoved: Math.max(0, x.bonds - y.bonds),
      labelsAdded: subtract(y.labels, x.labels), labelsRemoved: subtract(x.labels, y.labels)
    } : undefined;
    const local: Difference[] = [];
    const add = (feature: Feature, left: unknown, right: unknown) => {
      if (jsonEqual(left, right)) return;
      const candidates = warnings.filter(w => w.features.includes(feature));
      const changedPairs = pairs.filter(p => !p.before || !p.after || (feature === "stereo-display" && p.wavyChanged)
        || !jsonEqual(...pairedValues(p.before, p.after, feature, p.sigma, p.exact)));
      const warned = feature !== "sanitization-changed" && feature !== "connectivity" && candidates.some(w => w.objectId
        ? w.objectId === a?.objectId || w.objectId === b?.objectId : feature !== "bond-order" && changedPairs.length === 1);
      local.push({ feature, before: left, after: right, warned, ...(delta ? { delta } : {}), molecule: { before: a?.objectId, after: b?.objectId, ...(!a ? { change: "added" as const } : !b ? { change: "removed" as const } : {}) } });
    };
    for (const feature of chemistryFeatures.filter(f => !["reaction-roles", "reaction-step-arrow", "display-object"].includes(f) && !f.startsWith("bracket-"))) {
      if (a && b && pair.exact === "undetermined" && (feature === "connectivity" || feature === "bond-order")) {
        if (!jsonEqual(moleculeValue(a, feature), moleculeValue(b, feature))) undetermined.push({ feature, molecule: { before: a.objectId, after: b.objectId } });
      }
      const [left, right] = a && b ? pairedValues(a, b, feature, pair.sigma, pair.exact) : [a ? moleculeValue(a, feature) : null, b ? moleculeValue(b, feature) : null];
      add(feature, left, right);
    }
    if (a && b) {
      if (pair.wavyChanged && !local.some(d => d.feature === "stereo-display")) add("stereo-display", a.wavyBonds, b.wavyBonds);
      if (!local.some(d => d.feature === "charge") && indexedChargeChange(a.species?.graph, b.species?.graph)) {
        add("charge", a.species!.graph!.atoms.map(atom => atom.charge), b.species!.graph!.atoms.map(atom => atom.charge));
      }
      if (a.formula !== b.formula && !local.some(d => ["isotope", "radical", "charge", "atom-bond-count", "connectivity", "other"].includes(d.feature))) add("other", a.formula, b.formula);
      if (a.smiles !== b.smiles && !local.length && pair.exact !== "undetermined") add(a.withoutStereo === b.withoutStereo ? "stereo" : "other", a.smiles, b.smiles);
      if (a.smiles === b.smiles && local.every(d => d.feature === "abbreviation")) {
        for (const d of local) if (!d.warned) d.classification = "drawing-object-loss";
      }
      const identity = local.length ? sameSpecies(a, b) : undefined;
      if (identity) for (const d of local) {
        d.identityEvidence = identity.evidence;
        if (!d.warned && identity.check && ["charge", "bond-order", "other", "stereo"].includes(d.feature)) { d.classification = "same-species-different-drawing"; d.identityCheck = identity.check; }
      }
    }
    differences.push(...local);
  }
  for (const [feature, a, b] of [
    ["reaction-roles", sorted(before.reactions.map(reactionValue)), sorted(after.reactions.map(reactionValue))],
    ["abbreviation", sorted([...before.standaloneAbbreviations]), sorted([...after.standaloneAbbreviations])],
    ["r-group", sorted([...before.standaloneRGroups]), sorted([...after.standaloneRGroups])]
  ] as const) {
    if (!jsonEqual(a, b)) differences.push({ feature, before: a, after: b, warned: feature === "reaction-roles" && warningsCover(before.reactions, after.reactions, reactionValue, warnings, feature) });
  }
  const changes: { feature: Feature; before: unknown; after: unknown; ids: string[] }[] = [];
  const bracketPairs = missing.has("bracket-placement") ? [] : pairBrackets(before.brackets ?? [], after.brackets ?? []);
  for (const { before: a, after: b, ambiguous } of bracketPairs) {
    const ids = [...(a?.objectIds ?? []), ...(b?.objectIds ?? [])];
    if (ambiguous) undetermined.push({ feature: "bracket-placement" });
    else if (!a || !b) changes.push({ feature: "bracket-pair", before: a ? bracketValue(a) : null, after: b ? bracketValue(b) : null, ids });
    else {
      const result = compareBracket(a, b, placement);
      undetermined.push(...result.ambiguous.map(feature => ({ feature })));
      changes.push(...result.differences.map(change => ({ ...change, ids })));
    }
  }
  for (const change of changes) {
    const warned = warnings.some(w => w.features.includes(change.feature) && (w.objectId ? change.ids.includes(w.objectId) : changes.filter(c => c.feature === change.feature).length === 1));
    differences.push({ feature: change.feature, before: change.before, after: change.after, warned, ...(change.feature === "bracket-drawing" && !warned ? { classification: "same-species-different-drawing" as const } : {}) });
  }
  const survival = before.survival && after.survival ? compareSurvival(before.survival, after.survival, warnings) : undefined;
  differences.push(...(survival?.differences ?? []));
  const guarded = guardDifferences(differences);
  const colours = missing.has("colour-placement") ? "ambiguous" : nonTextColoursComparison(before, after, placement);
  if (colours === "ambiguous" && !missing.has("colour-placement")) undetermined.push({ feature: "colour-placement" });
  const drawingLoss = drawingFeatures.filter(feature => !jsonEqual(before.drawing[feature], after.drawing[feature])
    || (feature === "colours" && colours === "changed"));
  for (const feature of survival?.drawingLoss ?? []) if (!drawingLoss.includes(feature)) drawingLoss.push(feature);
  const incomplete = !!before.summaryErrors?.length || !!after.summaryErrors?.length;
  const verdict = chemistryVerdict(guarded.differences, undetermined.length > 0);
  return { ...guarded, drawingLoss, verdict: incomplete ? "ERROR" : verdict, ...(undetermined.length ? { undetermined } : {}), ...(identical && !undetermined.length ? { identityPasses: before.molecules.length, chemistryPassReason: "identity" as const } : {}) };
}
