// A CDXML/CDX reaction step keeps its atom-map edges (reactant atom ↔ product atom pairs) as the
// opaque `ReactionStepAtomMap` list of source node ids, which name atoms of that step's own
// component molecules (each molecule's `cdxmlAtomIdsByAtomId`). Duplicate and paste used to keep
// every edge verbatim: export then wrote the copy's edges with the original's node ids (so the
// copy's map named the original's atoms), and an edge whose atom was left out of a partial copy
// was kept pointing at the original. These tests pin that every copy remaps or drops (with a
// warning) each edge, and that saved .chemdraft, CDXML and CDX output carry the remapped pairs.
import { beforeAll, describe, expect, it } from "vitest";
import {
  createEmptyDocument, readDocument, serializeDocument,
  type ChemDraftDocument, type DocumentObject, type MoleculeObject, type ReactionObject
} from "@chemdraft/chem-core";
import { exportDocumentToCdx, exportDocumentToCdxml, importCdx, openChemDraftPayload } from "@chemdraft/cdx-compat";
import { moleculeSmiles } from "@chemdraft/document-workflow-core";
import { computeStructureIdentifiers } from "@chemdraft/rdkit-adapter/identifiers";
import { installNodeRdkitModuleLoader } from "@chemdraft/rdkit-adapter/node";
import {
  createSelectionClipboardPayload, duplicateSelectedDocumentObjects, parseSelectionClipboardPayload,
  pasteSelectionClipboardPayload, serializeSelectionClipboardPayload
} from "../documentWorkflow";

beforeAll(() => installNodeRdkitModuleLoader());

// Entirely authored synthetic fixture: ethanol + water -> acetic acid, every atom mapped.
const FULL_MAP = "101 301 102 302 103 303 201 304";
const mappedReaction = (atomMap = FULL_MAP) => `<CDXML><page id="1">
  <scheme id="900"><step id="901" ReactionStepReactants="10 20" ReactionStepProducts="30"
    ReactionStepArrows="50" ReactionStepPlusses="70" ReactionStepAtomMap="${atomMap}"/></scheme>
  <fragment id="10">
    <n id="101" p="10 60" Element="6"/><n id="102" p="25 60" Element="6"/><n id="103" p="40 60" Element="8"/>
    <b id="104" B="101" E="102" Order="1"/><b id="105" B="102" E="103" Order="1"/>
  </fragment>
  <t id="70" p="55 60"><s>+</s></t>
  <fragment id="20"><n id="201" p="75 60" Element="8"/></fragment>
  <graphic id="50" GraphicType="Line" ArrowType="FullHead" BoundingBox="160 60 100 60"/>
  <fragment id="30">
    <n id="301" p="190 60" Element="6"/><n id="302" p="205 60" Element="6"/>
    <n id="303" p="205 45" Element="8"/><n id="304" p="220 60" Element="8"/>
    <b id="305" B="301" E="302" Order="1"/><b id="306" B="302" E="303" Order="2"/><b id="307" B="302" E="304" Order="1"/>
  </fragment>
</page></CDXML>`;

/** A CDX file of the reaction: the source CDXML written through the binary codec, visible layer only. */
const cdxBytes = (cdxml: string) => exportDocumentToCdx(open(cdxml), { embedNativePayload: false }).bytes;

const objects = (document: ChemDraftDocument) => document.pages[0]!.objects;
const reactions = (document: ChemDraftDocument) =>
  objects(document).filter((object): object is ReactionObject => object.type === "reaction");
const byId = (document: ChemDraftDocument) => new Map(objects(document).map(object => [object.id, object]));
const stepMap = (reaction: ReactionObject) =>
  (reaction.compatibility?.unknown.cdxmlStepAttributes as Record<string, string> | undefined)?.ReactionStepAtomMap;
const mapWarnings = (warnings: readonly string[]) => warnings.filter(warning => /atom.map/i.test(warning));

function open(contents: string | Uint8Array): ChemDraftDocument {
  const opened = typeof contents === "string" ? openChemDraftPayload(contents) : importCdx(contents);
  expect(opened.document, JSON.stringify(opened.warnings)).toBeDefined();
  return opened.document!;
}

function selectAll(document: ChemDraftDocument, keep: (object: DocumentObject) => boolean = () => true): ChemDraftDocument {
  return { ...document, selection: { pageId: document.pages[0]!.id, objectIds: objects(document).filter(keep).map(object => object.id) } };
}

interface Edge { from: { objectId: string; atomId: string; element: string }; to: { objectId: string; atomId: string; element: string } }

