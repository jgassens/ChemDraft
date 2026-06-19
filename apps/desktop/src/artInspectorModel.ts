import { planNativeArtVisual, visualEffectsForStyle } from "@chemdraft/art-engine";
import type { ChemDraftDocument, GraphicObject, GraphicPaint, MoleculeObject, VisualEffect } from "@chemdraft/chem-core";

export type ArtInspectorPaintTarget = "fill" | "stroke";
export type ArtInspectorPaintType = GraphicPaint["kind"] | "gloss";
export type ArtInspectorEffectValue = "none" | "shadow" | "glow" | "sketch" | "multiple";
export type ArtInspectorEffectKind = Exclude<ArtInspectorEffectValue, "none" | "multiple">;
export type ArtInspectorLineCap = "butt" | "round" | "square";
export type ArtInspectorLineJoin = "miter" | "round" | "bevel";
const MAX_ART_INSPECTOR_GRADIENT_STOPS = 8;

export type ArtInspectorSkipReason =
  | "open-stroke"
  | "closed-shape"
  | "no-corners"
  | "unsupported";

export interface ArtInspectorSkippedObject {
  objectId: string;
  reason: ArtInspectorSkipReason;
}

export interface ArtInspectorSkippedObjectIdsByControl {
  fill?: ArtInspectorSkippedObject[];
  lineEnds?: ArtInspectorSkippedObject[];
  corners?: ArtInspectorSkippedObject[];
}

export interface ArtInspectorMixedValue<T> {
  value: T | null;
  mixed: boolean;
}

export interface ArtInspectorGradientStop {
  offset: number;
  color: string;
  opacity: number;
}

export interface ArtInspectorGradientModel {
  paintType: Extract<GraphicPaint["kind"], "linear-gradient" | "radial-gradient"> | null;
  stops: ArtInspectorGradientStop[];
  mixed: boolean;
  editable: boolean;
  canAddStop: boolean;
  canDeleteStop: boolean;
}

export interface ArtInspectorEffectModel {
  kind: ArtInspectorEffectKind;
  presentCount: number;
  presentAll: boolean;
  color: ArtInspectorMixedValue<string>;
  opacity: ArtInspectorMixedValue<number>;
  size: ArtInspectorMixedValue<number>;
}

export interface ArtInspectorModel {
  selectedCount: number;
  selectedObjectIds: string[];
  selectedGraphicIds: string[];
  selectedGraphicKinds: GraphicObject["graphicKind"][];
  effectKinds: ArtInspectorEffectKind[];
  requestedPaintTarget: ArtInspectorPaintTarget;
  activePaintTarget: ArtInspectorPaintTarget;
  supportsFillAny: boolean;
  supportsFillAll: boolean;
  supportsStrokeAny: boolean;
  supportsStrokeAll: boolean;
  supportsDashAny: boolean;
  supportsDashAll: boolean;
  supportsLineEndsAny: boolean;
  supportsLineEndsAll: boolean;
  supportsCornersAny: boolean;
  supportsCornersAll: boolean;
  supportsFillOpacityAny: boolean;
  supportsFillOpacityAll: boolean;
  supportsStrokeOpacityAny: boolean;
  supportsStrokeOpacityAll: boolean;
  fillSupportedCount: number;
  strokeSupportedCount: number;
  dashSupportedCount: number;
  lineEndsSupportedCount: number;
  cornersSupportedCount: number;
  fillOpacitySupportedCount: number;
  strokeOpacitySupportedCount: number;
  values: {
    fillPaintType: ArtInspectorMixedValue<ArtInspectorPaintType>;
    strokePaintType: ArtInspectorMixedValue<ArtInspectorPaintType>;
    fillColor: ArtInspectorMixedValue<string>;
    strokeColor: ArtInspectorMixedValue<string>;
    objectOpacity: ArtInspectorMixedValue<number>;
    fillOpacity: ArtInspectorMixedValue<number>;
    strokeOpacity: ArtInspectorMixedValue<number>;
    effect: ArtInspectorMixedValue<ArtInspectorEffectValue>;
    strokeWidth: ArtInspectorMixedValue<number>;
    dash: ArtInspectorMixedValue<string>;
    lineEnds: ArtInspectorMixedValue<ArtInspectorLineCap>;
    corners: ArtInspectorMixedValue<ArtInspectorLineJoin>;
  };
  activeGradient: ArtInspectorGradientModel;
  effectControls: Record<ArtInspectorEffectKind, ArtInspectorEffectModel>;
  skippedObjectIdsByControl: ArtInspectorSkippedObjectIdsByControl;
}

