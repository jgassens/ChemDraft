import {
  applyPatch, ChemDraftSyntheticStylePreset, stylePresetToObjectStyle, DocumentObjectSchema, type Anchor, type ChemDraftDocument,
  type DocumentObject, type DocumentPatch, type MoleculeObject, type NativeTextStyle
} from "@chemdraft/chem-core";
import {
  createNativeTextObject, layoutReactionScheme, nextObjectId,
  nativeTextObjectSizeForText, smilesPasteBondLengthPx, stereoPerceptionMolfile,
  nativeAtomLabelReading, nativeSingleBondGraphMetadata, nativeSingleBondGraphSmiles,
  normalizeNativeMoleculeGeometry, defaultNativeMoleculeTransform
} from "@chemdraft/document-workflow-core";
import { nativeMoleculeRings, planFigureInterlockCrossings, planPageSvgRender } from "@chemdraft/layout-engine";
import { unselectedObjectOrderChange } from "@chemdraft/chem-core";
import { assistantDocumentContentUnchanged } from "./historyPort";
import { RESERVED_PLUGIN_OBJECT_IDS } from "../plugins/reservedObjectIds";
import {
  assistantScope, recordAssistantInsertions, requireDocument,
  type AssistantToolContext, type AssistantPageGrowth
} from "./AssistantToolContext";
import {
  ASSISTANT_GAP, ASSISTANT_MARGIN, RELATIVE_GAP, choosePagePlacements, figureTransforms, anchoredPagePlacements, objectRect, pageContentRect, relativeRect, unionRects,
  type RelativeSide, type PagePlacements
} from "./placement";
import { toolSchemas, type FigureTarget, type ToolInput } from "./tools/schemas";

export interface AssistantWrite {
  patch: DocumentPatch; summary: string; warnings: string[];
  /** Input SMILES keyed by the actual new molecule id, checked again after patch normalization. */
  expectedSmiles?: ReadonlyMap<string, string>;
  /** Captured before preparation; also checked inside the desktop write gate. */
  checkPreconditions?: (document: ChemDraftDocument) => void;
  pageGrowth?: AssistantPageGrowth & { items: { objectIds: string[]; label: string }[] };
}

export const PAGE_GROWTH_DECLINED = "declined: the user chose not to enlarge the page";

/** Snapshot content, including page membership, before any asynchronous preparation. */
export function captureWritePreconditions(document: ChemDraftDocument, objectIds: readonly string[],
  anchoredAction?: string, additionalIds: readonly string[] = []): (latest: ChemDraftDocument) => void {
  const dependencies = new Set([...objectIds, ...additionalIds]);
  const content = (current: ChemDraftDocument) => JSON.stringify(current.pages.flatMap(page =>
    page.objects.filter(object => dependencies.has(object.id)).map(object => ({ pageId: page.id, object }))));
  const baseline = content(document);
  const check = (latest: ChemDraftDocument) => {
    if (content(latest) !== baseline) {
      throw new Error("The document changed while the assistant prepared this write; read it again and retry.");
    }
    if (anchoredAction) for (const id of objectIds) refuseAnchoredObjects(latest, id, anchoredAction);
  };
  check(document);
  return check;
}
export function scopeRefusal(context: AssistantToolContext, ids: readonly string[]) {
  const scope = assistantScope(context);
  const id = ids.find(id => !scope.has(id));
  return id ? { refused: true as const, reason: `${id} was not selected when you sent the request` } : undefined;
}
export function findObject(document: ChemDraftDocument, id: string) {
  for (const page of document.pages) {
    const object = page.objects.find(object => object.id === id);
    if (object) return { object, page };
  }
  throw new Error(`Object "${id}" does not exist in the assistant's document.`);
}

