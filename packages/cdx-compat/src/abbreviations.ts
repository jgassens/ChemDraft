import { elementSymbolForAtomicNumber, normalizeAtomIsotope, type MoleculeAtom, type MoleculeObject } from "@chemdraft/chem-core";
import { bondedElementLabelMeaning } from "@chemdraft/template-library";
import type { CompatibilityConversionWarning } from "./index";
import { cdxElementFromOrderedTree, type CdxElement } from "./cdxBinary";

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
  /** Older snapshots also stored the parser's ordered view beside a flattened codec tree. */
  sourceNode?: { name: string; attributes: Record<string, string>; children: Record<string, unknown>[] };
  depth?: number;
  superatomIndex?: number;
  nativeState?: ReturnType<typeof cdxmlAtomNativeState>;
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

/** Compare native values with native values, not with source attributes ignored by import.
 * Nulls survive native JSON saves, including the absence of a native hydrogen constraint.
 */
export function cdxmlAtomNativeState(atom: MoleculeAtom, stereochemistry: readonly string[] = []) {
  return {
    element: atom.element, isotope: atom.isotope ?? null, formalCharge: atom.formalCharge,
    markRadicals: atom.markRadicals ?? 0, hydrogenCount: atom.hydrogenCount ?? null,
    labelLiteral: atom.labelLiteral === true, labelBondSide: atom.labelBondSide ?? null,
    stereo: stereochemistry.filter(value => value.startsWith(`${atom.id}:`)).map(value => value.slice(atom.id.length + 1)),
    x: atom.x, y: atom.y
  };
}

// Released snapshots predate nativeState. Reproduce their import policy without treating an
// opaque NumHydrogens on an ordinary atom as an edit to its engine-derived implicit H count.
function legacyNativeState(source: CdxElement, atom: MoleculeAtom, molecule: MoleculeObject) {
  const original = cdxmlAtomChemistry(source.attrs, abbreviationLabel(source));
  const hydrogenCount = Number(source.attrs.NumHydrogens);
  const aromatic = molecule.bonds.some(bond => bond.order === "aromatic" &&
    [bond.fromAtomId, bond.toAtomId].includes(atom.id));
  const stereo = source.attrs.AS?.trim().toUpperCase();
  return cdxmlAtomNativeState({ ...original, id: atom.id, x: atom.x, y: atom.y,
    ...((original.labelLiteral || aromatic) && Number.isInteger(hydrogenCount) && hydrogenCount >= 0
      ? { hydrogenCount } : {})
  }, stereo === "R" || stereo === "S" ? [`${atom.id}:${stereo}`] : []);
}

/** Change label text only when its native meaning changed; untouched styled runs stay intact. */
function mergeLabel(source: CdxElement, label: string, warn: (reason: string) => void): void {
  const text = source.kids.find(child => child.name === "t");
  if (text && elementText(text).trim() === label) return;
  if (source.attrs.GenericNickname !== undefined) source.attrs.GenericNickname = label;
  if (!text) {
    source.kids.push(element("t", {}, [element("s", {}, [], label)]));
    return;
  }
  const runs = text.kids.filter(child => child.name === "s");
  if (runs.length > 1 || (runs.length > 0 && (text.text || text.kids.some(child => child.name === "#text" && child.text)))) {
    warn("edited label text uses the first source text segment's formatting; the original run formatting and boundaries could not be carried.");
  }
  const replacement = element("s", text.text ? {} : { ...runs[0]?.attrs }, [], label);
  text.text = "";
  text.kids = [replacement, ...text.kids.filter(child => child.name !== "s" && child.name !== "#text")];
}

