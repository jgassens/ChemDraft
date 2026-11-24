import { atomicNumberForElementSymbol, isDativeBond, moleculeToMolfileV2000, rGroupNumberFromLabel, type ChemDraftDocument,
  type DocumentPage, type MoleculeObject } from "@chemdraft/chem-core";
import { parseMolfileGraph } from "@chemdraft/clipboard-adapter";
import { expandNativeMoleculeLabelGroups, nativeSingleHeavyElementLabelValence } from "@chemdraft/document-workflow-core";
import { nativeBondOrderResolution, planNativeNewBondForAtom } from "@chemdraft/layout-engine";
import type { PluginHandoffGraphRequest, PluginHandoffGraphResult, PluginSuggestConnectionPointsRequest,
  PluginSuggestConnectionPointsResult } from "@chemdraft/plugin-api";
import type { HandoffGraphWork } from "../chemistry3d/handoffAudit";
import { runHandoffGraphInConformerWorker } from "../chemistry3d/client";
import { atomMapNumbers } from "./requestWrites/storedStereo";

function selectedMolecule(document: ChemDraftDocument, objectId: string): { molecule: MoleculeObject; page: DocumentPage } {
  if (!document.selection.objectIds.includes(objectId)) throw new Error(`Molecule "${objectId}" is not selected.`);
  const locations = document.pages.flatMap(page => {
    if (document.selection.pageId && document.selection.pageId !== page.id) return [];
    const object = page.objects.find(object => object.id === objectId);
    return object ? [{ object, page }] : [];
  });
  const [location] = locations;
  if (locations.length !== 1 || location?.object.type !== "molecule") {
    throw new Error(`Select one molecule with ID "${objectId}" on its page to read its drawn graph.`);
  }
  return { molecule: location.object, page: location.page };
}

function reactionMembership(page: DocumentPage, objectId: string): PluginHandoffGraphResult["reactionMembership"] {
  const attributes = ["ReactionStepAtomMap", "ReactionStepAtomMapManual", "ReactionStepAtomMapAuto"] as const;
  return page.objects.flatMap(object => {
    if (object.type !== "reaction") return [];
    const roles = object.components.filter(component => component.objectId === objectId);
    if (!roles.length) return [];
    const source = object.compatibility?.unknown.cdxmlStepAttributes;
    const raw = source && typeof source === "object" ? source as Record<string, unknown> : {};
    const atomMaps = attributes.flatMap(attribute => {
      const value = raw[attribute];
      return typeof value === "string" && value.trim() ? [{ attribute, value }] : [];
    });
    return roles.map(({ role }) => ({ reactionId: object.id, role, mappingState: object.mappingState, atomMaps }));
  });
}