export async function inspectSmiles(context: AssistantToolContext, smiles: string) {
  const result = await context.chemistry.inspectStructure("smiles", smiles);
  if (!result.valid) throw new Error(result.reason);
  if (!Number.isInteger(result.heavyAtoms) || result.heavyAtoms < 0 || result.heavyAtoms > 500) {
    throw new Error(`Structure exceeds the 500 heavy atom limit (${result.heavyAtoms}).`);
  }
  if (!result.canonicalSmiles) throw new Error("RDKit did not return a canonical SMILES.");
  return result;
}
export async function inspectMolecule(context: AssistantToolContext, molecule: MoleculeObject) {
  const warnings: string[] = [];
  const molfile = stereoPerceptionMolfile(molecule, warnings);
  if (warnings.length) throw new Error(warnings.join(" "));
  const result = await context.chemistry.inspectStructure("molfile", molfile);
  if (!result.valid) throw new Error(result.reason);
  if (!result.canonicalSmiles) throw new Error("RDKit did not return a canonical SMILES.");
  return { ...result, molfile };
}
async function assertCanonical(context: AssistantToolContext, molecule: MoleculeObject, input: string) {
  const source = await inspectSmiles(context, input);
  const output = await inspectMolecule(context, molecule);
  if (source.canonicalSmiles !== output.canonicalSmiles) {
    throw new Error(`Canonical SMILES mismatch for ${molecule.id}; refusing a change to chemical identity (including radical or isotope loss).`);
  }
}
async function buildMolecule(context: AssistantToolContext, smiles: string): Promise<MoleculeObject> {
  await inspectSmiles(context, smiles); // cap before expensive depiction
  const result = await context.chemistry.structureFromSmiles({ smiles, origin: context.plugin.name });
  if (!result.available || !result.built) throw new Error(result.reason);
  const object = DocumentObjectSchema.parse(result.object);
  if (object.type !== "molecule") throw new Error("The structure builder did not return a molecule.");
  await assertCanonical(context, object, smiles);
  return object;
}

/** A typed native label, with the same literal-atom semantics and warnings as the canvas. */
function buildGroup(label: string): MoleculeObject {
  const reading = nativeAtomLabelReading(label, { bonded: false, typed: true });
  if (!["group", "spelled", "formula"].includes(reading.kind)) {
    throw new Error(`Unknown standalone group label "${label}". Use an abbreviation or condensed formula such as CH3, Me, Ph, Boc, OTs or OMe; placeholders and bare element symbols are not groups.`);
  }
  const atoms = [{ id: "atom_001", element: label, x: 0, y: 0, formalCharge: 0, labelLiteral: true }];
  return normalizeNativeMoleculeGeometry({
    id: "group", type: "molecule", x: 0, y: 0, width: 0, height: 0, rotation: 0,
    transform: { ...defaultNativeMoleculeTransform },
    style: { ...stylePresetToObjectStyle(ChemDraftSyntheticStylePreset), source: "chemdraft-native-drawing" },
    compatibility: { sourceFormat: "chemdraft-native", warnings: [], unknown: {} },
    structureFormat: "smiles", structure: nativeSingleBondGraphSmiles(atoms, []),
    chemistry: nativeSingleBondGraphMetadata(atoms, []), atoms, bonds: [], superatoms: [], rGroups: []
  });
}

/** Validate the entire batch immutably before invoking the transaction. */
export async function applyAssistantWrite(context: AssistantToolContext, built: AssistantWrite) {
  const document = requireDocument(context);
  built.checkPreconditions?.(document);
  if (built.patch.op !== "batch" || built.patch.patches.length === 0 || built.patch.patches.length > 256) {
    throw new Error("An assistant write must contain 1..256 operations in one flat batch.");
  }
  const validated = applyPatch(document, built.patch, { now: context.now() });
  // Validate the complete write before chemistry or host effects, including references which
  // change page-level state. Only insertions earlier in this batch can extend its scope.
  const scope = assistantScope(context);
  for (const op of built.patch.patches) {
    if (op.op === "addObject" || op.op === "addAnnotation") {
      scope.add(op.op === "addObject" ? op.object.id : op.annotation.id);
      continue;
    }
    const ids = op.op === "setCrossingOverride" ? op.crossing.bonds.map(ref => ref.objectId) :
      op.op === "clearCrossingOverride" ? op.bonds.map(ref => ref.objectId) :
      op.op === "setObjectOrder" ? [unselectedObjectOrderChange(
        document.pages.find(page => page.id === op.pageId)!, op.objectIds, scope
      )].filter((id): id is string => id !== undefined) : "objectId" in op ? [op.objectId] : [];
    for (const id of ids) if (!scope.has(id)) throw new Error(`${id} was not selected when you sent the request`);
  }
  for (const [id, smiles] of built.expectedSmiles ?? []) {
    const { object } = findObject(validated, id);
    if (object.type !== "molecule") throw new Error(`Expected molecule ${id}.`);
    await assertCanonical(context, object, smiles);
  }
  let declined: string[] = [];
  let declineReason = PAGE_GROWTH_DECLINED;
  let patch = built.patch;
  let summary = built.summary;
  if (built.pageGrowth) {
    context.signal?.throwIfAborted();
    const accepted = await context.confirmPageGrowth(built.pageGrowth, context.signal);
    context.signal?.throwIfAborted();
    if (accepted !== true) {
      if (accepted !== false) declineReason = accepted.reason;
      declined = built.pageGrowth.items.map(item => item.label);
      const ids = new Set(built.pageGrowth.items.flatMap(item => item.objectIds));
      patch = { op: "batch", patches: patch.patches.filter(op => {
        if (op.op === "addObject") return !ids.has(op.object.id);
        if (op.op === "setObjectOrder") return !op.objectIds.some(id => ids.has(id));
        if (op.op === "setCrossingOverride") return !op.crossing.bonds.some(ref => ids.has(ref.objectId));
        if (op.op === "clearCrossingOverride") return !op.bonds.some(ref => ids.has(ref.objectId));
        return !("objectId" in op) || !ids.has(op.objectId);
      }) };
      summary = `Applied ${patch.patches.length} fitting operations; ${declineReason}: ${declined.join(", ")}.`;
    }
  }
  // The pinned tab may close or a user may edit while chemistry is awaited. Never apply a stale plan.
  const latest = requireDocument(context);
  built.checkPreconditions?.(latest);
  if (latest !== document && !assistantDocumentContentUnchanged(document, latest)) {
    throw new Error("The document changed while the assistant prepared this write; read it again and retry.");
  }
  const result = patch.patches.length ? await context.write(patch, context.signal, built.checkPreconditions, built.expectedSmiles) : { objectIds: [] };
  const inserted = patch.patches.filter(patch => patch.op === "addObject" || patch.op === "addAnnotation");
  if (inserted.length) {
    const insertedIds = new Set(inserted.map(patch => patch.op === "addObject" ? patch.object.id : patch.annotation.id));
    // The host may rebase ids. Its returned ids are authoritative; update-only calls never widen scope.
    recordAssistantInsertions(context, result.objectIds.filter(id => insertedIds.has(id) || !document.pages.some(page => page.objects.some(object => object.id === id))));
  }
  return { ...result, summary, warnings: built.warnings,
    ...(declined.length ? { declined, reason: declineReason } : {}) };
}

