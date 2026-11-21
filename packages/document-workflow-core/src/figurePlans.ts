import {
  NativeStylePresets, nativeTextStyleFromObjectStyle,
  type ArrowObject, type ChemDraftDocument, type CompatibilityWarning, type DocumentObject,
  type DocumentPage, type MoleculeObject, type NativeTextStyle, type ReactionObject, type TextObject
} from "@chemdraft/chem-core";
import {
  arrowAttachmentOffset, measureObjectDepiction, moleculeInkBounds, objectFrameBoundsForPageFit,
  planObjectArrangement, reactionConditionsFrame, unionLayoutBounds, type ArrangementOptions
} from "@chemdraft/layout-engine";
import { documentDrawingDefaults } from "./drawingDefaults";
import { findNativeStylePreset, planPageStyleUpdates } from "./nativeStylePresets";
import { createLayoutText, layoutReactionScheme } from "./reactionScheme";
import type { PagePoint } from "./shared";

export function listFigureStylePresets(document: ChemDraftDocument) {
  const { drawing: { visualEffects, ...drawing }, textStyle } = documentDrawingDefaults(document);
  return {
    presets: NativeStylePresets.map(({ id, name, drawing }) => ({
      id, name, bondLengthPx: drawing.bondLengthPx, bondStrokeWidthPx: drawing.bondStrokeWidthPx,
      bondBoldWidthPx: drawing.bondBoldWidthPx, atomLabelFontFamily: drawing.atomLabelFontFamily,
      atomLabelFontSizePx: drawing.atomLabelFontSizePx, atomLabelFontWeight: drawing.atomLabelFontWeight
    })),
    defaults: {
      drawing: { ...drawing, ...(visualEffects ? { visualEffects: visualEffects.map(effect => ({ ...effect })) } : {}) },
      text: { ...nativeTextStyleFromObjectStyle(textStyle) }
    }
  };
}

export function planFigureStyle(
  page: DocumentPage, options: { objectIds: readonly string[]; presetId?: string; targetBondLength?: number }
) {
  const { objectIds, presetId, targetBondLength } = options;
  const targets = new Set(objectIds);
  const byId = new Map(page.objects.map(object => [object.id, object]));
  const preset = presetId === undefined ? undefined : findNativeStylePreset(presetId);
  if (targetBondLength !== undefined && (!Number.isFinite(targetBondLength) || targetBondLength <= 0)) {
    throw new Error("The target bond length must be finite and positive.");
  }
  const warnings: CompatibilityWarning[] = [];
  for (const id of targets) {
    const object = byId.get(id);
    if (!object) throw new Error(`Object "${id}" does not exist on page "${page.id}".`);
    if (object.type !== "group") continue;
    const children = new Set(object.childObjectIds);
    for (const childId of children) {
      const child = byId.get(childId);
      if (child?.type === "group") child.childObjectIds.forEach(id => children.add(id));
    }
    const omitted = [...children].filter(childId => !targets.has(childId));
    if (omitted.length) warnings.push({ code: "style_preset.missing_group_children", objectId: id,
      message: `Group "${id}" requires child objects among the targets: ${omitted.join(", ")}.` });
  }
  const updates = warnings.length ? [] : planPageStyleUpdates(page, targets, preset, targetBondLength, warnings, true);
  const affectedObjectIds = updates.map(update => update.objectId);
  const movedMarkIds = updates.filter(update => {
    const object = byId.get(update.objectId)!;
    return object.type === "electron-mark" && (update.changes.x !== object.x || update.changes.y !== object.y);
  }).map(update => update.objectId);
  return { updates, affectedObjectIds, movedMarkIds, warnings: warnings.map(warning => warning.message) };
}

export function figureObjectBounds(page: DocumentPage, object: DocumentObject) {
  return measureObjectDepiction(page, object)?.bounds ?? objectFrameBoundsForPageFit(object);
}

export function planFigureArrangement(page: DocumentPage,
  items: readonly { id: string; objects: readonly DocumentObject[] }[],
  layout: "row" | "grid", options: ArrangementOptions
) {
  return planObjectArrangement(items.map(item => ({
    id: item.id,
    bounds: unionLayoutBounds(item.objects.map(object => figureObjectBounds(page, object)))!
  })), layout, options);
}

export interface FigureReactionStep {
  reactants: readonly MoleculeObject[];
  products: readonly MoleculeObject[];
  agentIds?: readonly string[];
  arrowKind: ArrowObject["arrowKind"];
  above?: readonly string[];
  below?: readonly string[];
}

interface ReactionFigureOptions {
  /** Only new SMILES components may use the native scheme's condensed label graphs. */
  newMoleculeIds?: ReadonlySet<string>;
  anchor: PagePoint;
  bondLength: number;
  textStyle: Partial<NativeTextStyle>;
  compoundNumbers: ReadonlyMap<string, string>;
  nextId: (kind: string) => string;
  rows?: { maxWidth: number; gap: number; breakBefore?: readonly number[] };
}

