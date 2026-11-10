import { elementSymbolForAtomicNumber, normalizeAtomIsotope, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { bondedElementLabelMeaning } from "@chemdraft/template-library";
import type { CompatibilityConversionWarning } from "./index";
import type { CdxElement } from "./cdxBinary";

/** Shared structural gate for import and source measurements. No chemistry is inferred here. */
export function abbreviationExpansionIssue(
  attributes: Record<string, string>,
  fragments: readonly { atoms: readonly Record<string, string>[]; bonds: readonly Record<string, string>[] }[],
  outerBonds: readonly Record<string, string>[],
  depth: number
): string | undefined {
  const { atoms = [], bonds = [] } = fragments[0] ?? {};
  const connectionPoints = new Set(atoms.filter(atom => ["ExternalConnectionPoint", "12"].includes(atom.NodeType)).map(atom => atom.id ?? ""));
  const body = atoms.filter(atom => !["ExternalConnectionPoint", "12"].includes(atom.NodeType));
  const connections = bonds.filter(bond => connectionPoints.has(bond.B ?? "") || connectionPoints.has(bond.E ?? ""));
  const attachment = connections.map(bond => connectionPoints.has(bond.B ?? "") ? bond.E : bond.B).find(id => id !== undefined);
  const chargeValue = Number(attributes.Charge);
  const charge = Number.isInteger(chargeValue) ? chargeValue : 0;
  if (fragments.length !== 1) return "it carries more than one expanded fragment.";
  if (depth > 4) return "its nesting exceeds the supported abbreviation depth.";
  if (["AnonymousAlternativeGroup", "NamedAlternativeGroup", "8", "9"].includes(attributes.NodeType)) {
    return `NodeType="${attributes.NodeType}" carries alternative-group semantics that cannot be represented as a native superatom.`;
  }
  if (charge !== 0) return `its charge ${charge} cannot be assigned to a nested atom without guessing.`;
  if (!body.length) return "it carries no atoms to expand.";
  if (connectionPoints.size > 1) return `it attaches at ${connectionPoints.size} points, and which bond meets which atom cannot be read from the file.`;
  if (connections.length > connectionPoints.size) return "its external connection point does not have exactly one attachment bond.";
  if (attachment !== undefined && !body.some(atom => atom.id === attachment)) return "its attachment bond does not reach a body atom.";
  if (outerBonds.some(bond => bond.B === attributes.id || bond.E === attributes.id) && attachment === undefined) {
    return "it has no attachment bond connecting its body to the outer drawing.";
  }
  if (attributes.Isotope !== undefined || (attributes.Radical !== undefined && !["None", "0"].includes(attributes.Radical))) {
    return "its wrapper isotope or radical cannot be assigned to a nested atom without guessing.";
  }
}

interface SourceAbbreviation {
  atomIds: string[];
  expanded: boolean;
  source: CdxElement;
  depth?: number;
  superatomIndex?: number;
}

const element = (name: string, attrs: Record<string, string>, kids: CdxElement[] = [], text = ""): CdxElement =>
  ({ name, attrs, kids, text });
const sameMembers = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every(id => right.includes(id));
const elementText = (node: CdxElement): string => node.text + node.kids.map(elementText).join("");
const abbreviationLabel = (source: CdxElement): string | undefined => {
  const label = source.kids.find(child => child.name === "t");
  return (label ? elementText(label).trim() : "") || source.attrs.GenericNickname?.trim() || undefined;
};

/** Missing Element defaults to carbon; numeric-looking invalid values never do. */
export function elementFromCdxmlAtom(element: string | undefined): string | undefined {
  if (element === undefined) return "C";
  const trimmed = element.trim();
  if (/^\d+$/.test(trimmed)) return elementSymbolForAtomicNumber(Number(trimmed));
  if (trimmed === "" || /^[+-]?\.?\d/.test(trimmed)) return undefined;
  return trimmed;
}

/** Use the same source interpretation on import and before restoring a literal source node. */
export function cdxmlAtomChemistry(attributes: Record<string, string>, literalLabel?: string) {
  const element = elementFromCdxmlAtom(attributes.Element) ?? "*";
  const rawElement = attributes.Element?.trim();
  const textLabel = rawElement !== undefined && rawElement.length > 0 && !Number.isInteger(Number(rawElement)) &&
    bondedElementLabelMeaning(element) !== undefined;
  const charge = Number(attributes.Charge);
  return normalizeAtomIsotope({
    element: literalLabel ?? element,
    ...(attributes.Isotope === undefined ? {} : { isotope: Number(attributes.Isotope) }),
    formalCharge: Number.isInteger(charge) ? charge : 0,
    ...(["Doublet", "2"].includes(attributes.Radical) ? { markRadicals: 1 }
      : ["Triplet", "3"].includes(attributes.Radical) ? { markRadicals: 2 } : {}),
    ...(literalLabel || textLabel ? { labelLiteral: true } : {})
  });
}

function sourceAtomIsUnedited(atom: MoleculeAtom, source: CdxElement, molecule: MoleculeObject): boolean {
  const original = cdxmlAtomChemistry(source.attrs, abbreviationLabel(source));
  const hydrogenCount = source.attrs.NumHydrogens === undefined ? undefined : Number(source.attrs.NumHydrogens);
  const originalHydrogens = hydrogenCount !== undefined && Number.isInteger(hydrogenCount) && hydrogenCount >= 0
    ? hydrogenCount : undefined;
  const sourceStereo = source.attrs.AS?.trim().toUpperCase();
  const expectedStereo = sourceStereo === "R" || sourceStereo === "S" ? [`${atom.id}:${sourceStereo}`] : [];
  const liveStereo = molecule.chemistry?.stereochemistry.filter(value => value.startsWith(`${atom.id}:`)) ?? [];
  return atom.element === original.element && atom.isotope === original.isotope &&
    atom.formalCharge === original.formalCharge && (atom.markRadicals ?? 0) === (original.markRadicals ?? 0) &&
    atom.hydrogenCount === originalHydrogens && !!atom.labelLiteral === !!original.labelLiteral &&
    // Source import does not assign a side-dependent label reading. Restoring its text after
    // such a native edit would discard that new chemical interpretation.
    atom.labelBondSide === undefined && sameMembers(liveStereo, expectedStereo);
}

/** Restore grouping around the live graph. Chemistry always reads the graph, never this snapshot. */
export function restoreCdxmlAbbreviations(
  fragment: CdxElement,
  molecule: MoleculeObject,
  atomIds: ReadonlyMap<string, string>,
  nextId: () => string,
  warnings: CompatibilityConversionWarning[]
): void {
  const stored = molecule.compatibility?.unknown.cdxmlAbbreviations;
  const sources = (Array.isArray(stored) ? stored : []).filter((value): value is SourceAbbreviation =>
    !!value && typeof value === "object" && Array.isArray(value.atomIds) &&
    value.atomIds.every((id: unknown) => typeof id === "string") && typeof value.expanded === "boolean" &&
    value.source?.name === "n" && !!value.source.attrs && Array.isArray(value.source.kids));
  const warn = (label: string, reason: string) => warnings.push({ code: "cdxml.superatom_not_collapsed",
    message: `Abbreviation "${label}" is written as its live expanded atoms: ${reason} The label and source data remain in the native document.`,
    sourceObjectId: molecule.id });

  // Remap *all* descendant IDs and their references together. Repeated labels and fragments must
  // never accidentally share connection points or text-object IDs with another abbreviation.
  const cloneSource = (source: CdxElement, rootId: string): CdxElement => {
    const copy = structuredClone(source);
    const ids = new Map<string, string>();
    const walk = (node: CdxElement, visit: (node: CdxElement) => void) => {
      visit(node); node.kids.forEach(child => walk(child, visit));
    };
    walk(copy, node => { if (node.attrs.id) ids.set(node.attrs.id, node === copy ? rootId : nextId()); });
    walk(copy, node => {
      for (const key of ["id", "B", "E", "BondCircularOrdering", "ConnectionOrder", "CrossingBonds"]) {
        if (node.attrs[key]) node.attrs[key] = node.attrs[key].split(/\s+/).map(id => ids.get(id) ?? id).join(" ");
      }
    });
    copy.attrs.id = rootId;
    return copy;
  };

  for (const record of sources.filter(source => !source.expanded)) {
    const id = atomIds.get(record.atomIds[0]);
    const index = fragment.kids.findIndex(child => child.name === "n" && child.attrs.id === id);
    if (index < 0) continue;
    const nativeAtom = molecule.atoms.find(atom => atom.id === record.atomIds[0]);
    const label = abbreviationLabel(record.source);
    // Replacing the entire generated node also replaces every chemical attribute. Check them
    // all, including absent source values (neutral charge, natural isotope, no H constraint).
    if (!nativeAtom || !sourceAtomIsUnedited(nativeAtom, record.source, molecule)) {
      const original = cdxmlAtomChemistry(record.source.attrs, label);
      warn(label ?? original.element, nativeAtom?.element !== original.element
        ? "its original literal label was edited."
        : "its atom chemistry was edited; source formatting was not kept.");
      continue;
    }
    const copy = cloneSource(record.source, id!);
    copy.attrs.p = fragment.kids[index].attrs.p;
    fragment.kids[index] = copy;
  }

  const nativeIdByVisibleId = new Map([...atomIds].map(([nativeId, visibleId]) => [visibleId, nativeId]));
  const nodeMembers = new Map(fragment.kids.filter(node => node.name === "n").map(node => [node,
    new Set([nativeIdByVisibleId.get(node.attrs.id)!])]));
  const displayIds = new Map(atomIds);
  // Associate sources before sorting. A membership-only lookup aliases nested groups whose
  // expansions are identical; each source record must be used by its own superatom exactly once.
  const unusedSources = new Set(sources.filter(record => record.expanded));
  const groups = molecule.superatoms.map((group, index) => {
    const candidates = [...unusedSources].filter(record => sameMembers(record.atomIds, group.atomIds ?? []));
    const source = candidates.find(record => record.superatomIndex === index)
      // Older native payloads have no index. Match their labels first, then their source preorder.
      ?? candidates.find(record => record.superatomIndex === undefined &&
        abbreviationLabel(record.source) === group.label)
      ?? candidates.find(record => record.superatomIndex === undefined);
    if (source) unusedSources.delete(source);
    return { group, source, sourceIndex: source ? sources.indexOf(source) : -1 };
  }).sort((a, b) => (a.group.atomIds?.length ?? 0) - (b.group.atomIds?.length ?? 0) ||
    (b.source?.depth ?? 0) - (a.source?.depth ?? 0) ||
    // Source records are in preorder, including in older payloads without an explicit depth.
    b.sourceIndex - a.sourceIndex);
  for (const { group, source } of groups) {
    const members = new Set(group.atomIds);
    const anchors = group.attachmentPoints.filter(anchor => anchor.kind === "atom" &&
      anchor.objectId === molecule.id && anchor.atomId && members.has(anchor.atomId));
    const crossingBonds = molecule.bonds.filter(bond => members.has(bond.fromAtomId) !== members.has(bond.toAtomId));
    const anchorId = anchors[0]?.atomId;
    if (!members.size || members.size !== group.atomIds?.length || [...members].some(id => !atomIds.has(id))) {
      warn(group.label, "its expanded atom membership is missing or no longer valid."); continue;
    }
    if (group.attachmentPoints.length > 1 || (crossingBonds.length > 0 && (anchors.length !== 1 ||
      crossingBonds.some(bond => (members.has(bond.fromAtomId) ? bond.fromAtomId : bond.toAtomId) !== anchorId)))) {
      warn(group.label, "its bonds no longer meet a single recorded attachment atom."); continue;
    }
    const nodes = [...nodeMembers].filter(([, ids]) => [...ids].some(id => members.has(id)));
    if (nodes.some(([, ids]) => [...ids].some(id => !members.has(id)))) {
      warn(group.label, "it overlaps another abbreviation without containing it."); continue;
    }
    const ids = new Set(nodes.map(([node]) => node.attrs.id));
    const bodyBonds = fragment.kids.filter(node => node.name === "b" && ids.has(node.attrs.B) && ids.has(node.attrs.E));
    const wrapperId = nextId();
    const sourceCopy = source ? cloneSource(source.source, wrapperId) : undefined;
    const attributes: Record<string, string> = { ...sourceCopy?.attrs, id: wrapperId, NodeType: sourceCopy?.attrs.NodeType ?? "Nickname" };
    // The body's atoms carry their elements. A symbolic Element on the wrapper is only a label
    // hint, which the explicit text already supplies; it must not be counted as another atom.
    delete attributes.Element;
    const anchorNode = fragment.kids.find(node => node.name === "n" && node.attrs.id === displayIds.get(anchorId ?? group.atomIds![0]));
    if (anchorNode) attributes.p = anchorNode.attrs.p;
    const body = element("fragment", { id: nextId() }, [...nodes.map(([node]) => node), ...bodyBonds]);
    if (anchorId) {
      const connectionId = nextId();
      body.kids.push(element("n", { id: connectionId, NodeType: "ExternalConnectionPoint" }),
        element("b", { id: nextId(), B: connectionId, E: displayIds.get(anchorId)!, Order: "1" }));
    }
    const label = element("t", { id: nextId() }, [element("s", {}, [], group.label)]);
    const wrapper = element("n", attributes, [body, label]);
    const removed = new Set([...nodes.map(([node]) => node), ...bodyBonds]);
    fragment.kids = fragment.kids.filter(node => !removed.has(node));
    for (const bond of fragment.kids.filter(node => node.name === "b")) {
      if (ids.has(bond.attrs.B)) bond.attrs.B = wrapperId;
      if (ids.has(bond.attrs.E)) bond.attrs.E = wrapperId;
    }
    fragment.kids.push(wrapper);
    nodes.forEach(([node]) => nodeMembers.delete(node));
    nodeMembers.set(wrapper, members);
    members.forEach(id => displayIds.set(id, wrapperId));
  }
}