/** Translate coordinates, preserving all chemistry. Anchored chemistry is refused separately. */
export function translateObject<T extends DocumentObject>(object: T, dx: number, dy: number): T {
  const point = <P extends { x: number; y: number }>(p: P): P => ({ ...p, x: p.x + dx, y: p.y + dy });
  const anchor = (a: Anchor): Anchor => a.kind === "point" && a.point ? { ...a, point: point(a.point) } : a;
  let translated: DocumentObject = { ...object, x: object.x + dx, y: object.y + dy };
  switch (object.type) {
    case "molecule": translated = { ...translated, atoms: object.atoms.map(point) } as MoleculeObject; break;
    case "reaction-arrow": translated = { ...object, x: translated.x, y: translated.y, start: anchor(object.start), end: anchor(object.end) }; break;
    case "mechanism-arrow": translated = { ...object, x: translated.x, y: translated.y,
      source: anchor(object.source), target: anchor(object.target), controlPoints: object.controlPoints.map(point) }; break;
    case "graphic": {
      const data = { ...object.data };
      for (const key of ["lineStart", "lineEnd", "pathControlPoint", "arcCenter"] as const) {
        if (data[key]) data[key] = point(data[key]!);
      }
      if (data.pathNodes) data.pathNodes = data.pathNodes.map(node => ({ ...node,
        point: point(node.point), ...(node.inControl ? { inControl: point(node.inControl) } : {}),
        ...(node.outControl ? { outControl: point(node.outControl) } : {})
      }));
      if (data.freehandPoints) data.freehandPoints = data.freehandPoints.map(point);
      delete data.cachedFreehandPathD; delete data.cachedFreehandPathRevision;
      translated = { ...object, x: translated.x, y: translated.y, data }; break;
    }
  }
  return translated as T;
}
function nativeTextStyle(style: ToolInput<"insert_text">["style"] = {}): Partial<NativeTextStyle> {
  const { bold, italic, ...rest } = style;
  return { ...rest, ...(bold === undefined ? {} : { fontWeight: bold ? 700 : 400 }),
    ...(italic === undefined ? {} : { fontStyle: italic ? "italic" : "normal" }) };
}
function freshObjects(document: ChemDraftDocument, objects: readonly DocumentObject[]) {
  return objects.map(object => {
    const id = nextObjectId(document, object.type === "molecule" ? "mol_assistant" : "assistant", RESERVED_PLUGIN_OBJECT_IDS);
    RESERVED_PLUGIN_OBJECT_IDS.add(id);
    return { ...object, id };
  });
}
function assistantText(document: ChemDraftDocument, text: string, style: Partial<NativeTextStyle> = {}) {
  const object = createNativeTextObject(document, { x: 0, y: 0 }, text, style);
  // Wrap captions at the content width, never at the outer paper edge. Only text boxes reflow;
  // molecule geometry and the document's bond length are untouched.
  const maxWidth = pageContentRect(document.pages[0]!).width;
  const size = nativeTextObjectSizeForText(text, object.style, { maxWidth });
  // Text measurement rounds to hundredths; a fractional paper width must remain the ceiling.
  return { ...object, ...size, width: Math.min(size.width, maxWidth) };
}
function placement(context: AssistantToolContext, objects: readonly DocumentObject[], pageId?: string,
  relative?: { objectId: string; side: RelativeSide }, exclude: readonly string[] = [], to?: FigureTarget) {
  const document = requireDocument(context);
  if (to) {
    if (relative) throw new Error("Use either to or relativeTo, not both.");
    const target = findObject(document, to.relativeTo);
    if (exclude.includes(to.relativeTo)) throw new Error("A move cannot be relative to an object being moved.");
    if (pageId && target.page.id !== pageId) throw new Error("The relative object must be on the same page.");
    const placed = figureTransforms(objects, target.object, to)
      .map(({ object, dx, dy, rotation }) => translateObject({ ...object, rotation }, dx, dy));
    return { page: target.page, objects: placed, plan: anchoredPagePlacements(target.page, [unionRects(placed.map(objectRect))]) };
  }
  const page = pageId ? document.pages.find(page => page.id === pageId)! : document.pages[0]!;
  const bounds = unionRects(objects.map(objectRect));
  const preferred = relative ? relativeRect(bounds, objectRect(findObject(document, relative.objectId).object), relative.side) : undefined;
  const placed = choosePagePlacements({ page, sizes: [bounds], occupied: page.objects.filter(object => !exclude.includes(object.id)).map(objectRect),
    viewport: context.getViewportRect?.(context.tabId), preferred, ...(relative ? { gap: RELATIVE_GAP } : {}) });
  return { page, plan: placed,
    objects: objects.map(object => translateObject(object, placed.rects[0]!.x - bounds.x, placed.rects[0]!.y - bounds.y)) };
}
function insertWrite(pageId: string, objects: DocumentObject[], summary: string, warnings: string[], expectedSmiles?: ReadonlyMap<string, string>): AssistantWrite {
  return { patch: { op: "batch", patches: objects.map(object => ({ op: "addObject", pageId, object })) },
    summary, warnings, ...(expectedSmiles ? { expectedSmiles } : {}) };
}