export interface CreateArtInspectorModelOptions {
  document: ChemDraftDocument;
  selectedGraphicObjects: readonly GraphicObject[];
  selectedVisualObjects?: readonly ArtInspectorStyleObject[];
  requestedPaintTarget?: ArtInspectorPaintTarget;
}

type ArtInspectorCapabilityKey = "fill" | "stroke" | "dash" | "lineEnds" | "corners";
type ArtInspectorStyleObject = GraphicObject | MoleculeObject;
type ArtInspectorPlannedEntry =
  | { object: GraphicObject; plan: ReturnType<typeof planNativeArtVisual> }
  | { object: MoleculeObject; plan: undefined };

export function createArtInspectorModel({
  document,
  selectedGraphicObjects,
  selectedVisualObjects,
  requestedPaintTarget = "fill"
}: CreateArtInspectorModelOptions): ArtInspectorModel {
  void document;

  const styleObjects = selectedVisualObjects ? [...selectedVisualObjects] : [...selectedGraphicObjects];
  const graphics = styleObjects.filter((object): object is GraphicObject => object.type === "graphic");
  const selectedCount = styleObjects.length;
  const planned = styleObjects.map((object): ArtInspectorPlannedEntry => {
    if (object.type === "graphic") {
      return { object, plan: planNativeArtVisual(object, { coordinateSpace: "local" }) };
    }
    return { object, plan: undefined };
  });
  const supportsFill = planned.map((entry) => entry.plan?.capabilities.supportsFill === true);
  const supportsStroke = planned.map((entry) => entry.plan?.capabilities.supportsStroke === true);
  const supportsDash = planned.map((entry) => entry.plan?.capabilities.supportsDash === true);
  const supportsLineEnds = planned.map((entry) => entry.plan?.capabilities.supportsLineCap === true);
  const supportsCorners = planned.map((entry) => entry.plan?.capabilities.supportsLineJoin === true);
  const fillSupportedCount = countSupported(supportsFill);
  const strokeSupportedCount = countSupported(supportsStroke);
  const dashSupportedCount = countSupported(supportsDash);
  const lineEndsSupportedCount = countSupported(supportsLineEnds);
  const cornersSupportedCount = countSupported(supportsCorners);
  const activePaintTarget = requestedPaintTarget === "fill" && fillSupportedCount === 0 && strokeSupportedCount > 0
    ? "stroke"
    : requestedPaintTarget === "stroke" && strokeSupportedCount === 0 && fillSupportedCount > 0
      ? "fill"
      : requestedPaintTarget;

  const values = {
    fillPaintType: uniformSupportedValue(planned, supportsFill, ({ object }) => object.type === "graphic" ? graphicFillToolbarPaintType(object) : undefined),
    strokePaintType: uniformSupportedValue(planned, supportsStroke, ({ object }) => object.type === "graphic" ? graphicStrokeToolbarPaintType(object) : undefined),
    fillColor: uniformSupportedValue(planned, supportsFill, ({ object }) => object.type === "graphic" ? graphicFillToolbarColor(object) : undefined),
    strokeColor: uniformSupportedValue(planned, supportsStroke, ({ object }) => object.type === "graphic" ? graphicStrokeToolbarColor(object) : undefined),
    objectOpacity: uniformSupportedValue(planned, planned.map(() => true), ({ object }) => metadataNumberValue(object.style.opacity, 1)),
    fillOpacity: uniformSupportedValue(planned, supportsFill, ({ object }) => object.type === "graphic" ? metadataNumberValue(object.style.fillOpacity, 1) : undefined),
    strokeOpacity: uniformSupportedValue(planned, supportsStroke, ({ object }) => object.type === "graphic" ? metadataNumberValue(object.style.strokeOpacity, 1) : undefined),
    effect: uniformSupportedValue(planned, planned.map(() => true), ({ object }) => visualToolbarEffectValue(object)),
    strokeWidth: uniformSupportedValue(planned, supportsStroke, ({ object }) => object.type === "graphic" ? metadataNumberValue(object.style.strokeWidth, 1.5) : undefined),
    dash: uniformSupportedValue(planned, supportsDash, ({ object }) => object.type === "graphic" ? metadataStringValue(object.style.strokeDasharray) ?? "solid" : undefined),
    lineEnds: uniformSupportedValue(planned, supportsLineEnds, ({ plan }) => plan?.stroke.lineCap),
    corners: uniformSupportedValue(planned, supportsCorners, ({ plan }) => plan?.stroke.lineJoin)
  };
  const effectControls = {
    shadow: effectModelForKind(planned, "shadow", selectedCount),
    glow: effectModelForKind(planned, "glow", selectedCount),
    sketch: effectModelForKind(planned, "sketch", selectedCount)
  } satisfies Record<ArtInspectorEffectKind, ArtInspectorEffectModel>;

  return {
    selectedCount,
    selectedObjectIds: styleObjects.map((object) => object.id),
    selectedGraphicIds: graphics.map((object) => object.id),
    selectedGraphicKinds: uniqueGraphicKinds(graphics),
    effectKinds: (["shadow", "glow", "sketch"] as const).filter((kind) => effectControls[kind].presentCount > 0),
    requestedPaintTarget,
    activePaintTarget,
    supportsFillAny: fillSupportedCount > 0,
    supportsFillAll: selectedCount > 0 && fillSupportedCount === selectedCount,
    supportsStrokeAny: strokeSupportedCount > 0,
    supportsStrokeAll: selectedCount > 0 && strokeSupportedCount === selectedCount,
    supportsDashAny: dashSupportedCount > 0,
    supportsDashAll: selectedCount > 0 && dashSupportedCount === selectedCount,
    supportsLineEndsAny: lineEndsSupportedCount > 0,
    supportsLineEndsAll: selectedCount > 0 && lineEndsSupportedCount === selectedCount,
    supportsCornersAny: cornersSupportedCount > 0,
    supportsCornersAll: selectedCount > 0 && cornersSupportedCount === selectedCount,
    supportsFillOpacityAny: fillSupportedCount > 0,
    supportsFillOpacityAll: selectedCount > 0 && fillSupportedCount === selectedCount,
    supportsStrokeOpacityAny: strokeSupportedCount > 0,
    supportsStrokeOpacityAll: selectedCount > 0 && strokeSupportedCount === selectedCount,
    fillSupportedCount,
    strokeSupportedCount,
    dashSupportedCount,
    lineEndsSupportedCount,
    cornersSupportedCount,
    fillOpacitySupportedCount: fillSupportedCount,
    strokeOpacitySupportedCount: strokeSupportedCount,
    values,
    activeGradient: gradientModelForTarget(
      planned,
      activePaintTarget === "fill" ? supportsFill : supportsStroke,
      activePaintTarget
    ),
    effectControls,
    skippedObjectIdsByControl: skippedObjectIdsByControl(planned)
  };
}

