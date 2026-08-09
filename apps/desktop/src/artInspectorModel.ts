import { graphicMarkerRenderedSizeFloorPx, graphicMarkerRenderedSizePx, planNativeArtVisual, visualEffectsForStyle } from "@chemdraft/art-engine";
import type { ChemDraftDocument, GraphicMarker, GraphicObject, GraphicPaint, MoleculeObject, VisualEffect } from "@chemdraft/chem-core";
import { graphicObjectHasShaftMark, graphicObjectSupportsMarkersWithPlan, nativeArrowToolIdForGraphic } from "./documentWorkflow";
import type { MoleculeInspectorRingsModel } from "./moleculeInspectorModel";

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
  markers?: ArtInspectorSkippedObject[];
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

export type ArtInspectorAppearanceTarget =
  | {
      kind: "objects";
      objectIds: string[];
      moleculeObjectIds: string[];
      hasMoleculeRingOverrides: boolean;
    }
  | {
      kind: "molecule-rings";
      rings: { objectId: string; ringKey: string }[];
    };

export interface ArtInspectorModel {
  selectedCount: number;
  selectedObjectIds: string[];
  selectedGraphicIds: string[];
  selectedGraphicKinds: GraphicObject["graphicKind"][];
  appearanceTarget: ArtInspectorAppearanceTarget;
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
  /** Marker-capable = an open-stroke path whose ends can carry arrowhead markers. */
  supportsMarkersAny: boolean;
  supportsMarkersAll: boolean;
  /** Shaft-marked = draws the no-reaction ✗ across its midpoint. */
  supportsShaftMarkAny: boolean;
  supportsShaftMarkAll: boolean;
  /** The largest rendered head size the selection's renderer will floor to, across every marker-
   *  capable object and both its ends. A head-size control must not offer sizes below this or the
   *  canvas silently overrides the choice; undefined when nothing in the selection has a head. */
  markerRenderedSizeFloorPx?: number;
  /** Arrow-family membership (drawn with one of the arrow tools), for the arrow style widget. */
  isArrowAny: boolean;
  isArrowAll: boolean;
  /** Distinct arrow tool ids in the selection, sorted. */
  arrowToolIds: string[];
  fillSupportedCount: number;
  strokeSupportedCount: number;
  dashSupportedCount: number;
  lineEndsSupportedCount: number;
  cornersSupportedCount: number;
  fillOpacitySupportedCount: number;
  strokeOpacitySupportedCount: number;
  markersSupportedCount: number;
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
    /** Absent marker keys read as "none" so a bare tail is a real value, not a mixed-null. */
    markerStartKind: ArtInspectorMixedValue<GraphicMarker["kind"]>;
    markerEndKind: ArtInspectorMixedValue<GraphicMarker["kind"]>;
    /** The head size as RENDERED: the stored `sizePx`, or the engine's 10px default, floored per
     *  marker kind by {@link markerRenderedSizeFloorPx}. Reporting the raw stored value meant an
     *  unset head read as a size nothing drew at, and it could also fall below the floor the widget
     *  clamps its choices to — so the control offered a value it could not round-trip. */
    markerSizePx: ArtInspectorMixedValue<number>;
    /** No-reaction ✗ size: an explicit px value, or "auto" when derived from stroke width. */
    shaftMarkSizePx: ArtInspectorMixedValue<number | "auto">;
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

type ArtInspectorCapabilityKey = "fill" | "stroke" | "dash" | "lineEnds" | "corners" | "markers";
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
  const moleculeObjectIds = styleObjects
    .filter((object): object is MoleculeObject => object.type === "molecule")
    .map((object) => object.id);
  const selectedCount = styleObjects.length;
  const planned = styleObjects.map((object): ArtInspectorPlannedEntry => {
    if (object.type === "graphic") {
      return { object, plan: planNativeArtVisual(object, { coordinateSpace: "local" }) };
    }
    return { object, plan: undefined };
  });
  const supportsFill = planned.map((entry) => entry.object.type === "molecule" || entry.plan?.capabilities.supportsFill === true);
  const supportsStroke = planned.map((entry) => entry.object.type === "molecule" || entry.plan?.capabilities.supportsStroke === true);
  const supportsDash = planned.map((entry) => entry.plan?.capabilities.supportsDash === true);
  const supportsLineEnds = planned.map((entry) => entry.plan?.capabilities.supportsLineCap === true);
  const supportsCorners = planned.map((entry) => entry.plan?.capabilities.supportsLineJoin === true);
  // From the plan computed above, not a second planNativeArtVisual call — see the note on
  // `graphicObjectSupportsMarkersWithPlan`. This model is rebuilt every pointermove frame.
  const supportsMarkers = planned.map(
    (entry) => entry.object.type === "graphic" && entry.plan !== undefined && graphicObjectSupportsMarkersWithPlan(entry.object, entry.plan)
  );
  const supportsShaftMark = planned.map((entry) => entry.object.type === "graphic" && graphicObjectHasShaftMark(entry.object));
  const arrowToolIdByEntry = planned.map((entry) => entry.object.type === "graphic" ? nativeArrowToolIdForGraphic(entry.object) : undefined);
  const arrowCount = arrowToolIdByEntry.filter((toolId) => toolId !== undefined).length;
  const fillSupportedCount = countSupported(supportsFill);
  const strokeSupportedCount = countSupported(supportsStroke);
  const dashSupportedCount = countSupported(supportsDash);
  const lineEndsSupportedCount = countSupported(supportsLineEnds);
  const cornersSupportedCount = countSupported(supportsCorners);
  const markersSupportedCount = countSupported(supportsMarkers);
  const shaftMarkSupportedCount = countSupported(supportsShaftMark);
  const activePaintTarget = requestedPaintTarget === "fill" && fillSupportedCount === 0 && strokeSupportedCount > 0
    ? "stroke"
    : requestedPaintTarget === "stroke" && strokeSupportedCount === 0 && fillSupportedCount > 0
      ? "fill"
      : requestedPaintTarget;