function mergeSourceAtom(copy: CdxElement, generated: CdxElement, atom: MoleculeAtom,
  record: SourceAbbreviation, molecule: MoleculeObject, warnings: CompatibilityConversionWarning[]): void {
  const original = record.nativeState ?? legacyNativeState(record.source, atom, molecule);
  const current = cdxmlAtomNativeState(atom, molecule.chemistry?.stereochemistry);
  const warn = (reason: string) => warnings.push({ code: "cdxml.atom_snapshot_attribute_not_written",
    sourceObjectId: record.source.attrs.id, atomIds: [atom.id],
    message: `Source atom node ${record.source.attrs.id ?? atom.id}: ${reason}` });
  const set = (key: string, value: string | undefined) => {
    if (value === undefined) delete copy.attrs[key]; else copy.attrs[key] = value;
  };
  if (current.formalCharge !== original.formalCharge) set("Charge", String(current.formalCharge));
  if (current.markRadicals !== original.markRadicals) set("Radical", generated.attrs.Radical);
  if (current.hydrogenCount !== original.hydrogenCount) set("NumHydrogens", generated.attrs.NumHydrogens);
  const isotope = (state: typeof current) => state.element === "D" ? 2 : state.element === "T" ? 3 : state.isotope;
  if (isotope(current) !== isotope(original)) set("Isotope", generated.attrs.Isotope);
  if (current.element !== original.element) {
    // A literal's element field IS its label. Its source Element is independent wrapper data.
    if (!current.labelLiteral) set("Element", generated.attrs.Element ?? "6");
    else if (copy.attrs.Element === original.element) set("Element", current.element);
    if (current.labelLiteral || copy.kids.some(child => child.name === "t")) {
      const sourceLabel = abbreviationLabel(record.source);
      const label = sourceLabel === "H" && ["H", "D", "T"].includes(current.element) ? "H" : current.element;
      mergeLabel(copy, label, warn);
    }
  }
  if (current.labelLiteral !== original.labelLiteral) {
    set("NodeType", generated.attrs.NodeType);
    set("GenericNickname", generated.attrs.GenericNickname);
    set("Element", generated.attrs.Element ?? (current.labelLiteral ? undefined : "6"));
    if (current.labelLiteral) mergeLabel(copy, current.element, warn);
  }
  if (!sameMembers(current.stereo, original.stereo)) {
    set("AS", current.stereo.length === 1 && ["R", "S"].includes(current.stereo[0]) ? current.stereo[0] : undefined);
    if (current.stereo.length && copy.attrs.AS === undefined) warn("the edited atom stereo assignment cannot be written as AS; it remains only in the native document.");
  }
  if (JSON.stringify(current.labelBondSide) !== JSON.stringify(original.labelBondSide)) {
    warn("the edited side-dependent label interpretation has no source attribute; only its drawn bond side is visible.");
  }
  const moved = record.nativeState ? current.x !== original.x || current.y !== original.y
    : JSON.stringify(copy.attrs.p?.trim().split(/\s+/).map(Number)) !== JSON.stringify(generated.attrs.p?.split(/\s+/).map(Number));
  if (moved || copy.attrs.p === undefined) copy.attrs.p = generated.attrs.p;
}

/** Restore grouping around the live graph. Chemistry always reads the graph, never this snapshot. */
export function restoreCdxmlAbbreviations(
  fragment: CdxElement,
  molecule: MoleculeObject,
  atomIds: ReadonlyMap<string, string>,
  nextId: () => string,
  warnings: CompatibilityConversionWarning[]
): Set<string> {
  const restoredAtoms = new Set<string>();
  const stored = molecule.compatibility?.unknown.cdxmlAbbreviations;
  const sources = (Array.isArray(stored) ? stored : []).filter((value): value is SourceAbbreviation =>
    !!value && typeof value === "object" && Array.isArray(value.atomIds) &&
    value.atomIds.every((id: unknown) => typeof id === "string") && typeof value.expanded === "boolean" &&
    value.source?.name === "n" && !!value.source.attrs && Array.isArray(value.source.kids))
    .map(record => {
      const ordered = record.sourceNode;
      return ordered?.name === "n" && ordered.attributes && Array.isArray(ordered.children)
        ? { ...record, source: cdxElementFromOrderedTree([{ CDXML: [{ n: ordered.children, ":@": ordered.attributes }] }]).kids[0] }
        : record;
    });
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
    if (!nativeAtom) continue;
    const copy = cloneSource(record.source, id!);
    mergeSourceAtom(copy, fragment.kids[index], nativeAtom, record, molecule, warnings);
    fragment.kids[index] = copy;
    restoredAtoms.add(nativeAtom.id);
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
    const anchorNode = fragment.kids.find(node => node.name === "n" && node.attrs.id === displayIds.get(anchorId ?? group.atomIds![0]));
    if (anchorNode) attributes.p = anchorNode.attrs.p;
    const sourceBody = sourceCopy?.kids.find(child => child.name === "fragment");
    const body = element("fragment", { ...sourceBody?.attrs, id: nextId() }, [...nodes.map(([node]) => node), ...bodyBonds,
      ...(sourceBody?.kids.filter(child => child.name !== "n" && child.name !== "b") ?? [])]);
    if (anchorId) {
      const connectionId = nextId();
      body.kids.push(element("n", { id: connectionId, NodeType: "ExternalConnectionPoint" }),
        element("b", { id: nextId(), B: connectionId, E: displayIds.get(anchorId)!, Order: "1" }));
    }
    const wrapper = sourceCopy ?? element("n", attributes);
    wrapper.attrs = attributes;
    wrapper.kids = sourceCopy
      ? sourceCopy.kids.map(child => child.name === "fragment" ? body : child)
      : [body];
    if (abbreviationLabel(wrapper) !== group.label) mergeLabel(wrapper, group.label, reason => warnings.push({
      code: "cdxml.atom_snapshot_attribute_not_written", sourceObjectId: source?.source.attrs.id,
      message: `Source atom node ${source?.source.attrs.id ?? wrapperId}: ${reason}`
    }));
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
  return restoredAtoms;
}