export function selectedGraphicObjectsForArtInspector(document: ChemDraftDocument): GraphicObject[] {
  const selectedIds = new Set(document.selection.objectIds);
  if (selectedIds.size === 0) {
    return [];
  }

  return document.pages.flatMap((page) =>
    page.objects.filter((object): object is GraphicObject =>
      object.type === "graphic" && selectedIds.has(object.id)
    )
  );
}

export function selectedVisualObjectsForArtInspector(
  document: ChemDraftDocument,
  options: { excludeMoleculeObjectId?: string } = {}
): ArtInspectorStyleObject[] {
  const selectedIds = new Set(document.selection.objectIds);
  if (selectedIds.size === 0) {
    return [];
  }

  return document.pages.flatMap((page) =>
    page.objects.filter((object): object is ArtInspectorStyleObject =>
      (object.type === "graphic" || object.type === "molecule") &&
      selectedIds.has(object.id) &&
      object.id !== options.excludeMoleculeObjectId
    )
  );
}

function countSupported(values: readonly boolean[]): number {
  return values.filter(Boolean).length;
}

function uniqueGraphicKinds(objects: readonly GraphicObject[]): GraphicObject["graphicKind"][] {
  return [...new Set(objects.map((object) => object.graphicKind))];
}

function uniformSupportedValue<TEntry, T>(
  planned: readonly TEntry[],
  supported: readonly boolean[],
  read: (entry: TEntry) => T | null | undefined
): ArtInspectorMixedValue<T> {
  const values = planned
    .filter((_, index) => supported[index])
    .map((entry) => read(entry))
    .filter((value): value is T => value !== null && value !== undefined);
  if (values.length === 0) {
    return { value: null, mixed: false };
  }

  const [first, ...rest] = values;
  return {
    value: rest.every((value) => Object.is(value, first)) ? first : null,
    mixed: rest.some((value) => !Object.is(value, first))
  };
}

