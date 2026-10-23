import {
  applyPatch, cloneDocument, DocumentObjectSchema, type Anchor, type ChemDraftDocument,
  type DocumentObject, type DocumentPatch, type MoleculeObject, type NativeTextStyle
} from "@chemdraft/chem-core";
import {
  createNativeTextObject, layoutGrid, layoutReactionScheme, nextObjectId,
  nativeTextObjectSizeForText, smilesPasteBondLengthPx, stereoPerceptionMolfile
} from "@chemdraft/document-workflow-core";
import { nativeMoleculeRings } from "@chemdraft/layout-engine";
import { assistantDocumentContentUnchanged } from "./historyPort";
import { RESERVED_PLUGIN_OBJECT_IDS } from "../plugins/reservedObjectIds";
import {
  assistantScope, recordAssistantInsertions, requireDocument,
  type AssistantToolContext
} from "./AssistantToolContext";
import {
  ASSISTANT_GAP, ASSISTANT_MARGIN, choosePlacement, objectRect, relativeRect, unionRects,
  type RelativeSide
} from "./placement";
import { toolSchemas, type ToolInput } from "./tools/schemas";

export interface AssistantWrite {
  patch: DocumentPatch; summary: string; warnings: string[];
  /** Input SMILES keyed by the actual new molecule id, checked again after patch normalization. */
  expectedSmiles?: ReadonlyMap<string, string>;
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

/** Validate the entire batch on an isolated document before invoking the transaction. */
export async function applyAssistantWrite(context: AssistantToolContext, built: AssistantWrite) {
  const document = requireDocument(context);
  if (built.patch.op !== "batch" || built.patch.patches.length === 0 || built.patch.patches.length > 256) {
    throw new Error("An assistant write must contain 1..256 operations in one flat batch.");
  }
  const validated = applyPatch(cloneDocument(document), built.patch, { now: context.now() });
  for (const [id, smiles] of built.expectedSmiles ?? []) {
    const { object } = findObject(validated, id);
    if (object.type !== "molecule") throw new Error(`Expected molecule ${id}.`);
    await assertCanonical(context, object, smiles);
  }
  // The pinned tab may close or a user may edit while chemistry is awaited. Never apply a stale plan.
  const latest = requireDocument(context);
  if (latest !== document && !assistantDocumentContentUnchanged(document, latest)) {
    throw new Error("The document changed while the assistant prepared this write; read it again and retry.");
  }
  const result = await context.write(built.patch);
  const inserted = built.patch.patches.filter(patch => patch.op === "addObject" || patch.op === "addAnnotation");
  if (inserted.length) {
    const insertedIds = new Set(inserted.map(patch => patch.op === "addObject" ? patch.object.id : patch.annotation.id));
    // The host may rebase ids. Its returned ids are authoritative; update-only calls never widen scope.
    recordAssistantInsertions(context, result.objectIds.filter(id => insertedIds.has(id) || !document.pages.some(page => page.objects.some(object => object.id === id))));
  }
  return { ...result, summary: built.summary, warnings: built.warnings };
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
function placement(context: AssistantToolContext, objects: readonly DocumentObject[], pageId?: string,
  relative?: { objectId: string; side: RelativeSide }, exclude: readonly string[] = []) {
  const document = requireDocument(context);
  const page = pageId ? document.pages.find(page => page.id === pageId)! : document.pages[0]!;
  const bounds = unionRects(objects.map(objectRect));
  const preferred = relative ? relativeRect(bounds, objectRect(findObject(document, relative.objectId).object), relative.side) : undefined;
  const placed = choosePlacement({ page, size: bounds, occupied: page.objects.filter(object => !exclude.includes(object.id)).map(objectRect),
    viewport: context.getViewportRect?.(context.tabId), preferred });
  return { page, warnings: placed.warnings,
    objects: objects.map(object => translateObject(object, placed.rect.x - bounds.x, placed.rect.y - bounds.y)) };
}
function insertWrite(pageId: string, objects: DocumentObject[], summary: string, warnings: string[], expectedSmiles?: ReadonlyMap<string, string>): AssistantWrite {
  return { patch: { op: "batch", patches: objects.map(object => ({ op: "addObject", pageId, object })) },
    summary, warnings, ...(expectedSmiles ? { expectedSmiles } : {}) };
}

export async function buildInsertStructures(context: AssistantToolContext, raw: unknown): Promise<AssistantWrite> {
  const input = toolSchemas.insert_structures.parse(raw);
  const document = requireDocument(context);
  const page = document.pages[0]!;
  const sourceMolecules: MoleculeObject[] = [];
  for (const item of input.items) if (item.kind === "molecule") sourceMolecules.push(await buildMolecule(context, item.smiles));
  const columns = input.arrangement === "row" ? input.items.length : Math.ceil(Math.sqrt(input.items.length));
  let objects: DocumentObject[];
  if (sourceMolecules.length === input.items.length) {
    const labels = input.items.map(item => item.kind === "molecule" && item.label
      ? createNativeTextObject(document, { x: 0, y: 0 }, item.label) : undefined);
    const grid = layoutGrid({ entries: sourceMolecules.map((molecule, index) => {
      const bounds = objectRect(molecule);
      const label = labels[index];
      const full = label ? unionRects([bounds, {
        x: bounds.x + (bounds.width - label.width) / 2, y: bounds.y + bounds.height + 8,
        width: label.width, height: label.height
      }]) : bounds;
      // Include the label in the shared grid cell, so long labels cannot overlap neighbours.
      return { molecule, bounds: { minX: full.x, minY: full.y, maxX: full.x + full.width, maxY: full.y + full.height }, label: null };
    }), columns, gutter: ASSISTANT_GAP, anchor: { x: ASSISTANT_MARGIN, y: ASSISTANT_MARGIN }, pageWidth: page.width });
    objects = grid.molecules.flatMap((molecule, index): DocumentObject[] => {
      const label = labels[index];
      const bounds = objectRect(molecule);
      return label ? [molecule, { ...label, x: bounds.x + (bounds.width - label.width) / 2,
        y: bounds.y + bounds.height + 8 }] : [molecule];
    });
  } else {
    let moleculeIndex = 0;
    const cells = input.items.map(item => {
      if (item.kind === "text") return [createNativeTextObject(document, { x: 0, y: 0 }, item.text, nativeTextStyle(item.style))];
      const molecule = sourceMolecules[moleculeIndex++]!;
      const bounds = objectRect(molecule);
      const cell: DocumentObject[] = [translateObject(molecule, -bounds.x, -bounds.y)];
      if (item.label) {
        const label = createNativeTextObject(document, { x: 0, y: 0 }, item.label);
        cell.push({ ...label, x: (bounds.width - label.width) / 2, y: bounds.height + 8 });
      }
      return cell;
    });
    objects = arrangeCells(cells, columns);
  }
  const fresh = freshObjects(document, objects);
  const placed = placement(context, fresh);
  const inputs = input.items.filter(item => item.kind === "molecule");
  const expected = new Map(placed.objects.filter(object => object.type === "molecule").map((object, index) => [object.id, inputs[index]!.smiles]));
  return insertWrite(placed.page.id, placed.objects, `Inserted ${sourceMolecules.length} molecules and ${objects.length - sourceMolecules.length} text objects`, placed.warnings, expected);
}
function arrangeCells(cells: DocumentObject[][], columns: number): DocumentObject[] {
  const bounds = cells.map(cell => unionRects(cell.map(objectRect)));
  const width = Math.max(...bounds.map(rect => rect.width)) + ASSISTANT_GAP;
  const height = Math.max(...bounds.map(rect => rect.height)) + ASSISTANT_GAP;
  return cells.flatMap((cell, index) => cell.map(object => translateObject(object,
    (index % columns) * width - bounds[index]!.x, Math.floor(index / columns) * height - bounds[index]!.y)));
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
  const placed = placement(context, fresh);
  // Retrosynthesis swaps visual sides; retain each molecule's actual source identity.
  const smiles = input.arrowKind === "retrosynthetic" ? [...input.products, ...input.reactants] : [...input.reactants, ...input.products];
  const expected = new Map(placed.objects.filter(object => object.type === "molecule").map((object, index) => [object.id, smiles[index]!]));
  return insertWrite(placed.page.id, placed.objects, `Inserted a reaction with ${molecules.length} molecules`, placed.warnings, expected);
}
export function buildInsertText(context: AssistantToolContext, raw: unknown): AssistantWrite {
  const input = toolSchemas.insert_text.parse(raw);
  const document = requireDocument(context);
  const pageId = input.relativeTo ? findObject(document, input.relativeTo.objectId).page.id : undefined;
  const object = freshObjects(document, [createNativeTextObject(document, { x: 0, y: 0 }, input.text, nativeTextStyle(input.style))]);
  const placed = placement(context, object, pageId, input.relativeTo);
  return insertWrite(placed.page.id, placed.objects, "Inserted text", placed.warnings);
}
export async function buildEditStructure(context: AssistantToolContext, raw: unknown): Promise<AssistantWrite> {
  const input = toolSchemas.edit_structure.parse(raw);
  const document = requireDocument(context);
  const { object: old, page } = findObject(document, input.objectId);
  if (old.type !== "molecule") throw new Error(`${old.id} is not a molecule.`);
  refuseAnchoredElectronMarks(document, old.id, "edit");
  let object = (freshObjects(document, [await buildMolecule(context, input.smiles)])[0]!) as MoleculeObject;
  let warnings: string[] = [];
  if (input.keepPosition) {
    object = translateObject(object, old.x + old.width / 2 - object.x - object.width / 2,
      old.y + old.height / 2 - object.y - object.height / 2);
  } else {
    const placed = placement(context, [object], page.id, undefined, [old.id]);
    object = placed.objects[0] as MoleculeObject; warnings = placed.warnings;
  }
  return { patch: { op: "batch", patches: [{ op: "removeObject", objectId: old.id }, { op: "addObject", pageId: page.id, object }] },
    summary: `Replaced structure ${old.id}`, warnings, expectedSmiles: new Map([[object.id, input.smiles]]) };
}

export function buildStyleObjects(context: AssistantToolContext, input: ToolInput<"style_objects">): AssistantWrite {
  const document = requireDocument(context);
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
  return { patch: { op: "batch", patches }, summary: `Restyled ${patches.length} objects`, warnings: [] };
}
export function buildMoveObjects(context: AssistantToolContext, input: ToolInput<"move_objects">): AssistantWrite {
  const document = requireDocument(context);
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
    refuseAnchoredElectronMarks(document, object.id, "move");
    if (object.type === "graphic" && object.data.pathD && !object.data.pathNodes && !object.data.lineStart && !object.data.arcCenter && !object.data.freehandPoints) {
      throw new Error(`Cannot safely move legacy path ${object.id} without editable path geometry.`);
    }
  }
  const originals = entries.map(entry => entry.object);
  const arranged = "arrange" in input.to ? arrangeCells(originals.map(object => [object]), input.to.arrange === "row" ? originals.length : Math.ceil(Math.sqrt(originals.length))) : originals;
  const relative = "relativeTo" in input.to ? { objectId: input.to.relativeTo, side: input.to.side } : undefined;
  if (relative && input.objectIds.includes(relative.objectId)) throw new Error("A move cannot be relative to an object being moved.");
  if (relative && findObject(document, relative.objectId).page.id !== entries[0]!.page.id) throw new Error("The relative object must be on the same page.");
  const placed = placement(context, arranged, entries[0]!.page.id, relative, input.objectIds);
  const patches: DocumentPatch[] = placed.objects.map(object => {
    const original = findObject(document, object.id).object;
    const changes: Partial<DocumentObject> = {};
    for (const key of Object.keys(object) as (keyof DocumentObject)[]) {
      if (JSON.stringify(object[key]) !== JSON.stringify(original[key])) Object.assign(changes, { [key]: object[key] });
    }
    return { op: "updateObject", objectId: object.id, changes };
  });
  return { patch: { op: "batch", patches }, summary: `Moved ${patches.length} objects`, warnings: placed.warnings };
}

/** Refuse rather than leave chemistry-bearing mechanism marks pointing at stale atoms. */
export function refuseAnchoredElectronMarks(document: ChemDraftDocument, objectId: string, action: string): void {
  if (document.pages.some(page => page.objects.some(candidate =>
    candidate.type === "electron-mark" && candidate.anchor.objectId === objectId))) {
    throw new Error(`Cannot safely ${action} ${objectId} without its anchored electron marks; use the canvas tools to edit the linked mechanism.`);
  }
}