/**
 * The test's own oracle for what a step's map means: each source node id names exactly one atom of
 * one of the step's own component molecules. Throws if any id does not resolve, or resolves twice.
 */
function edges(reaction: ReactionObject, document: ChemDraftDocument): Edge[] {
  const all = byId(document);
  const molecules = [...new Set(reaction.components.map(component => component.objectId))]
    .map(id => all.get(id)).filter((object): object is MoleculeObject => object?.type === "molecule");
  const resolve = (sourceId: string) => {
    const hits = molecules.flatMap(molecule => molecule.atoms
      .filter(atom => (molecule.compatibility?.unknown.cdxmlAtomIdsByAtomId as Record<string, string> | undefined)?.[atom.id] === sourceId)
      .map(atom => ({ objectId: molecule.id, atomId: atom.id, element: atom.element })));
    if (hits.length !== 1) throw new Error(`map id ${sourceId} resolves to ${hits.length} atoms of reaction ${reaction.id}`);
    return hits[0]!;
  };
  const ids = (stepMap(reaction) ?? "").split(/\s+/).filter(Boolean);
  expect(ids.length % 2).toBe(0);
  const result: Edge[] = [];
  for (let index = 0; index < ids.length; index += 2) result.push({ from: resolve(ids[index]!), to: resolve(ids[index + 1]!) });
  return result;
}

const elementPairs = (list: Edge[]) => list.map(edge => `${edge.from.element}>${edge.to.element}`);

async function roleSmiles(reaction: ReactionObject, document: ChemDraftDocument) {
  const all = byId(document);
  const out: Record<string, string[]> = { reactant: [], agent: [], product: [] };
  for (const component of reaction.components) {
    const molecule = all.get(component.objectId) as MoleculeObject;
    out[component.role]!.push(await moleculeSmiles(molecule, 0, [], computeStructureIdentifiers));
  }
  return out;
}