function skippedObjectIdsByControl(
  planned: readonly ArtInspectorPlannedEntry[]
): ArtInspectorSkippedObjectIdsByControl {
  const fill = skippedForControl(planned, "fill");
  const lineEnds = skippedForControl(planned, "lineEnds");
  const corners = skippedForControl(planned, "corners");
  return {
    ...(fill.length > 0 ? { fill } : {}),
    ...(lineEnds.length > 0 ? { lineEnds } : {}),
    ...(corners.length > 0 ? { corners } : {})
  };
}

function skippedForControl(
  planned: readonly ArtInspectorPlannedEntry[],
  control: ArtInspectorCapabilityKey
): ArtInspectorSkippedObject[] {
  return planned.flatMap<ArtInspectorSkippedObject>(({ object, plan }) => {
    if (!plan) {
      return [];
    }
    if (control === "fill" && !plan.capabilities.supportsFill) {
      return [{
        objectId: object.id,
        reason: plan.capabilities.isOpenStroke ? "open-stroke" : "unsupported"
      }];
    }
    if (control === "lineEnds" && !plan.capabilities.supportsLineCap) {
      return [{
        objectId: object.id,
        reason: plan.capabilities.isClosedShape ? "closed-shape" : "unsupported"
      }];
    }
    if (control === "corners" && !plan.capabilities.supportsLineJoin) {
      return [{
        objectId: object.id,
        reason: plan.capabilities.hasCorners ? "unsupported" : "no-corners"
      }];
    }
    return [];
  });
}

function graphicFillToolbarColor(object: GraphicObject): string | null {
  if (object.style.fillPaint?.kind === "solid") {
    return normalizeToolbarHexColor(object.style.fillPaint.color);
  }
  if (object.style.fillPaint?.kind === "linear-gradient" || object.style.fillPaint?.kind === "radial-gradient") {
    return representativeGradientStopColor(object.style.fillPaint);
  }
  const fillColor = metadataStringValue(object.style.fillColor);
  return fillColor?.toLowerCase() === "none" ? null : normalizeToolbarHexColor(fillColor);
}

function graphicStrokeToolbarColor(object: GraphicObject): string | null {
  if (object.style.strokePaint?.kind === "solid") {
    return normalizeToolbarHexColor(object.style.strokePaint.color);
  }
  if (object.style.strokePaint?.kind === "linear-gradient" || object.style.strokePaint?.kind === "radial-gradient") {
    return representativeGradientStopColor(object.style.strokePaint);
  }
  return normalizeToolbarHexColor(metadataColor(object.style.strokeColor, object.style.color, "#111111"));
}

function representativeGradientStopColor(paint: Extract<GraphicPaint, { kind: "linear-gradient" | "radial-gradient" }>): string | null {
  return [...paint.stops]
    .reverse()
    .map((stop) => normalizeToolbarHexColor(stop.color))
    .find((color) => color !== null && color !== "#ffffff") ??
    normalizeToolbarHexColor(paint.stops[0]?.color);
}

