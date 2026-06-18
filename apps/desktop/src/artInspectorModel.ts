import { planNativeArtVisual } from "@chemdraft/art-engine";
import type { ChemDraftDocument, GraphicObject, GraphicPaint } from "@chemdraft/chem-core";

export type ArtInspectorPaintTarget = "fill" | "stroke";
export type ArtInspectorPaintType = GraphicPaint["kind"] | "gloss";
export type ArtInspectorLineCap = "butt" | "round" | "square";
export type ArtInspectorLineJoin = "miter" | "round" | "bevel";

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

export interface ArtInspectorModel {
  selectedCount: number;
  selectedGraphicIds: string[];
  selectedGraphicKinds: GraphicObject["graphicKind"][];
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
    strokeWidth: ArtInspectorMixedValue<number>;
    dash: ArtInspectorMixedValue<string>;
    lineEnds: ArtInspectorMixedValue<ArtInspectorLineCap>;
    corners: ArtInspectorMixedValue<ArtInspectorLineJoin>;
  };
  skippedObjectIdsByControl: ArtInspectorSkippedObjectIdsByControl;
}

export interface CreateArtInspectorModelOptions {
  document: ChemDraftDocument;
  selectedGraphicObjects: readonly GraphicObject[];
  requestedPaintTarget?: ArtInspectorPaintTarget;
}

type ArtInspectorCapabilityKey = "fill" | "stroke" | "dash" | "lineEnds" | "corners";

export function createArtInspectorModel({
  document,
  selectedGraphicObjects,
  requestedPaintTarget = "fill"
}: CreateArtInspectorModelOptions): ArtInspectorModel {
  void document;

  const graphics = [...selectedGraphicObjects];
  const selectedCount = graphics.length;
  const planned = graphics.map((object) => ({
    object,
    plan: planNativeArtVisual(object, { coordinateSpace: "local" })
  }));
  const supportsFill = planned.map(({ plan }) => plan.capabilities.supportsFill);
  const supportsStroke = planned.map(({ plan }) => plan.capabilities.supportsStroke);
  const supportsDash = planned.map(({ plan }) => plan.capabilities.supportsDash);
  const supportsLineEnds = planned.map(({ plan }) => plan.capabilities.supportsLineCap);
  const supportsCorners = planned.map(({ plan }) => plan.capabilities.supportsLineJoin);
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

  return {
    selectedCount,
    selectedGraphicIds: graphics.map((object) => object.id),
    selectedGraphicKinds: uniqueGraphicKinds(graphics),
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
    values: {
      fillPaintType: uniformSupportedValue(planned, supportsFill, ({ object }) => graphicFillToolbarPaintType(object)),
      strokePaintType: uniformSupportedValue(planned, supportsStroke, ({ object }) => graphicStrokeToolbarPaintType(object)),
      fillColor: uniformSupportedValue(planned, supportsFill, ({ object }) => graphicFillToolbarColor(object)),
      strokeColor: uniformSupportedValue(planned, supportsStroke, ({ object }) => graphicStrokeToolbarColor(object)),
      objectOpacity: uniformSupportedValue(planned, planned.map(() => true), ({ object }) => metadataNumberValue(object.style.opacity, 1)),
      fillOpacity: uniformSupportedValue(planned, supportsFill, ({ object }) => metadataNumberValue(object.style.fillOpacity, 1)),
      strokeOpacity: uniformSupportedValue(planned, supportsStroke, ({ object }) => metadataNumberValue(object.style.strokeOpacity, 1)),
      strokeWidth: uniformSupportedValue(planned, supportsStroke, ({ object }) => metadataNumberValue(object.style.strokeWidth, 1.5)),
      dash: uniformSupportedValue(planned, supportsDash, ({ object }) => metadataStringValue(object.style.strokeDasharray) ?? "solid"),
      lineEnds: uniformSupportedValue(planned, supportsLineEnds, ({ plan }) => plan.stroke.lineCap),
      corners: uniformSupportedValue(planned, supportsCorners, ({ plan }) => plan.stroke.lineJoin)
    },
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

function countSupported(values: readonly boolean[]): number {
  return values.filter(Boolean).length;
}

function uniqueGraphicKinds(objects: readonly GraphicObject[]): GraphicObject["graphicKind"][] {
  return [...new Set(objects.map((object) => object.graphicKind))];
}

function uniformSupportedValue<T>(
  planned: readonly { object: GraphicObject; plan: ReturnType<typeof planNativeArtVisual> }[],
  supported: readonly boolean[],
  read: (entry: { object: GraphicObject; plan: ReturnType<typeof planNativeArtVisual> }) => T | null | undefined
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
  planned: readonly { object: GraphicObject; plan: ReturnType<typeof planNativeArtVisual> }[]
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
  planned: readonly { object: GraphicObject; plan: ReturnType<typeof planNativeArtVisual> }[],
  control: ArtInspectorCapabilityKey
): ArtInspectorSkippedObject[] {
  return planned.flatMap<ArtInspectorSkippedObject>(({ object, plan }) => {
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