type FigureOptions = Pick<ToolInput<"insert_structures">, "to" | "zOrder" | "crossings">;
/** The same flat batch contains geometry, ordering and per-bond depth. Rendering resolves all
 * intersections; this layer only translates the requested figure semantics into native patches. */
function finishFigureWrite(context: AssistantToolContext, before: ChemDraftDocument, built: AssistantWrite,
  input: FigureOptions, pageId: string, objectIds: string[]): AssistantWrite {
  if (!input.to && !input.zOrder && !input.crossings) return built;
  const previous = built.checkPreconditions;
  built.checkPreconditions = latest => {
    previous?.(latest);
    if (!assistantDocumentContentUnchanged(before, latest)) {
      throw new Error("The document changed while the assistant prepared this write; read it again and retry.");
    }
  };
  built.checkPreconditions(requireDocument(context));
  if (built.patch.op !== "batch") throw new Error("Figure writes require a batch.");
  const planned = applyPatch(before, built.patch, { now: context.now() });
  const page = planned.pages.find(p => p.id === pageId)!;
  if (input.zOrder) {
    const moving = page.objects.filter(o => objectIds.includes(o.id)).map(o => o.id);
    const remaining = page.objects.filter(o => !objectIds.includes(o.id)).map(o => o.id);
    let index = input.zOrder === "front" ? remaining.length : 0;
    if (typeof input.zOrder === "object") {
      const above = "above" in input.zOrder;
      const id = "above" in input.zOrder ? input.zOrder.above : input.zOrder.below;
      index = remaining.indexOf(id);
      if (index < 0) throw new Error("The zOrder reference must be another object on the same page.");
      if (above) index++;
    }
    remaining.splice(index, 0, ...moving);
    built.patch.patches.push({ op: "setObjectOrder", pageId, objectIds: remaining });
  }
  if (input.crossings) {
    if (input.crossings === "auto" && !input.to) throw new Error("Auto crossings require to.relativeTo and an anchor.");
    const crossings = input.crossings === "auto"
      ? planFigureInterlockCrossings(page, objectIds, input.to!.relativeTo,
        typeof input.to!.anchor === "object" ? input.to!.anchor.ringKey : undefined)
      : input.crossings.map(({ over, under }) => ({ bonds: [over, under] as [typeof over, typeof under], front: over }));
    if (input.crossings !== "auto") {
      const resolved = planPageSvgRender(page).crossings;
      for (const crossing of crossings) if (!resolved.some(c => crossing.bonds.every(ref =>
        c.bonds.some(b => b.objectId === ref.objectId && b.bondId === ref.bondId)))) {
        throw new Error("The requested bonds do not cross after placement; adjust the placement or bond references.");
      }
    }
    built.patch.patches.push(...crossings.map(crossing => ({ op: "setCrossingOverride" as const, pageId, crossing })));
  }
  return built;
}