  const values = {
    fillPaintType: uniformSupportedValue(planned, supportsFill, ({ object }) => object.type === "graphic" ? graphicFillToolbarPaintType(object) : moleculeFillToolbarPaintType(object)),
    strokePaintType: uniformSupportedValue(planned, supportsStroke, ({ object }) => object.type === "graphic" ? graphicStrokeToolbarPaintType(object) : moleculeStrokeToolbarPaintType()),
    fillColor: uniformSupportedValue(planned, supportsFill, ({ object }) => object.type === "graphic" ? graphicFillToolbarColor(object) : moleculeFillToolbarColor(object)),
    strokeColor: uniformSupportedValue(planned, supportsStroke, ({ object }) => object.type === "graphic" ? graphicStrokeToolbarColor(object) : moleculeStrokeToolbarColor(object)),
    objectOpacity: uniformSupportedValue(planned, planned.map(() => true), ({ object }) => metadataNumberValue(object.style.opacity, 1)),
    fillOpacity: uniformSupportedValue(planned, supportsFill, ({ object }) => metadataNumberValue(object.style.fillOpacity, 1)),
    strokeOpacity: uniformSupportedValue(planned, supportsStroke, ({ object }) => metadataNumberValue(object.style.strokeOpacity, 1)),
    effect: uniformSupportedValue(planned, planned.map(() => true), ({ object }) => visualToolbarEffectValue(object)),
    strokeWidth: uniformSupportedValue(planned, supportsStroke, ({ object }) => object.type === "graphic" ? metadataNumberValue(object.style.strokeWidth, 1.5) : undefined),
    dash: uniformSupportedValue(planned, supportsDash, ({ object }) => object.type === "graphic" ? metadataStringValue(object.style.strokeDasharray) ?? "solid" : undefined),
    lineEnds: uniformSupportedValue(planned, supportsLineEnds, ({ plan }) => plan?.stroke.lineCap),
    corners: uniformSupportedValue(planned, supportsCorners, ({ plan }) => plan?.stroke.lineJoin),
    markerStartKind: uniformSupportedValue(planned, supportsMarkers, ({ object }) =>
      object.type === "graphic" ? object.data.markerStart?.kind ?? "none" : undefined),
    markerEndKind: uniformSupportedValue(planned, supportsMarkers, ({ object }) =>
      object.type === "graphic" ? object.data.markerEnd?.kind ?? "none" : undefined),
    markerSizePx: renderedMarkerSizeValue(planned, supportsMarkers),
    shaftMarkSizePx: uniformSupportedValue(planned, supportsShaftMark, ({ object }) =>
      object.type === "graphic"
        ? typeof object.data.shaftMarkSizePx === "number" && Number.isFinite(object.data.shaftMarkSizePx)
          ? object.data.shaftMarkSizePx
          : "auto"
        : undefined)
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
    appearanceTarget: {
      kind: "objects",
      objectIds: styleObjects.map((object) => object.id),
      moleculeObjectIds,
      hasMoleculeRingOverrides: styleObjects.some((object) => object.type === "molecule" && moleculeHasRingStyles(object))
    },
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
    supportsMarkersAny: markersSupportedCount > 0,
    supportsMarkersAll: selectedCount > 0 && markersSupportedCount === selectedCount,
    supportsShaftMarkAny: shaftMarkSupportedCount > 0,
    supportsShaftMarkAll: selectedCount > 0 && shaftMarkSupportedCount === selectedCount,
    markerRenderedSizeFloorPx: markerRenderedSizeFloorForSelection(planned, supportsMarkers),
    isArrowAny: arrowCount > 0,
    isArrowAll: selectedCount > 0 && arrowCount === selectedCount,
    arrowToolIds: [...new Set(arrowToolIdByEntry.flatMap((toolId) => (toolId === undefined ? [] : [toolId as string])))].sort(),
    fillSupportedCount,
    strokeSupportedCount,
    dashSupportedCount,
    lineEndsSupportedCount,
    cornersSupportedCount,
    fillOpacitySupportedCount: fillSupportedCount,
    strokeOpacitySupportedCount: strokeSupportedCount,
    markersSupportedCount,
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

export function createMoleculeRingArtInspectorModel(
  moleculeInspector: MoleculeInspectorRingsModel,
  requestedPaintTarget: ArtInspectorPaintTarget = "fill"
): ArtInspectorModel | undefined {
  const selectedCount = moleculeInspector.selectedCount;
  if (selectedCount === 0) {
    return undefined;
  }

  const selectedObjectIds = moleculeInspector.selectedRings.map((ring) => `${ring.objectId}:${ring.ringKey}`);
  return {
    selectedCount,
    selectedObjectIds,
    selectedGraphicIds: [],
    selectedGraphicKinds: [],
    appearanceTarget: {
      kind: "molecule-rings",
      rings: moleculeInspector.selectedRings.map((ring) => ({
        objectId: ring.objectId,
        ringKey: ring.ringKey
      }))
    },
    effectKinds: [...moleculeInspector.effectKinds],
    requestedPaintTarget,
    activePaintTarget: "fill",
    supportsFillAny: true,
    supportsFillAll: true,
    supportsStrokeAny: false,
    supportsStrokeAll: false,
    supportsDashAny: false,
    supportsDashAll: false,
    supportsLineEndsAny: false,
    supportsLineEndsAll: false,
    supportsCornersAny: false,
    supportsCornersAll: false,
    supportsFillOpacityAny: true,
    supportsFillOpacityAll: true,
    supportsStrokeOpacityAny: false,
    supportsStrokeOpacityAll: false,
    supportsMarkersAny: false,
    supportsMarkersAll: false,
    supportsShaftMarkAny: false,
    supportsShaftMarkAll: false,
    isArrowAny: false,
    isArrowAll: false,
    arrowToolIds: [],
    fillSupportedCount: selectedCount,
    strokeSupportedCount: 0,
    dashSupportedCount: 0,
    lineEndsSupportedCount: 0,
    cornersSupportedCount: 0,
    fillOpacitySupportedCount: selectedCount,
    strokeOpacitySupportedCount: 0,
    markersSupportedCount: 0,
    values: {
      fillPaintType: moleculeInspector.values.fillPaintType,
      strokePaintType: { value: null, mixed: false },
      fillColor: moleculeInspector.values.fillColor,
      strokeColor: { value: null, mixed: false },
      objectOpacity: { value: 1, mixed: false },
      fillOpacity: moleculeInspector.values.fillOpacity,
      strokeOpacity: { value: null, mixed: false },
      effect: moleculeInspector.values.effect,
      strokeWidth: { value: null, mixed: false },
      dash: { value: null, mixed: false },
      lineEnds: { value: null, mixed: false },
      corners: { value: null, mixed: false },
      markerStartKind: { value: null, mixed: false },
      markerEndKind: { value: null, mixed: false },
      markerSizePx: { value: null, mixed: false },
      shaftMarkSizePx: { value: null, mixed: false }
    },
    activeGradient: {
      paintType: null,
      stops: [],
      mixed: false,
      editable: false,
      canAddStop: false,
      canDeleteStop: false
    },
    effectControls: moleculeInspector.effectControls,
    skippedObjectIdsByControl: {}
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
  options: { excludeMoleculeObjectIds?: ReadonlySet<string> } = {}
): ArtInspectorStyleObject[] {
  const selectedIds = new Set(document.selection.objectIds);
  if (selectedIds.size === 0) {
    return [];
  }

  return document.pages.flatMap((page) =>
    page.objects.filter((object): object is ArtInspectorStyleObject =>
      (object.type === "graphic" || object.type === "molecule") &&
      selectedIds.has(object.id) &&
      !options.excludeMoleculeObjectIds?.has(object.id)
    )
  );
}

function countSupported(values: readonly boolean[]): number {
  return values.filter(Boolean).length;
}

function moleculeHasRingStyles(object: MoleculeObject): boolean {
  const ringStyles = object.style.ringStyles;
  return Boolean(
    ringStyles &&
    typeof ringStyles === "object" &&
    !Array.isArray(ringStyles) &&
    Object.keys(ringStyles).length > 0
  );
}

function uniqueGraphicKinds(objects: readonly GraphicObject[]): GraphicObject["graphicKind"][] {
  return [...new Set(objects.map((object) => object.graphicKind))];
}

/**
 * The largest size the renderer will floor a head to anywhere in the selection. Derived from the
 * engine's own rule (per marker kind × that object's stroke width) rather than a hand-copy, and
 * taken over the MAXIMUM rather than a fallback stroke width: on a mixed-width selection the widget
 * used to assume 2px, offering sizes the thickest arrow silently rendered larger.
 */
function markerRenderedSizeFloorForSelection(
  planned: readonly ArtInspectorPlannedEntry[],
  supportsMarkers: readonly boolean[]
): number | undefined {
  let floor: number | undefined;
  planned.forEach((entry, index) => {
    if (!supportsMarkers[index] || entry.object.type !== "graphic") {
      return;
    }
    const strokeWidth = metadataNumberValue(entry.object.style.strokeWidth, 1.5) ?? 1.5;
    for (const markerId of ["markerStart", "markerEnd"] as const) {
      const marker = entry.object.data[markerId];
      if (!marker || marker.kind === "none") {
        continue;
      }
      const kindFloor = graphicMarkerRenderedSizeFloorPx(marker.kind, strokeWidth);
      floor = floor === undefined ? kindFloor : Math.max(floor, kindFloor);
    }
  });
  return floor;
}

/**
 * What a control that edits every head at once should report. Aggregates the size of every RENDERED
 * head across the selection — both ends of every marker-capable object — so two heads that disagree
 * read as mixed whether they sit on one arrow or two. Shift-dragging legitimately produces a 12px
 * start with a 24px end, and reading only `markerEnd?.sizePx ?? markerStart?.sizePx` reported that
 * as a uniform 24 (a state the arrow was not in, which the size command then made true for both).
 * A marker present as `{kind: "none"}` is not a rendered head and is skipped.
 */
function renderedMarkerSizeValue(
  planned: readonly ArtInspectorPlannedEntry[],
  supportsMarkers: readonly boolean[]
): ArtInspectorMixedValue<number> {
  const sizes: number[] = [];
  planned.forEach((entry, index) => {
    if (!supportsMarkers[index] || entry.object.type !== "graphic") {
      return;
    }
    const strokeWidth = entry.plan?.stroke.width ?? 1.5;
    for (const markerId of ["markerStart", "markerEnd"] as const) {
      const marker = entry.object.data[markerId];
      if (!marker || marker.kind === "none") {
        continue;
      }
      // The size this head DRAWS at, from the engine's own rule. Substituting a flat 16 for an
      // absent `sizePx` reported a number nothing rendered — the renderer defaults to 10 and floors
      // by stroke width — so a selection mixing a stored 16 with an unset head read as a confident
      // uniform 16: exactly the state the paragraph above says this function exists to prevent, and
      // picking that size then made the misreport true.
      //
      // Read from the STORED marker, not the plan's `markerStart`/`markerEnd`: those are dual-shaft
      // scaled, while the size command writes an unscaled `sizePx`, so reporting the scaled value
      // would just trade one disagreement for another.
      sizes.push(graphicMarkerRenderedSizePx(marker, strokeWidth));
    }
  });
  if (sizes.length === 0) {
    return { value: null, mixed: false };
  }

  const [first, ...rest] = sizes;
  const uniform = rest.every((size) => size === first);
  return { value: uniform ? first : null, mixed: !uniform };
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
  const markers = skippedForControl(planned, "markers");
  return {
    ...(fill.length > 0 ? { fill } : {}),
    ...(lineEnds.length > 0 ? { lineEnds } : {}),
    ...(corners.length > 0 ? { corners } : {}),
    ...(markers.length > 0 ? { markers } : {})
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
    if (control === "markers" && !graphicObjectSupportsMarkersWithPlan(object, plan)) {
      return [{
        objectId: object.id,
        // Closed shapes have no terminals to head; retro arrows (path-geometry "⇒") and other
        // ineligible opens read as plain unsupported.
        reason: plan.capabilities.isClosedShape ? "closed-shape" : "unsupported"
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

function moleculeFillToolbarColor(object: MoleculeObject): string | null {
  const paint = graphicPaintFromMetadata(object.style.fillPaint);
  if (paint?.kind === "solid") {
    return normalizeToolbarHexColor(paint.color);
  }
  if (paint?.kind === "linear-gradient" || paint?.kind === "radial-gradient") {
    return representativeGradientStopColor(paint);
  }
  const fillColor = metadataStringValue(object.style.fillColor);
  return fillColor?.toLowerCase() === "none" ? null : normalizeToolbarHexColor(fillColor);
}

function moleculeStrokeToolbarColor(object: MoleculeObject): string | null {
  const paint = graphicPaintFromMetadata(object.style.strokePaint);
  if (paint?.kind === "solid") {
    return normalizeToolbarHexColor(paint.color);
  }
  return normalizeToolbarHexColor(metadataColor(object.style.bondColor, object.style.strokeColor, object.style.color, "#111111"));
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
    .filter((_, index) => supported[index])
    .map(({ object }) => objectPaintForTarget(object, target));
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

function moleculeFillToolbarPaintType(object: MoleculeObject): ArtInspectorPaintType {
  const paint = graphicPaintFromMetadata(object.style.fillPaint);
  if (paint) {
    return paint.kind;
  }
  return metadataStringValue(object.style.fillColor)?.toLowerCase() === "none" ||
    metadataStringValue(object.style.fillColor) === undefined
    ? "none"
    : "solid";
}

/** Molecule strokes are always solid — there is no gradient or gloss bond stroke to report. The
 *  previous form read the stored paint and then returned "solid" from both arms of a ternary,
 *  which looked like it was deciding something. */
function moleculeStrokeToolbarPaintType(): ArtInspectorPaintType {
  return "solid";
}

function objectPaintForTarget(
  object: ArtInspectorStyleObject,
  target: ArtInspectorPaintTarget
): GraphicPaint | undefined {
  if (object.type === "graphic") {
    return target === "fill" ? object.style.fillPaint : object.style.strokePaint;
  }

  return target === "fill"
    ? graphicPaintFromMetadata(object.style.fillPaint)
    : graphicPaintFromMetadata(object.style.strokePaint);
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

function graphicPaintFromMetadata(value: unknown): GraphicPaint | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const paint = value as Record<string, unknown>;
  if (paint.kind === "none") {
    return { kind: "none" };
  }
  if (paint.kind === "solid" && typeof paint.color === "string") {
    return {
      kind: "solid",
      color: paint.color,
      ...(typeof paint.opacity === "number" ? { opacity: clampToolbarUnit(paint.opacity) } : {})
    };
  }
  if (
    paint.kind === "linear-gradient" &&
    paint.units === "object" &&
    typeof paint.x1 === "number" &&
    typeof paint.y1 === "number" &&
    typeof paint.x2 === "number" &&
    typeof paint.y2 === "number" &&
    Array.isArray(paint.stops)
  ) {
    return {
      kind: "linear-gradient",
      units: "object",
      x1: clampToolbarUnit(paint.x1),
      y1: clampToolbarUnit(paint.y1),
      x2: clampToolbarUnit(paint.x2),
      y2: clampToolbarUnit(paint.y2),
      stops: normalizedGradientStops({
        kind: "linear-gradient",
        units: "object",
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 1,
        stops: paint.stops as Extract<GraphicPaint, { kind: "linear-gradient" }>["stops"]
      }).map((stop) => ({ ...stop }))
    };
  }
  if (
    paint.kind === "radial-gradient" &&
    paint.units === "object" &&
    typeof paint.cx === "number" &&
    typeof paint.cy === "number" &&
    typeof paint.r === "number" &&
    Array.isArray(paint.stops)
  ) {
    return {
      kind: "radial-gradient",
      units: "object",
      cx: clampToolbarUnit(paint.cx),
      cy: clampToolbarUnit(paint.cy),
      r: Math.max(0, paint.r),
      ...(typeof paint.fx === "number" ? { fx: clampToolbarUnit(paint.fx) } : {}),
      ...(typeof paint.fy === "number" ? { fy: clampToolbarUnit(paint.fy) } : {}),
      stops: normalizedGradientStops({
        kind: "radial-gradient",
        units: "object",
        cx: 0.5,
        cy: 0.5,
        r: 0.5,
        stops: paint.stops as Extract<GraphicPaint, { kind: "radial-gradient" }>["stops"]
      }).map((stop) => ({ ...stop }))
    };
  }

  return undefined;
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