function retainedAtomMaps(molecule: MoleculeObject): PluginHandoffGraphResult["sourceAtomMaps"] {
  if (!molecule.structureFormat.startsWith("molfile-") || !molecule.structure.trim()) return [];
  const source = molecule.structure;
  // Read the source only for metadata the native atom schema does not carry.
  // A CTAB query cannot be reduced to a single finite graph for the handoff.
  if (/^M  ALS\b/m.test(source) || /^M  V30\s+\d+\s+(?:NOT\s+)?\[/m.test(source)) {
    throw new Error(`Molecule "${molecule.id}" contains a retained atom list or query group.`);
  }
  const graph = parseMolfileGraph(source);
  return atomMapNumbers(source, graph).flatMap((map, i) => Number.isSafeInteger(map) && map > 0 ? [{ atom: i + 1, map }] : []);
}

export function prepareHandoffGraph(request: PluginHandoffGraphRequest, document: ChemDraftDocument): HandoffGraphWork {
  const { molecule, page } = selectedMolecule(document, request.objectId);
  const fail = (reason: string) => new Error(`Handoff graph for molecule "${molecule.id}": ${reason}`);
  if (!molecule.atoms.length) throw fail("there is no live drawn graph. The stored structure cannot be used as a fallback.");
  if (molecule.rGroups.length) throw fail(`R-group "${molecule.rGroups[0]!.label}" cannot be represented as a molecule.`);
  const { molecule: expanded, expansions, placeholderAtoms } = expandNativeMoleculeLabelGroups(molecule);
  const atomIndex = new Map(expanded.atoms.map((atom, i) => [atom.id, i]));
  if (atomIndex.size !== expanded.atoms.length) throw fail("the drawn graph has duplicate atom IDs.");
  const drawnLabels = new Map(molecule.atoms.map(atom => [atom.id, atom.element]));
  const expandedLabels = [...expansions.map(({ atomId, label }) => ({ atomId, label }))];
  for (const { label, atomIds } of molecule.superatoms) {
    if (!atomIds?.length || atomIds.some(id => !atomIndex.has(id))) throw fail(`superatom "${label}" has no complete expansion in the drawn graph.`);
    expandedLabels.push({ atomId: atomIds[0]!, label });
  }
  const atoms = expanded.atoms.map(atom => {
    const drawnLabel = drawnLabels.get(atom.id);
    const isConnectionPoint = drawnLabel === "X";
    if (rGroupNumberFromLabel(atom.element) !== undefined) throw fail(`R-group "${atom.element}" cannot be represented as a molecule.`);
    if (!isConnectionPoint && atom.element === "*") throw fail(`dummy atom "${drawnLabel ?? atom.element}" at "${atom.id}" is not a drawn X connection point.`);
    const element = atom.element === "D" || atom.element === "T" ? "H" : atom.element;
    const literal = nativeSingleHeavyElementLabelValence(atom.element);
    const spelled = atomicNumberForElementSymbol(element) === undefined ? literal : undefined;
    const statedHydrogens = spelled?.hydrogens ?? atom.hydrogenCount ?? (atom.labelLiteral && !isConnectionPoint ? 0 : undefined);
    return { atomId: atom.id, drawnLabel, isConnectionPoint, element: isConnectionPoint ? "*" : spelled?.element ?? element,
      charge: atom.formalCharge, radical: atom.markRadicals, isotope: atom.element === "D" ? 2 : atom.element === "T" ? 3 : atom.isotope,
      statedHydrogens };
  });
  const bonds = expanded.bonds.map(bond => {
    const a = atomIndex.get(bond.fromAtomId), b = atomIndex.get(bond.toAtomId);
    if (a === undefined || b === undefined || a === b) throw fail(`bond "${bond.id}" has missing or identical endpoints.`);
    if (isDativeBond(bond)) throw fail(`coordination bond "${bond.id}" cannot be represented in the handoff graph.`);
    const drawnStyle = bond.display?.bondStyle;
    const style = drawnStyle === "wedge" || drawnStyle === "hashed" || drawnStyle === "wavy" ? drawnStyle : undefined;
    if (style && bond.order !== "single") throw fail(`bond "${bond.id}" has a ${style} stereo flag on order "${bond.order}".`);
    return { id: bond.id, a, b, order: bond.order, either: bond.stereo === "either", style };
  });
  const forWriter = { ...expanded, atoms: expanded.atoms.map((atom, i) =>
    atoms[i]!.isConnectionPoint ? { ...atom, element: "*" } : atom) };
  let written: ReturnType<typeof moleculeToMolfileV2000>;
  try {
    written = moleculeToMolfileV2000(forWriter, {
      document: { ...document, pages: [page] }, fromDocFrame: true, coordinateScale: 1, unknownBondOrders: "refuse",
      abbreviations: "dummy", placeholderAtoms, spellLabel: nativeSingleHeavyElementLabelValence,
      kekuleBondOrders: nativeBondOrderResolution(expanded.atoms, expanded.bonds).kekuleOrders
    });
  } catch (error) {
    throw fail(`${error instanceof Error ? error.message : String(error)} The stored structure cannot be used as a fallback.`);
  }
  // Type 4 preserves aromatic order for RDKit to perceive. Dashed on a multiple bond
  // warns only about its appearance. Every other writer warning indicates a loss.
  const losses = written.warnings.filter(warning =>
    !warning.endsWith("preserved as type 4 (aromatic).") && !warning.endsWith("dashed style not preserved."));
  if (losses.length) throw fail(losses.join(" "));
  return { molfile: written.contents, objectId: molecule.id, pageId: page.id, atoms, bonds, expandedLabels,
    reactionMembership: reactionMembership(page, molecule.id), sourceAtomMaps: retainedAtomMaps(molecule),
    serializerWarnings: written.warnings };
}

export function handoffGraphForPlugin(request: PluginHandoffGraphRequest, document: ChemDraftDocument,
  signal: AbortSignal): Promise<PluginHandoffGraphResult> {
  return runHandoffGraphInConformerWorker(prepareHandoffGraph(request, document), signal);
}

export function suggestConnectionPointsForPlugin(request: PluginSuggestConnectionPointsRequest,
  document: ChemDraftDocument): PluginSuggestConnectionPointsResult {
  const { molecule, page } = selectedMolecule(document, request.objectId);
  const pageBounds = { x: 0, y: 0, width: page.width, height: page.height };
  // Reserve each suggested endpoint while planning the next one in this same patch.
  const atoms = [...molecule.atoms];
  return { points: request.anchors.map((anchorAtomId, index) => {
    const anchor = molecule.atoms.find(atom => atom.id === anchorAtomId);
    if (!anchor) throw new Error(`Molecule "${molecule.id}" has no drawn anchor atom "${anchorAtomId}".`);
    const plan = planNativeNewBondForAtom({ ...molecule, atoms }, anchorAtomId, pageBounds);
    if (!plan) throw new Error(`No open bond position on the page for "${anchor.element}" atom "${anchorAtomId}".`);
    const { x, y } = plan.newAtomPoint;
    const reservedId = uniqueReservedId(atoms, index);
    atoms.push({ id: reservedId, element: "X", formalCharge: 0, x, y });
    return { anchorAtomId, x, y };
  }) };
}

function uniqueReservedId(atoms: MoleculeObject["atoms"], index: number): string {
  let id = `handoff-point-${index}`;
  while (atoms.some(atom => atom.id === id)) id = `_${id}`;
  return id;
}