/** Hold both fitting and non-fitting insertions until the single host confirmation settles. */
function insertionPlan(document: ChemDraftDocument, write: AssistantWrite, plan: PagePlacements,
  pageId: string, cells: DocumentObject[][], labels: (string | string[])[], description: string): AssistantWrite {
  return { ...write,
    checkPreconditions: plan.requiredSize ? latest => {
      write.checkPreconditions?.(latest);
      if (!assistantDocumentContentUnchanged(document, latest)) {
        throw new Error("The document changed while the assistant prepared this write; read it again and retry.");
      }
    } : write.checkPreconditions,
    ...(plan.requiredSize ? { pageGrowth: { pageId, ...plan.requiredSize, description, itemCount: plan.nonFitting.length,
      items: plan.nonFitting.flatMap(index => [labels[index]!].flat().map(label => ({
        objectIds: cells[index]!.map(object => object.id), label
      }))) } } : {}) };
}

export async function buildInsertStructures(context: AssistantToolContext, raw: unknown): Promise<AssistantWrite> {
  const input = toolSchemas.insert_structures.parse(raw);
  const document = requireDocument(context);
  const page = input.to ? findObject(document, input.to.relativeTo).page : document.pages[0]!;
  const textDocument = { ...document, pages: [page] };
  const sourceMolecules: MoleculeObject[] = [];
  for (const item of input.items) {
    if (item.kind === "molecule") sourceMolecules.push(await buildMolecule(context, item.smiles));
    if (item.kind === "group") sourceMolecules.push(buildGroup(item.label));
  }
  const columns = input.arrangement === "row" ? input.items.length : Math.ceil(Math.sqrt(input.items.length));
  let moleculeIndex = 0;
  const cells = input.items.map(item => {
    if (item.kind === "text") return freshObjects(document, [assistantText(textDocument, item.text, nativeTextStyle(item.style))]);
    const molecule = sourceMolecules[moleculeIndex++]!;
    const bounds = objectRect(molecule);
    const cell: DocumentObject[] = [translateObject(molecule, -bounds.x, -bounds.y)];
    if (item.kind === "molecule" && item.label) {
      const label = assistantText(textDocument, item.label);
      cell.push({ ...label, x: (bounds.width - label.width) / 2, y: bounds.height + 8 });
    }
    return freshObjects(document, cell);
  });
  const arranged = arrangeCells(context, cells, page.id, columns);
  const placed = input.to ? placement(context, arranged.objects, page.id, undefined, [], input.to) : arranged;
  const expected = new Map(input.items.flatMap((item, index) => item.kind === "molecule"
    ? [[cells[index]![0]!.id, item.smiles] as const] : []));
  const labels = input.items.map((item, index) => item.kind === "text" ? item.text.slice(0, 80) : item.label ?? cells[index]![0]!.id);
  const needsRoom = placed.plan.nonFitting.map(index => input.items[index]!);
  const first = needsRoom[0];
  const description = needsRoom.length === 1
    ? first!.kind !== "text" ? first!.label ?? "This molecule" : "This text"
    : needsRoom.length <= 3 && needsRoom.every(item => item.kind !== "text" && item.label)
      ? needsRoom.map(item => item.kind !== "text" ? item.label : "").join(", ")
      : `These ${needsRoom.length} structures`;
  return finishFigureWrite(context, document, insertionPlan(document, insertWrite(placed.page.id, placed.objects,
    `Inserted ${sourceMolecules.length} molecules and ${placed.objects.length - sourceMolecules.length} text objects`,
    sourceMolecules.flatMap(molecule => molecule.chemistry?.warnings?.map(warning => warning.message) ?? []), expected),
  placed.plan, placed.page.id, input.to ? [placed.objects] : cells, input.to ? [labels] : labels, input.to ? "This figure" : description),
  input, placed.page.id, placed.objects.map(object => object.id));
}
function arrangeCells(context: AssistantToolContext, cells: DocumentObject[][], pageId: string, columns: number, exclude: readonly string[] = []) {
  const page = requireDocument(context).pages.find(page => page.id === pageId)!;
  const bounds = cells.map(cell => unionRects(cell.map(objectRect)));
  const placed = choosePagePlacements({ page, sizes: bounds, columns,
    occupied: page.objects.filter(object => !exclude.includes(object.id)).map(objectRect),
    viewport: context.getViewportRect?.(context.tabId) });
  return { page, plan: placed, objects: cells.flatMap((cell, index) => cell.map(object => translateObject(object,
    placed.rects[index]!.x - bounds[index]!.x, placed.rects[index]!.y - bounds[index]!.y))) };
}