/** Lay out editable components in drawing order, with one position per component ID. */
export function planFigureReaction(steps: readonly FigureReactionStep[], options: ReactionFigureOptions) {
  const { rows, anchor } = options;
  const placements = new Map<string, MoleculeObject>();
  const objects: DocumentObject[] = [];
  const warnings: string[] = [];
  let line = anchor.y;
  let rowRight = anchor.x;
  let rowBottom = anchor.y;
  let lastComponent: string | undefined;
  for (const [index, step] of steps.entries()) {
    const visual = step.arrowKind === "retrosynthesis"
      ? [...step.products, ...step.reactants] : [...step.reactants, ...step.products];
    if (new Set(visual.map(molecule => molecule.id)).size !== visual.length) {
      throw new Error(`Step ${index + 1} repeats a component. Use each component once per step.`);
    }
    const shared = new Set(visual.filter(component => placements.has(component.id)).map(component => component.id));
    const continued = shared.size === 1 && shared.has(visual[0]!.id) && visual[0]!.id === lastComponent;
    let newRow = rows && (rows.breakBefore?.includes(index) || shared.size > 0 && !continued);
    let stepAnchor = { x: index === 0 ? anchor.x : rowRight + (rows?.gap ?? options.bondLength), y: line };
    const render = (omit: ReadonlySet<string>, at: PagePoint) => {
      const components = (items: readonly MoleculeObject[]) => items.filter(item => !omit.has(item.id))
        .map(molecule => ({ molecule, preserveLabels: !options.newMoleculeIds?.has(molecule.id) }));
      const visible = visual.filter(item => !omit.has(item.id));
      const scheme = layoutReactionScheme({
        reactants: components(step.reactants), products: components(step.products), arrowKind: step.arrowKind,
        above: step.above, below: step.below, anchor: at, textStyle: options.textStyle,
        bondLength: options.bondLength, gutter: options.bondLength, pagePadding: 0,
        preserveAnchor: !!rows, drawingReference: visual[0]
      });
      const positioned = scheme.molecules.map((molecule, i) => ({ ...molecule, id: visible[i]!.id }));
      const numbers = positioned.flatMap(molecule => {
        const text = options.compoundNumbers.get(molecule.id);
        if (!text || placements.has(molecule.id)) return [];
        const ink = moleculeInkBounds(molecule);
        const label = createLayoutText("", { x: 0, y: ink.y + ink.height + 8 }, text,
          { ...options.textStyle, textAlign: "center" });
        return [{ ...label, x: ink.x + (ink.width - label.width) / 2 }];
      });
      const page = scheme.document.pages[0]!;
      const decorations = [scheme.arrow, ...scheme.pluses, ...[scheme.above, scheme.below].filter(text => text !== undefined),
        ...numbers];
      const bounds = unionLayoutBounds([...positioned, ...decorations].map(object => figureObjectBounds(page, object)))!;
      return { scheme, positioned, numbers, page, bounds };
    };
    if (continued && !newRow) {
      stepAnchor = { x: moleculeInkBounds(placements.get(lastComponent!)!).x, y: line };
    }
    let plan = newRow ? undefined : render(new Set(), stepAnchor);
    if (rows && index > 0 && plan && plan.bounds.x + plan.bounds.width > anchor.x + rows.maxWidth) newRow = true;
    if (newRow && rows) {
      // The native step retains the remote component reference at a row break. Its drawing
      // remains on the earlier row, so this row starts with the next unplaced component or arrow.
      if (shared.size) warnings.push(`Step ${index + 1} reuses ${[...shared].join(", ")} on an earlier row.`);
      line = rowBottom + rows.gap;
      stepAnchor = { x: anchor.x, y: line };
      plan = render(shared, stepAnchor);
      // `line` is the scheme centreline. Shift the entire step down to clear the previous row.
      plan = render(shared, { ...stepAnchor, y: line + stepAnchor.y - plan.bounds.y });
      rowRight = anchor.x;
    }
    const { scheme, positioned, numbers, page, bounds } = plan!;
    line = scheme.arrow.start.point!.y;
    if (rows && bounds.x + bounds.width > anchor.x + rows.maxWidth) {
      warnings.push(`Step ${index + 1} exceeds the maximum row width.`);
    }
    for (const molecule of positioned) if (!placements.has(molecule.id)) placements.set(molecule.id, molecule);
    lastComponent = positioned.at(-1)?.id === visual.at(-1)?.id ? visual.at(-1)?.id : undefined;
    rowRight = Math.max(rowRight, bounds.x + bounds.width);
    rowBottom = Math.max(rowBottom, bounds.y + bounds.height);
    const arrow = { ...scheme.arrow, id: options.nextId("arrow") };
    const frame = reactionConditionsFrame(page, arrow)!;
    const condition = (text: TextObject, side: "above" | "below"): TextObject => ({
      ...text, id: options.nextId("condition"),
      arrowAttachment: { kind: "conditions", parentObjectId: arrow.id, side, frame,
        offset: arrowAttachmentOffset(frame, { x: text.x + text.width / 2, y: text.y + text.height / 2 }),
        placement: "manual" }
    });
    const conditions = [scheme.above && condition(scheme.above, "above"), scheme.below && condition(scheme.below, "below")]
      .filter(text => text !== undefined);
    const pluses = scheme.pluses.map(plus => ({ ...plus, id: options.nextId("plus") }));
    const components: ReactionObject["components"] = [
      ...step.reactants.map(({ id }) => ({ role: "reactant" as const, objectId: id })),
      ...step.products.map(({ id }) => ({ role: "product" as const, objectId: id })),
      ...(step.agentIds ?? []).map(objectId => ({ role: "agent" as const, objectId }))
    ];
    objects.push({ ...arrow, labels: conditions.map(text => text.id) },
      ...pluses, ...conditions, ...numbers.map(text => ({ ...text, id: options.nextId("number") })), {
        ...bounds, id: options.nextId("reaction"), type: "reaction", style: {}, rotation: 0, components,
        arrowObjectIds: [arrow.id], conditionsTextObjectIds: conditions.map(text => text.id),
        plusObjectIds: pluses.map(plus => plus.id), mappingState: "unknown"
      });
    warnings.push(...scheme.warnings);
  }
  return { placements, objects, warnings };
}