function gradientModelForTarget(
  planned: readonly ArtInspectorPlannedEntry[],
  supported: readonly boolean[],
  target: ArtInspectorPaintTarget
): ArtInspectorGradientModel {
  const paints = planned
    .filter((entry, index): entry is Extract<ArtInspectorPlannedEntry, { object: GraphicObject }> =>
      entry.object.type === "graphic" && supported[index]
    )
    .map(({ object }) => target === "fill" ? object.style.fillPaint : object.style.strokePaint);
  if (paints.length === 0) {
    return { paintType: null, stops: [], mixed: false, editable: false, canAddStop: false, canDeleteStop: false };
  }

  const gradients = paints.filter(isGradientPaint);
  if (gradients.length !== paints.length) {
    return { paintType: null, stops: [], mixed: gradients.length > 0, editable: false, canAddStop: false, canDeleteStop: false };
  }

  const [first, ...rest] = gradients;
  if (!first) {
    return { paintType: null, stops: [], mixed: false, editable: false, canAddStop: false, canDeleteStop: false };
  }

  const firstStops = normalizedGradientStops(first);
  const canAddStop = gradients.every((paint) => paint.stops.length < MAX_ART_INSPECTOR_GRADIENT_STOPS);
  const canDeleteStop = gradients.every((paint) => paint.stops.length > 2);
  const uniform = rest.every((paint) =>
    paint.kind === first.kind &&
    gradientStopsEqual(normalizedGradientStops(paint), firstStops)
  );

  return {
    paintType: uniform ? first.kind : null,
    stops: uniform ? firstStops : [],
    mixed: !uniform,
    editable: true,
    canAddStop,
    canDeleteStop
  };
}

function isGradientPaint(paint: GraphicPaint | undefined): paint is Extract<GraphicPaint, { kind: "linear-gradient" | "radial-gradient" }> {
  return paint?.kind === "linear-gradient" || paint?.kind === "radial-gradient";
}

function normalizedGradientStops(
  paint: Extract<GraphicPaint, { kind: "linear-gradient" | "radial-gradient" }>
): ArtInspectorGradientStop[] {
  return [...paint.stops]
    .map((stop) => ({
      offset: clampToolbarUnit(stop.offset),
      color: normalizeToolbarHexColor(stop.color) ?? "#111111",
      opacity: clampToolbarUnit(stop.opacity ?? 1)
    }))
    .sort((left, right) => left.offset - right.offset);
}

function gradientStopsEqual(left: readonly ArtInspectorGradientStop[], right: readonly ArtInspectorGradientStop[]): boolean {
  return left.length === right.length &&
    left.every((stop, index) => {
      const other = right[index];
      return other !== undefined &&
        stop.offset === other.offset &&
        stop.color === other.color &&
        stop.opacity === other.opacity;
    });
}

function graphicFillToolbarPaintType(object: GraphicObject): ArtInspectorPaintType {
  if (object.style.fillMode === "gloss") {
    return "gloss";
  }
  if (object.style.fillPaint) {
    return object.style.fillPaint.kind;
  }
  return metadataStringValue(object.style.fillColor)?.toLowerCase() === "none" ? "none" : "solid";
}

function graphicStrokeToolbarPaintType(object: GraphicObject): ArtInspectorPaintType {
  if (object.style.strokePaint) {
    return object.style.strokePaint.kind;
  }
  return metadataStringValue(object.style.strokeColor)?.toLowerCase() === "none" ? "none" : "solid";
}

function visualToolbarEffectValue(object: ArtInspectorStyleObject): ArtInspectorEffectValue {
  const effectKinds = visualEffectsForToolbar(object).map((effect) => effect.kind);
  const uniqueEffectKinds = [...new Set(effectKinds)];
  if (uniqueEffectKinds.length === 0) {
    return "none";
  }
  return uniqueEffectKinds.length === 1 ? uniqueEffectKinds[0] : "multiple";
}