/** Retain nearby centred captions when the caller includes both objects in an arrangement. */
function arrangementCells(objects: DocumentObject[]): DocumentObject[][] {
  const cells: DocumentObject[][] = objects.filter(object => object.type !== "text").map(object => [object]);
  for (const text of objects.filter(object => object.type === "text")) {
    const label = objectRect(text);
    const owner = cells.find(cell => {
      if (cell[0]!.type !== "molecule") return false;
      const molecule = objectRect(cell[0]!);
      const gap = label.y - molecule.y - molecule.height;
      return gap >= -1e-6 && gap <= 12 && Math.abs(label.x + label.width / 2 - molecule.x - molecule.width / 2) < 1;
    });
    if (owner) owner.push(text);
    else cells.push([text]);
  }
  return cells;
}
export async function buildInsertReaction(context: AssistantToolContext, raw: unknown): Promise<AssistantWrite> {
  const input = toolSchemas.insert_reaction.parse(raw);
  const document = requireDocument(context);
  if ([...(input.reagents ?? []), ...(input.conditions ?? [])].join("; ").length > 2000) {
    throw new Error("Combined reaction labels exceed the 2000 character text limit.");
  }
  const molecules: MoleculeObject[] = [];
  for (const smiles of [...input.reactants, ...input.products]) molecules.push(await buildMolecule(context, smiles));
  const components = molecules.map(molecule => { const rect = objectRect(molecule);
    return { molecule, bounds: { minX: rect.x, minY: rect.y, maxX: rect.x + rect.width, maxY: rect.y + rect.height } };
  });
  const scheme = layoutReactionScheme({ reactants: components.slice(0, input.reactants.length), products: components.slice(input.reactants.length),
    arrowKind: input.arrowKind === "retrosynthetic" ? "retrosynthesis" : input.arrowKind,
    conditionText: [...input.reagents ?? [], ...input.conditions ?? []].join("; "),
    anchor: { x: ASSISTANT_MARGIN, y: 200 }, gutter: ASSISTANT_GAP, bondLength: smilesPasteBondLengthPx, pagePadding: ASSISTANT_MARGIN });
  if (scheme.condition) {
    // The shared arrow length budgets a 240px wrapping label. Keep its native text box at
    // that same size even when the full reaction page is much wider.
    const size = nativeTextObjectSizeForText(scheme.condition.text, { fontSizePx: 14, textAlign: "center" });
    scheme.condition.width = size.width;
    scheme.condition.height = size.height;
    scheme.condition.x = (scheme.arrow.start.point!.x + scheme.arrow.end.point!.x - size.width) / 2;
    scheme.condition.y = scheme.arrow.start.point!.y - size.height - ASSISTANT_GAP / 2;
  }
  const fresh = freshObjects(document, scheme.document.pages[0]!.objects);
  const placed = placement(context, fresh, undefined, undefined, [], input.to);
  // Retrosynthesis swaps visual sides; retain each molecule's actual source identity.
  const smiles = input.arrowKind === "retrosynthetic" ? [...input.products, ...input.reactants] : [...input.reactants, ...input.products];
  const expected = new Map(placed.objects.filter(object => object.type === "molecule").map((object, index) => [object.id, smiles[index]!]));
  return finishFigureWrite(context, document, insertionPlan(document, insertWrite(placed.page.id, placed.objects, `Inserted a reaction with ${molecules.length} molecules`, [], expected),
    placed.plan, placed.page.id, [fresh], [fresh.map(object => object.id)], "This reaction"),
    input, placed.page.id, placed.objects.map(object => object.id));
}
export function buildInsertText(context: AssistantToolContext, raw: unknown): AssistantWrite {
  const input = toolSchemas.insert_text.parse(raw);
  const document = requireDocument(context);
  const pageId = input.relativeTo ? findObject(document, input.relativeTo.objectId).page.id :
    input.to ? findObject(document, input.to.relativeTo).page.id : undefined;
  const textDocument = pageId ? { ...document, pages: [document.pages.find(page => page.id === pageId)!] } : document;
  const object = freshObjects(document, [assistantText(textDocument, input.text, nativeTextStyle(input.style))]);
  const placed = placement(context, object, pageId, input.relativeTo, [], input.to);
  return finishFigureWrite(context, document, insertionPlan(document, insertWrite(placed.page.id, placed.objects, "Inserted text", []),
    placed.plan, placed.page.id, [object], [input.text.slice(0, 80)], "This text"),
    input, placed.page.id, placed.objects.map(object => object.id));
}
export async function buildEditStructure(context: AssistantToolContext, raw: unknown): Promise<AssistantWrite> {
  const input = toolSchemas.edit_structure.parse(raw);
  const document = requireDocument(context);
  const { object: old, page } = findObject(document, input.objectId);
  if (old.type !== "molecule") throw new Error(`${old.id} is not a molecule.`);
  const checkPreconditions = captureWritePreconditions(document, [old.id], "edit");
  let object = (freshObjects(document, [await buildMolecule(context, input.smiles)])[0]!) as MoleculeObject;
  const warnings: string[] = [];
  if (input.keepPosition) {
    object = translateObject(object, old.x + old.width / 2 - object.x - object.width / 2,
      old.y + old.height / 2 - object.y - object.height / 2);
  } else {
    const placed = placement(context, [object], page.id, undefined, [old.id]);
    if (placed.plan.requiredSize) throw new Error("The replacement does not fit on this page; enlarge it with Page Setup first.");
    object = placed.objects[0] as MoleculeObject;
  }
  return { patch: { op: "batch", patches: [{ op: "removeObject", objectId: old.id }, { op: "addObject", pageId: page.id, object }] },
    summary: `Replaced structure ${old.id}`, warnings, expectedSmiles: new Map([[object.id, input.smiles]]), checkPreconditions };
}