/** Every exported step: its id lists, and for each map id the fragment that holds that node. */
function exportedSteps(xml: string) {
  const fragmentOfNode = new Map<string, string>();
  for (const fragment of xml.matchAll(/<fragment\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/fragment>/g)) {
    for (const node of fragment[2]!.matchAll(/<n\b[^>]*\bid="([^"]+)"/g)) fragmentOfNode.set(node[1]!, fragment[1]!);
  }
  return [...xml.matchAll(/<step\s+([^>]+)\/>/g)].map(match => {
    const attributes = Object.fromEntries([...match[1]!.matchAll(/(\w+)="([^"]*)"/g)].map(attribute => [attribute[1]!, attribute[2]!]));
    const list = (name: string) => (attributes[name] ?? "").split(/\s+/).filter(Boolean);
    return { attributes, map: list("ReactionStepAtomMap"), fragments: [...list("ReactionStepReactants"), ...list("ReactionStepProducts")],
      fragmentOf: (nodeId: string) => fragmentOfNode.get(nodeId) };
  });
}

function expectExportedMapsOwnTheirAtoms(xml: string, pairCounts: number[]) {
  const steps = exportedSteps(xml);
  expect(steps.map(step => step.map.length / 2)).toEqual(pairCounts);
  for (const step of steps) {
    for (const nodeId of step.map) expect(step.fragments, `map node ${nodeId}`).toContain(step.fragmentOf(nodeId));
  }
  const [first, ...rest] = steps;
  for (const step of rest) for (const nodeId of step.map) expect(first!.map).not.toContain(nodeId);
}

async function expectSameChemistry(original: ReactionObject, originalDocument: ChemDraftDocument, copy: ReactionObject, copyDocument: ChemDraftDocument) {
  expect(copy.components.map(component => component.role)).toEqual(original.components.map(component => component.role));
  expect(await roleSmiles(copy, copyDocument)).toEqual(await roleSmiles(original, originalDocument));
}

describe("reaction atom-map edges follow Duplicate", () => {
  it("remaps every edge of a duplicated reaction and leaves the original's edges untouched", async () => {
    const document = selectAll(open(mappedReaction()));
    const original = reactions(document)[0]!;
    const originalEdges = edges(original, document);
    expect(elementPairs(originalEdges)).toEqual(["C>C", "C>C", "O>O", "O>O"]);
    const before = await roleSmiles(original, document);
    expect(before).toEqual({ reactant: ["CCO", "O"], agent: [], product: ["CC(=O)O"] });
    const originalIds = new Set(objects(document).map(object => object.id));

    const warnings: string[] = [];
    const duplicated = duplicateSelectedDocumentObjects(document, { x: 0, y: 200 }, warnings);
    expect(mapWarnings(warnings)).toEqual([]);
    const [kept, copy] = reactions(duplicated);
    expect(kept!.id).toBe(original.id);
    expect(stepMap(kept!)).toBe(FULL_MAP);
    expect(edges(kept!, duplicated)).toEqual(originalEdges);
    const copyEdges = edges(copy!, duplicated);
    expect(copyEdges).toHaveLength(4);
    for (const edge of copyEdges) {
      expect(originalIds.has(edge.from.objectId)).toBe(false);
      expect(originalIds.has(edge.to.objectId)).toBe(false);
    }
    expect(elementPairs(copyEdges)).toEqual(elementPairs(originalEdges));
    expect(await roleSmiles(kept!, duplicated)).toEqual(before);
    await expectSameChemistry(original, document, copy!, duplicated);

    // CDXML: the copy's pairs name the copy's own nodes, never the original's.
    expectExportedMapsOwnTheirAtoms(exportDocumentToCdxml(duplicated).contents, [4, 4]);
    // CDX: reopen the binary visible layer; every step's map resolves within its own components.
    const reopenedCdx = open(exportDocumentToCdx(duplicated, { embedNativePayload: false }).bytes);
    expect(reactions(reopenedCdx).map(reaction => elementPairs(edges(reaction, reopenedCdx))))
      .toEqual([elementPairs(originalEdges), elementPairs(originalEdges)]);
    // Saved .chemdraft round trip keeps the copy's edges on the copy's atoms.
    const saved = readDocument(JSON.parse(serializeDocument(duplicated))).document;
    expect(edges(reactions(saved)[1]!, saved)).toEqual(copyEdges);
    expectExportedMapsOwnTheirAtoms(exportDocumentToCdxml(saved).contents, [4, 4]);
  });

  it("keeps the original's edges on its own atoms when the copy is exported first", () => {
    const document = selectAll(open(mappedReaction()));
    const originalIds = new Set(objects(document).map(object => object.id));
    const duplicated = duplicateSelectedDocumentObjects(document, { x: 0, y: 200 });
    const page = duplicated.pages[0]!;
    // Bring the copy to the back: it is written first and claims the source node ids.
    const reordered = { ...duplicated, pages: [{ ...page, objects: [
      ...page.objects.filter(object => !originalIds.has(object.id)), ...page.objects.filter(object => originalIds.has(object.id))
    ] }] };
    const xml = exportDocumentToCdxml(reordered).contents;
    const steps = exportedSteps(xml);
    expect(steps.map(step => step.map.length)).toEqual([8, 8]);
    for (const step of steps) for (const nodeId of step.map) expect(step.fragments).toContain(step.fragmentOf(nodeId));
    const reopened = open(xml.replace(/<objecttag\b[^>]*\/>/g, ""));
    for (const reaction of reactions(reopened)) expect(elementPairs(edges(reaction, reopened))).toEqual(["C>C", "C>C", "O>O", "O>O"]);
  });

  it("drops, with a warning, an edge whose atom a partial duplicate leaves out", async () => {
    const document = open(mappedReaction());
    const water = objects(document).find(object => object.compatibility?.originalId === "20")!;
    const partial = selectAll(document, object => object.id !== water.id);
    const originalIds = new Set(objects(document).map(object => object.id));
    const warnings: string[] = [];
    const duplicated = duplicateSelectedDocumentObjects(partial, { x: 0, y: 200 }, warnings);
    expect(mapWarnings(warnings)).toHaveLength(1);
    expect(mapWarnings(warnings)[0]).toMatch(/1 atom-map pair/);
    const [kept, copy] = reactions(duplicated);
    expect(stepMap(kept!)).toBe(FULL_MAP);
    expect(edges(kept!, duplicated)).toHaveLength(4);
    const copyEdges = edges(copy!, duplicated);
    expect(stepMap(copy!)).toBe("101 301 102 302 103 303");
    expect(elementPairs(copyEdges)).toEqual(["C>C", "C>C", "O>O"]);
    for (const edge of copyEdges) expect(originalIds.has(edge.from.objectId) || originalIds.has(edge.to.objectId)).toBe(false);
    expect(copy!.components.map(component => component.role)).toEqual(["reactant", "product"]);
    expect(await roleSmiles(copy!, duplicated)).toEqual({ reactant: ["CCO"], agent: [], product: ["CC(=O)O"] });
    expectExportedMapsOwnTheirAtoms(exportDocumentToCdxml(duplicated).contents, [4, 3]);
  });

  it("drops the whole map and records it absent when no edge survives the copy", () => {
    const document = open(mappedReaction("201 304"));
    const product = objects(document).find(object => object.compatibility?.originalId === "30")!;
    const warnings: string[] = [];
    const duplicated = duplicateSelectedDocumentObjects(selectAll(document, object => object.id !== product.id), { x: 0, y: 200 }, warnings);
    expect(mapWarnings(warnings)).toHaveLength(1);
    const copy = reactions(duplicated)[1]!;
    expect(stepMap(copy)).toBeUndefined();
    expect(copy.mappingState).toBe("absent");
    expect(reactions(duplicated)[0]!.mappingState).toBe("unknown");
    expect(exportedSteps(exportDocumentToCdxml(duplicated).contents).map(step => step.map.length)).toEqual([2, 0]);
  });
});

describe("reaction atom-map edges follow a paste of a CDX reaction", () => {
  const clipboardRoundTrip = (document: ChemDraftDocument) =>
    parseSelectionClipboardPayload(serializeSelectionClipboardPayload(createSelectionClipboardPayload(document)!))!;

  it.each(["same document", "new document"])("remaps every edge when pasted into the %s", async target => {
    const document = selectAll(open(cdxBytes(mappedReaction())));
    const original = reactions(document)[0]!;
    const originalEdges = edges(original, document);
    expect(originalEdges).toHaveLength(4);
    const originalIds = new Set(objects(document).map(object => object.id));
    const warnings: string[] = [];
    const destination = target === "same document" ? document : createEmptyDocument();
    const pasted = pasteSelectionClipboardPayload(destination, clipboardRoundTrip(document), { x: 300, y: 400 }, warnings);
    expect(mapWarnings(warnings)).toEqual([]);
    const copy = reactions(pasted).at(-1)!;
    expect(originalIds.has(copy.id) && target === "same document").toBe(false);
    const copyEdges = edges(copy, pasted);
    expect(elementPairs(copyEdges)).toEqual(elementPairs(originalEdges));
    if (target === "same document") {
      for (const edge of copyEdges) expect(originalIds.has(edge.from.objectId) || originalIds.has(edge.to.objectId)).toBe(false);
      expect(edges(reactions(pasted)[0]!, pasted)).toEqual(originalEdges);
    }
    await expectSameChemistry(original, document, copy, pasted);
    expectExportedMapsOwnTheirAtoms(exportDocumentToCdxml(pasted).contents, target === "same document" ? [4, 4] : [4]);
    const reopened = open(exportDocumentToCdx(pasted, { embedNativePayload: false }).bytes);
    for (const reaction of reactions(reopened)) expect(elementPairs(edges(reaction, reopened))).toEqual(elementPairs(originalEdges));
  });

  it("drops, with a warning, an edge whose atom a partial copy leaves out", () => {
    const document = open(cdxBytes(mappedReaction()));
    const water = objects(document).find(object => object.compatibility?.originalId === "20")!;
    const warnings: string[] = [];
    const pasted = pasteSelectionClipboardPayload(createEmptyDocument(),
      clipboardRoundTrip(selectAll(document, object => object.id !== water.id)), { x: 300, y: 400 }, warnings);
    expect(mapWarnings(warnings)).toHaveLength(1);
    const copy = reactions(pasted)[0]!;
    expect(elementPairs(edges(copy, pasted))).toEqual(["C>C", "C>C", "O>O"]);
    expectExportedMapsOwnTheirAtoms(exportDocumentToCdxml(pasted).contents, [3]);
    expect(edges(reactions(document)[0]!, document)).toHaveLength(4);
  });
});

describe("reaction atom-map export", () => {
  it("drops, with a warning, an edge whose atom is no longer in the step", () => {
    const document = open(mappedReaction());
    const reaction = reactions(document)[0]!;
    const water = objects(document).find(object => object.compatibility?.originalId === "20")!;
    reaction.components = reaction.components.filter(component => component.objectId !== water.id);
    const exported = exportDocumentToCdxml(document);
    expect(exported.warnings).toContainEqual(expect.objectContaining({ code: "cdxml.reaction_atom_map_pair_dropped", sourceObjectId: reaction.id }));
    expect(exportedSteps(exported.contents)[0]!.attributes.ReactionStepAtomMap).toBe("101 301 102 302 103 303");
  });

  it("writes an unchanged source map byte for byte", () => {
    const source = mappedReaction("101  301 102 302 103 303 201 304");
    const exported = exportDocumentToCdxml(open(source));
    expect(exportedSteps(exported.contents)[0]!.attributes.ReactionStepAtomMap).toBe("101  301 102 302 103 303 201 304");
    expect(exported.warnings.map(warning => warning.code)).not.toContain("cdxml.reaction_atom_map_pair_dropped");
  });
});