function effectModelForKind(
  planned: readonly ArtInspectorPlannedEntry[],
  kind: ArtInspectorEffectKind,
  selectedCount: number
): ArtInspectorEffectModel {
  const entries = planned.map(({ object }) => ({
    object,
    effect: visualEffectsForToolbar(object).find((candidate) => candidate.kind === kind)
  }));
  const presentCount = entries.filter((entry) => entry.effect).length;
  const supported = entries.map((entry) => entry.effect !== undefined);
  return {
    kind,
    presentCount,
    presentAll: selectedCount > 0 && presentCount === selectedCount,
    color: presentCount > 0
      ? uniformSupportedValue(entries, supported, ({ effect }) => effectColorForToolbar(kind, effect))
      : { value: defaultEffectColor(kind), mixed: false },
    opacity: presentCount > 0
      ? uniformSupportedValue(entries, supported, ({ effect }) => effectOpacityForToolbar(kind, effect))
      : { value: defaultEffectOpacity(kind), mixed: false },
    size: presentCount > 0
      ? uniformSupportedValue(entries, supported, ({ effect }) => effectSizeForToolbar(kind, effect))
      : { value: defaultEffectSize(kind), mixed: false }
  };
}

function visualEffectsForToolbar(object: ArtInspectorStyleObject): VisualEffect[] {
  return visualEffectsForStyle(object.style);
}

function effectColorForToolbar(
  kind: ArtInspectorEffectKind,
  effect: VisualEffect | undefined
): string {
  return normalizeToolbarHexColor(effect?.color) ??
    defaultEffectColor(kind);
}

function effectOpacityForToolbar(
  kind: ArtInspectorEffectKind,
  effect: VisualEffect | undefined
): number {
  return clampToolbarUnit(typeof effect?.opacity === "number" ? effect.opacity : defaultEffectOpacity(kind));
}

function effectSizeForToolbar(
  kind: ArtInspectorEffectKind,
  effect: VisualEffect | undefined
): number {
  if (kind === "shadow") {
    const offsetX = Math.abs(typeof effect?.offsetX === "number" ? effect.offsetX : 6);
    const offsetY = Math.abs(typeof effect?.offsetY === "number" ? effect.offsetY : 6);
    const blur = Math.max(0, typeof effect?.blurPx === "number" ? effect.blurPx : 3);
    return clampToolbarUnit(Math.max(offsetX / 24, offsetY / 24, blur / 12));
  }

  if (kind === "glow") {
    const blur = Math.max(0, typeof effect?.blurPx === "number" ? effect.blurPx : 7);
    const spread = Math.max(0, typeof effect?.spreadPx === "number" ? effect.spreadPx : 1.2);
    return clampToolbarUnit(Math.max(blur / 18, spread / 4));
  }

  const roughness = Math.max(0, typeof effect?.roughness === "number" ? effect.roughness : 1.25);
  const bowing = Math.max(0, typeof effect?.bowing === "number" ? effect.bowing : 0.8);
  const strokeWidth = Math.max(0, typeof effect?.strokeWidth === "number" ? effect.strokeWidth : 1.5);
  return clampToolbarUnit(Math.max(roughness / 3, bowing / 2, strokeWidth / 4));
}

function defaultEffectColor(kind: ArtInspectorEffectKind): string {
  if (kind === "shadow") {
    return "#52616b";
  }
  if (kind === "glow") {
    return "#fdd835";
  }
  return "#111111";
}

function defaultEffectOpacity(kind: ArtInspectorEffectKind): number {
  if (kind === "shadow") {
    return 0.28;
  }
  if (kind === "glow") {
    return 0.42;
  }
  return 1;
}

function defaultEffectSize(kind: ArtInspectorEffectKind): number {
  if (kind === "shadow") {
    return 0.25;
  }
  if (kind === "glow") {
    return 7 / 18;
  }
  return 1.25 / 3;
}

function metadataNumberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function metadataStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataColor(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return "#111111";
}

function normalizeToolbarHexColor(color: string | undefined): string | null {
  const normalized = color?.trim().replace(/^#/, "").toLowerCase();
  if (!normalized || normalized === "none") {
    return null;
  }
  if (/^[0-9a-f]{3}$/.test(normalized)) {
    return `#${normalized.split("").map((character) => `${character}${character}`).join("")}`;
  }
  return /^[0-9a-f]{6}$/.test(normalized) ? `#${normalized}` : null;
}

function clampToolbarUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(0, Math.min(1, value));
}