export function buildStyleObjects(context: AssistantToolContext, input: ToolInput<"style_objects">): AssistantWrite {
  const document = requireDocument(context);
  const checkPreconditions = captureWritePreconditions(document, input.objectIds);
  if (input.style.bondDisplay !== undefined) {
    throw new Error("Bond display is stored on bonds and can encode stereochemistry; style_objects can change only object style. Use edit_structure for a chemical edit.");
  }
  const patches: DocumentPatch[] = [...new Set(input.objectIds)].map(objectId => {
    const { object } = findObject(document, objectId);
    const { ringStyles, bondDisplay: _bondDisplay, ...requested } = input.style;
    const style: Record<string, unknown> = { ...object.style, ...requested };
    if (object.type === "molecule") {
      if (requested.color !== undefined) { style.bondColor = requested.color; style.atomLabelColor = requested.color; }
      if (requested.strokeWidth !== undefined) style.bondStrokeWidthPx = requested.strokeWidth;
      if (requested.fontSizePx !== undefined) style.atomLabelFontSizePx = requested.fontSizePx;
    }
    if (ringStyles !== undefined) {
      if (object.type !== "molecule") throw new Error(`Ring styles require a molecule: ${objectId}.`);
      const validRings = new Set(nativeMoleculeRings(object).map(ring => ring.ringKey));
      const invalid = ringStyles.find(ring => !validRings.has(ring.ringKey));
      if (invalid) throw new Error(`Ring ${invalid.ringKey} does not exist in ${objectId}.`);
      const previous = object.style.ringStyles;
      style.ringStyles = { ...(previous && typeof previous === "object" && !Array.isArray(previous) ? previous : {}),
        ...Object.fromEntries(ringStyles.map(({ ringKey, ...ringStyle }) => [ringKey, ringStyle])) };
    }
    DocumentObjectSchema.parse({ ...object, style });
    return { op: "updateObject", objectId, changes: { style } };
  });
  return { patch: { op: "batch", patches }, summary: `Restyled ${patches.length} objects`, warnings: [], checkPreconditions };
}
export function buildMoveObjects(context: AssistantToolContext, input: ToolInput<"move_objects">): AssistantWrite {
  const document = requireDocument(context);
  const checkPreconditions = captureWritePreconditions(document, input.objectIds, "move",
    "relativeTo" in input.to ? [input.to.relativeTo] : []);
  const entries = [...new Set(input.objectIds)].map(id => findObject(document, id));
  if (entries.some(entry => entry.page.id !== entries[0]!.page.id)) throw new Error("Move objects must be on one page.");
  for (const { object } of entries) {
    // Moving an independently anchored mark can alter the molecule's charge during reconciliation.
    if (object.type === "electron-mark" || object.type === "group" || object.type === "reaction") {
      throw new Error(`Cannot safely move ${object.type} ${object.id} independently; its linked geometry must be moved with the canvas tools.`);
    }
    if (object.type === "mechanism-arrow" && (object.source.kind !== "point" || object.target.kind !== "point")) {
      throw new Error(`Cannot move atom-anchored mechanism arrow ${object.id} independently.`);
    }
    if (object.type === "graphic" && object.data.pathD && !object.data.pathNodes && !object.data.lineStart && !object.data.arcCenter && !object.data.freehandPoints) {
      throw new Error(`Cannot safely move legacy path ${object.id} without editable path geometry.`);
    }
  }
  const originals = entries.map(entry => entry.object);
  const relative = "side" in input.to ? { objectId: input.to.relativeTo, side: input.to.side } : undefined;
  if (relative && input.objectIds.includes(relative.objectId)) throw new Error("A move cannot be relative to an object being moved.");
  if (relative && findObject(document, relative.objectId).page.id !== entries[0]!.page.id) throw new Error("The relative object must be on the same page.");
  const cells = arrangementCells(originals);
  const figureTo = "anchor" in input.to ? input.to : undefined;
  const by = "by" in input.to ? input.to.by : undefined;
  if (by && by.dx === 0 && by.dy === 0) throw new Error("Offset move (0, 0) is a no-op; provide a non-zero dx or dy in document points.");
  if (by && Math.abs(by.dx) < 0.01 && Math.abs(by.dy) < 0.01) {
    throw new Error("Offset move is a no-op at document coordinate precision; provide at least 0.01 pt in dx or dy.");
  }
  const offsetObjects = by ? originals.map(object => translateObject(object, by.dx, by.dy)) : undefined;
  if (offsetObjects) {
    const content = pageContentRect(entries[0]!.page);
    const outside = offsetObjects.find(object => {
      const rect = objectRect(object);
      return rect.x < content.x - 1e-6 || rect.y < content.y - 1e-6 ||
        rect.x + rect.width > content.x + content.width + 1e-6 || rect.y + rect.height > content.y + content.height + 1e-6;
    });
    if (outside) throw new Error(`Moving by (${by!.dx}, ${by!.dy}) would put ${outside.id} off the page; nothing moved.`);
  }
  const placed = offsetObjects
    ? { page: entries[0]!.page, objects: offsetObjects,
      plan: anchoredPagePlacements(entries[0]!.page, [unionRects(offsetObjects.map(objectRect))]) }
    : "arrange" in input.to
    ? arrangeCells(context, cells, entries[0]!.page.id, input.to.arrange === "row" ? cells.length : Math.ceil(Math.sqrt(cells.length)), input.objectIds)
    : placement(context, originals, entries[0]!.page.id, relative, input.objectIds, figureTo);
  const patches: DocumentPatch[] = placed.objects.map(object => {
    const original = findObject(document, object.id).object;
    const changes: Partial<DocumentObject> = {};
    for (const key of Object.keys(object) as (keyof DocumentObject)[]) {
      if (JSON.stringify(object[key]) !== JSON.stringify(original[key])) Object.assign(changes, { [key]: object[key] });
    }
    return { op: "updateObject", objectId: object.id, changes };
  });
  if (placed.plan.requiredSize && !figureTo) throw new Error("The arrangement does not fit on this page; enlarge it with Page Setup first.");
  return finishFigureWrite(context, document, insertionPlan(document, { patch: { op: "batch", patches },
    summary: `Moved ${patches.length} objects`, warnings: [], checkPreconditions },
    placed.plan, placed.page.id, [placed.objects], [input.objectIds], "This figure"),
    { ...input, to: figureTo }, placed.page.id, input.objectIds);
}

/** All AnchorSchema fields in chem-core, including molecule attachment metadata. */
function objectAnchors(object: DocumentObject): readonly Anchor[] {
  switch (object.type) {
    case "electron-mark": return [object.anchor];
    case "mechanism-arrow": return [object.source, object.target];
    case "reaction-arrow": return [object.start, object.end];
    case "superatom": return object.metadata.attachmentPoints;
    case "r-group-label": return object.display.attachmentPoints;
    case "molecule": return [...object.superatoms, ...object.rGroups].flatMap(item => item.attachmentPoints);
    default: return [];
  }
}

/** Refuse rather than leave mechanism annotations or attachment points referencing removed geometry. */
export function refuseAnchoredObjects(document: ChemDraftDocument, objectId: string, action: string): void {
  for (const page of document.pages) for (const candidate of page.objects) {
    if (objectAnchors(candidate).some(anchor => anchor.kind !== "point" && anchor.objectId === objectId)) {
      const linked = candidate.type === "electron-mark" ? `electron marks (${candidate.id})` : `${candidate.type} ${candidate.id}`;
      throw new Error(`Cannot safely ${action} ${objectId} without its anchored ${linked}; use the canvas tools to edit the linked mechanism.`);
    }
  }
}
