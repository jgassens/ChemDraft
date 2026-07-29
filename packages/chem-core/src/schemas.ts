import { z } from "zod";
import {
  PageOrientations,
  PageSizePresetIds,
  PageSizeUnits,
  pageLayoutMatchesSize,
  type PageLayout as NativePageLayout
} from "./page-layout";

export const DocumentSchemaVersion = "chemdraft.document.v1" as const;

const IdSchema = z.string().min(1);
const IsoDateSchema = z.string().datetime();
const MetadataSchema = z.record(z.string(), z.unknown());

export const CompatibilityWarningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    objectId: IdSchema.optional()
  })
  .strict();

export const CompatibilityMetadataSchema = z
  .object({
    sourceFormat: z.string().optional(),
    originalId: z.string().optional(),
    warnings: z.array(CompatibilityWarningSchema).default([]),
    unknown: MetadataSchema.default({})
  })
  .strict();

export const PointSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite()
  })
  .strict();

const OpacitySchema = z.number().finite().min(0).max(1);
const NormalizedCoordinateSchema = z.number().finite().min(0).max(1);

/**
 * An enum that already carries an `"unknown"` member, degrading to it instead of rejecting.
 *
 * Every classifier below — arrow kind, bond order, bracket kind, graphic kind — spells `"unknown"`
 * as a member precisely because the value can come from a file this build does not fully understand:
 * an imported CDXML, or a document a newer ChemDraft wrote. A bare `z.enum` does not honour that
 * intent. It fails the field, which fails the object, which fails the page, which fails the *whole
 * document* — so one arrow of a kind added after this build shipped makes the file unopenable, when
 * the schema's own vocabulary says the answer is to call that arrow unknown and draw the rest.
 *
 * The `"unknown"` member is the contract; this is what makes it true.
 */
function degradingEnum<const Values extends readonly ["unknown" | (string & {}), ...("unknown" | (string & {}))[]]>(
  values: Values & (Extract<Values[number], "unknown"> extends never ? never : unknown)
) {
  return z.enum(values as unknown as [Values[number], ...Values[number][]]).catch("unknown" as Values[number]);
}

export const GraphicGradientStopSchema = z
  .object({
    offset: NormalizedCoordinateSchema,
    color: z.string(),
    opacity: OpacitySchema.optional()
  })
  .strict();

export const GraphicPaintSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("none")
    })
    .strict(),
  z
    .object({
      kind: z.literal("solid"),
      color: z.string(),
      opacity: OpacitySchema.optional()
    })
    .strict(),
  z
    .object({
      kind: z.literal("linear-gradient"),
      stops: z.array(GraphicGradientStopSchema).min(2),
      x1: NormalizedCoordinateSchema,
      y1: NormalizedCoordinateSchema,
      x2: NormalizedCoordinateSchema,
      y2: NormalizedCoordinateSchema,
      units: z.literal("object")
    })
    .strict(),
  z
    .object({
      kind: z.literal("radial-gradient"),
      stops: z.array(GraphicGradientStopSchema).min(2),
      cx: NormalizedCoordinateSchema,
      cy: NormalizedCoordinateSchema,
      r: z.number().finite().nonnegative(),
      fx: NormalizedCoordinateSchema.optional(),
      fy: NormalizedCoordinateSchema.optional(),
      units: z.literal("object")
    })
    .strict()
]);

export const VisualEffectSchema = z
  .object({
    kind: z.enum(["shadow", "glow", "sketch"]),
    color: z.string().optional(),
    opacity: OpacitySchema.optional(),
    offsetX: z.number().finite().optional(),
    offsetY: z.number().finite().optional(),
    blurPx: z.number().finite().nonnegative().optional(),
    spreadPx: z.number().finite().optional(),
    roughness: z.number().finite().nonnegative().optional(),
    bowing: z.number().finite().nonnegative().optional(),
    strokeWidth: z.number().finite().positive().optional(),
    seed: z.number().int().positive().optional()
  })
  .strict();

export const GraphicEffectSchema = VisualEffectSchema;

export const VisualEffectStyleSchema = z
  .object({
    effect: z.enum(["shadow", "reflection"]).optional(),
    visualEffects: z.array(VisualEffectSchema).optional(),
    inactiveVisualEffects: z.array(VisualEffectSchema).optional(),
    effects: z.array(VisualEffectSchema).optional(),
    inactiveEffects: z.array(VisualEffectSchema).optional()
  })
  .strict();

export const AnchorSchema = z
  .object({
    kind: z.enum(["point", "object", "atom", "bond"]),
    point: PointSchema.optional(),
    objectId: IdSchema.optional(),
    atomId: z.string().optional(),
    bondId: z.string().optional()
  })
  .strict();

const BaseObjectSchema = z
  .object({
    id: IdSchema,
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
    rotation: z.number().finite().default(0),
    style: MetadataSchema.default({}),
    compatibility: CompatibilityMetadataSchema.optional()
  })
  .strict();

export const GraphicObjectStyleSchema = z
  .object({
    source: z.string().optional(),
    color: z.string().optional(),
    strokeColor: z.string().optional(),
    fillColor: z.string().optional(),
    strokePaint: GraphicPaintSchema.optional(),
    fillPaint: GraphicPaintSchema.optional(),
    opacity: OpacitySchema.optional(),
    strokeOpacity: OpacitySchema.optional(),
    fillOpacity: OpacitySchema.optional(),
    strokeWidth: z.number().finite().positive().optional(),
    strokeDasharray: z.string().optional(),
    strokeLineCap: z.enum(["butt", "round", "square"]).optional(),
    strokeLineJoin: z.enum(["miter", "round", "bevel"]).optional(),
    strokeMiterLimit: z.number().finite().positive().optional(),
    fillMode: z.enum(["solid", "gloss"]).optional(),
    effect: z.enum(["shadow", "reflection"]).optional(),
    visualEffects: z.array(VisualEffectSchema).optional(),
    inactiveVisualEffects: z.array(VisualEffectSchema).optional(),
    effects: z.array(GraphicEffectSchema).optional(),
    inactiveEffects: z.array(GraphicEffectSchema).optional(),
    tiltXDegrees: z.number().finite().optional(),
    tiltYDegrees: z.number().finite().optional(),
    artToolId: z.string().optional(),
    artToolCommandId: z.string().optional()
  })
  .strict();

export const GraphicMarkerSchema = z
  .object({
    kind: z.enum(["none", "open-arrow", "filled-arrow", "half-arrow", "bar", "dot", "diamond", "chevron"]),
    sizePx: z.number().finite().positive().optional(),
    angleDegrees: z.number().finite().optional()
  })
  .strict();

export const GraphicPathNodeSchema = z
  .object({
    point: PointSchema,
    inControl: PointSchema.optional(),
    outControl: PointSchema.optional()
  })
  .strict();

export const GraphicFreehandPointSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    pressure: z.number().finite().min(0).max(1).optional()
  })
  .strict();

export const GraphicFreehandOptionsSchema = z
  .object({
    size: z.number().finite().positive().optional(),
    thinning: z.number().finite().optional(),
    smoothing: NormalizedCoordinateSchema.optional(),
    streamline: NormalizedCoordinateSchema.optional(),
    simulatePressure: z.boolean().optional()
  })
  .strict();

export const GraphicObjectDataSchema = z
  .object({
    lineStart: PointSchema.optional(),
    lineEnd: PointSchema.optional(),
    pathControlPoint: PointSchema.optional(),
    pathD: z.string().optional(),
    artPathKind: z.enum(["line", "wavy", "arc", "quadratic", "polyline", "bezier", "freehand"]).optional(),
    pathNodes: z.array(GraphicPathNodeSchema).min(1).optional(),
    pathClosed: z.boolean().optional(),
    freehandPoints: z.array(GraphicFreehandPointSchema).min(1).optional(),
    freehandOptions: GraphicFreehandOptionsSchema.optional(),
    cachedFreehandPathD: z.string().optional(),
    cachedFreehandPathRevision: z.string().optional(),
    arcCenter: PointSchema.optional(),
    arcRadiusX: z.number().finite().positive().optional(),
    arcRadiusY: z.number().finite().positive().optional(),
    arcStartRadians: z.number().finite().optional(),
    arcSweepRadians: z.number().finite().optional(),
    markerStart: GraphicMarkerSchema.optional(),
    markerEnd: GraphicMarkerSchema.optional(),
    // Decoration drawn across the shaft midpoint ("cross" = X, the no-reaction mark).
    shaftMark: z.enum(["cross"]).optional(),
    // Equilibrium arrows: two parallel half-shafts pointing opposite ways along lineStart->lineEnd.
    // `markerEnd` heads the forward (offset +normal) shaft, `markerStart` the reverse one, so head
    // sizing rides the ordinary marker machinery. Each shaft's length is an independent fraction of
    // the axis, because an equilibrium's two directions are rarely equal.
    dualShaft: z.boolean().optional(),
    dualShaftGapPx: z.number().finite().positive().optional(),
    dualShaftForwardFrac: z.number().finite().positive().optional(),
    dualShaftReverseFrac: z.number().finite().positive().optional(),
    cornerRadiusPx: z.number().finite().nonnegative().optional(),
    imageHref: z.string().optional(),
    imageMimeType: z.string().optional(),
    artToolId: z.string().optional()
  })
  .strict();

export const ChemicalMetadataSchema = z
  .object({
    formula: z.string().min(1).optional(),
    averageMass: z.number().finite().nonnegative().optional(),
    exactMass: z.number().finite().nonnegative().optional(),
    atomCount: z.number().int().nonnegative().optional(),
    bondCount: z.number().int().nonnegative().optional(),
    totalCharge: z.number().int().optional(),
    radicalCount: z.number().int().nonnegative().optional(),
    isotopeLabels: z.array(z.string()).default([]),
    stereochemistry: z.array(z.string()).default([]),
    warnings: z.array(CompatibilityWarningSchema).default([])
  })
  .strict();

export const SuperatomMetadataSchema = z
  .object({
    label: z.string().min(1),
    expandedStructureFormat: degradingEnum(["molfile-v3000", "molfile-v2000", "smiles", "unknown"]).optional(),
    expandedStructure: z.string().optional(),
    attachmentPoints: z.array(AnchorSchema).default([]),
    warnings: z.array(CompatibilityWarningSchema).default([])
  })
  .strict();

export const RGroupDisplaySchema = z
  .object({
    label: z.string().min(1),
    querySemantics: z.enum(["unknown", "display-only", "query"]).default("unknown"),
    attachmentPoints: z.array(AnchorSchema).default([]),
    warnings: z.array(CompatibilityWarningSchema).default([])
  })
  .strict();

export const MoleculeAtomSchema = z
  .object({
    id: IdSchema,
    element: z.string().min(1),
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite().optional(),
    formalCharge: z.number().int().default(0),
    labelVisible: z.boolean().optional(),
    labelOffset: PointSchema.optional()
  })
  .strict();

export const MoleculeBondDisplaySchema = z
  .object({
    doubleBondSide: z.enum(["left", "right"]).optional(),
    bondStyle: z.enum(["bold", "wedge", "hashed", "dashed"]).optional(),
    /** Perspective depth cue baked by the 3D flatten: 0 = farthest bond, 1 = nearest.
     *  Display-only (stroke weight) — never part of chemical identity. */
    depthWeight: z.number().min(0).max(1).optional()
  })
  .strict();

export const MoleculeBondSchema = z
  .object({
    id: IdSchema,
    fromAtomId: IdSchema,
    toAtomId: IdSchema,
    order: degradingEnum(["single", "double", "triple", "aromatic", "unknown"]).default("single"),
    display: MoleculeBondDisplaySchema.optional()
  })
  .strict();

export const BondRefSchema = z
  .object({
    objectId: IdSchema,
    bondId: IdSchema
  })
  .strict();

function bondRefKey(ref: z.infer<typeof BondRefSchema>): string {
  return `${ref.objectId}::${ref.bondId}`;
}

export const CrossingOverrideSchema = z
  .object({
    bonds: z.tuple([BondRefSchema, BondRefSchema]),
    front: BondRefSchema,
    clearancePx: z.number().finite().positive().optional()
  })
  .strict()
  .superRefine((crossing, context) => {
    const [left, right] = crossing.bonds;
    if (bondRefKey(left) === bondRefKey(right)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["bonds"],
        message: "Crossing override must reference two distinct bonds."
      });
    }

    const frontKey = bondRefKey(crossing.front);
    if (frontKey !== bondRefKey(left) && frontKey !== bondRefKey(right)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["front"],
        message: "Crossing override front bond must be one of the crossing bonds."
      });
    }
  });

export const MoleculeTransformStateSchema = z
  .object({
    scaleX: z.number().finite().positive().default(1),
    scaleY: z.number().finite().positive().default(1),
    rotationDegrees: z.number().finite().default(0),
    tiltXDegrees: z.number().finite().optional(),
    tiltYDegrees: z.number().finite().optional()
  })
  .strict();

export const MoleculeObjectSchema = BaseObjectSchema.extend({
  type: z.literal("molecule"),
  structureFormat: degradingEnum(["molfile-v3000", "molfile-v2000", "smiles", "unknown"]),
  structure: z.string(),
  chemistry: ChemicalMetadataSchema.optional(),
  atoms: z.array(MoleculeAtomSchema).default([]),
  bonds: z.array(MoleculeBondSchema).default([]),
  transform: MoleculeTransformStateSchema.optional(),
  superatoms: z.array(SuperatomMetadataSchema).default([]),
  rGroups: z.array(RGroupDisplaySchema).default([])
}).strict();

export const ReactionComponentSchema = z
  .object({
    role: z.enum(["reactant", "agent", "product"]),
    objectId: IdSchema
  })
  .strict();

export const ReactionObjectSchema = BaseObjectSchema.extend({
  type: z.literal("reaction"),
  components: z.array(ReactionComponentSchema),
  conditionsTextObjectIds: z.array(IdSchema).default([]),
  mappingState: degradingEnum(["absent", "partial", "complete", "unknown"]).default("unknown")
}).strict();

export const ArrowObjectSchema = BaseObjectSchema.extend({
  type: z.literal("reaction-arrow"),
  arrowKind: degradingEnum(["forward", "resonance", "equilibrium", "retrosynthesis", "unknown"]),
  start: AnchorSchema,
  end: AnchorSchema,
  labels: z.array(IdSchema).default([])
}).strict();

export const MechanismArrowObjectSchema = BaseObjectSchema.extend({
  type: z.literal("mechanism-arrow"),
  arrowKind: degradingEnum(["full-headed", "half-headed", "unknown"]),
  source: AnchorSchema,
  target: AnchorSchema,
  controlPoints: z.array(PointSchema).default([]),
  warnings: z.array(CompatibilityWarningSchema).default([])
}).strict();

export const ElectronMarkObjectSchema = BaseObjectSchema.extend({
  type: z.literal("electron-mark"),
  markKind: degradingEnum(["lone-pair", "radical-dot", "charge", "unknown"]),
  anchor: AnchorSchema,
  charge: z.number().int().optional()
}).strict();

export const TextSpanSchema = z
  .object({
    text: z.string(),
    script: z.enum(["normal", "subscript", "superscript"]).default("normal"),
    style: MetadataSchema.default({})
  })
  .strict();

export const TextObjectSchema = BaseObjectSchema.extend({
  type: z.literal("text"),
  text: z.string(),
  spans: z.array(TextSpanSchema).default([])
}).strict();

export const BracketObjectSchema = BaseObjectSchema.extend({
  type: z.literal("bracket"),
  bracketKind: degradingEnum(["square", "round", "curly", "polymer", "unknown"]),
  label: z.string().optional(),
  containedObjectIds: z.array(IdSchema).default([])
}).strict();

export const GraphicObjectSchema = BaseObjectSchema.extend({
  type: z.literal("graphic"),
  graphicKind: degradingEnum(["line", "rect", "ellipse", "path", "image", "unknown"]),
  style: GraphicObjectStyleSchema.default({}),
  data: GraphicObjectDataSchema.default({})
}).strict();

export const PlusObjectSchema = BaseObjectSchema.extend({
  type: z.literal("plus")
}).strict();

export const GroupObjectSchema = BaseObjectSchema.extend({
  type: z.literal("group"),
  childObjectIds: z.array(IdSchema)
}).strict();

export const AnnotationObjectSchema = BaseObjectSchema.extend({
  type: z.literal("annotation"),
  targetObjectIds: z.array(IdSchema).default([]),
  message: z.string()
}).strict();

export const SuperatomObjectSchema = BaseObjectSchema.extend({
  type: z.literal("superatom"),
  label: z.string().min(1),
  metadata: SuperatomMetadataSchema
}).strict();

export const RGroupLabelObjectSchema = BaseObjectSchema.extend({
  type: z.literal("r-group-label"),
  label: z.string().min(1),
  display: RGroupDisplaySchema
}).strict();

export const GenericAtomLabelObjectSchema = BaseObjectSchema.extend({
  type: z.literal("generic-atom-label"),
  label: z.string().min(1),
  querySemantics: z.enum(["unknown", "display-only", "query"]).default("unknown")
}).strict();

export const UnknownCompatibilityObjectSchema = BaseObjectSchema.extend({
  type: z.literal("unknown-compatibility-object"),
  sourceFormat: z.string().min(1),
  sourceObjectType: z.string().min(1),
  warning: z.string().min(1),
  raw: z.unknown().optional()
}).strict();

export const DocumentObjectSchema = z.discriminatedUnion("type", [
  MoleculeObjectSchema,
  ReactionObjectSchema,
  ArrowObjectSchema,
  MechanismArrowObjectSchema,
  ElectronMarkObjectSchema,
  TextObjectSchema,
  BracketObjectSchema,
  GraphicObjectSchema,
  PlusObjectSchema,
  GroupObjectSchema,
  AnnotationObjectSchema,
  SuperatomObjectSchema,
  RGroupLabelObjectSchema,
  GenericAtomLabelObjectSchema,
  UnknownCompatibilityObjectSchema
]);

export const PageSizePresetIdSchema = z.enum(PageSizePresetIds);
export const PageSizeUnitSchema = z.enum(PageSizeUnits);
export const PageOrientationSchema = z.enum(PageOrientations);

export const PageLayoutSchema: z.ZodType<NativePageLayout> = z
  .object({
    presetId: PageSizePresetIdSchema,
    orientation: PageOrientationSchema,
    widthPx: z.number().finite().positive(),
    heightPx: z.number().finite().positive(),
    marginTopPx: z.number().finite().nonnegative(),
    marginRightPx: z.number().finite().nonnegative(),
    marginBottomPx: z.number().finite().nonnegative(),
    marginLeftPx: z.number().finite().nonnegative(),
    sourceUnit: PageSizeUnitSchema.optional(),
    sourceWidth: z.number().finite().positive().optional(),
    sourceHeight: z.number().finite().positive().optional()
  })
  .strict();

export const DocumentPageSchema = z
  .object({
    id: IdSchema,
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    margin: z
      .object({
        top: z.number().finite().nonnegative(),
        right: z.number().finite().nonnegative(),
        bottom: z.number().finite().nonnegative(),
        left: z.number().finite().nonnegative()
      })
      .strict()
      .default({ top: 72, right: 72, bottom: 72, left: 72 }),
    layout: PageLayoutSchema,
    objects: z.array(DocumentObjectSchema),
    crossings: z.array(CrossingOverrideSchema).default([])
  })
  .strict()
  .superRefine((page, context) => {
    if (!pageLayoutMatchesSize(page.layout, page.width, page.height)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["layout"],
        message: "Page layout widthPx/heightPx must match page width/height."
      });
    }
  });

export const DocumentSelectionSchema = z
  .object({
    pageId: IdSchema.optional(),
    objectIds: z.array(IdSchema).default([])
  })
  .strict();

export const ChemDraftDocumentSchema = z
  .object({
    schema: z.literal(DocumentSchemaVersion),
    id: IdSchema,
    title: z.string(),
    createdAt: IsoDateSchema,
    updatedAt: IsoDateSchema,
    pages: z.array(DocumentPageSchema).min(1),
    selection: DocumentSelectionSchema.default({ objectIds: [] }),
    styles: MetadataSchema.default({}),
    plugins: MetadataSchema.default({}),
    compatibility: z
      .object({
        warnings: z.array(CompatibilityWarningSchema).default([])
      })
      .strict()
      .default({ warnings: [] })
  })
  .strict();

export type DocumentSchemaVersion = typeof DocumentSchemaVersion;
export type CompatibilityWarning = z.infer<typeof CompatibilityWarningSchema>;
export type CompatibilityMetadata = z.infer<typeof CompatibilityMetadataSchema>;
export type Point = z.infer<typeof PointSchema>;
export type Anchor = z.infer<typeof AnchorSchema>;
export type ChemicalMetadata = z.infer<typeof ChemicalMetadataSchema>;
export type SuperatomMetadata = z.infer<typeof SuperatomMetadataSchema>;
export type RGroupDisplay = z.infer<typeof RGroupDisplaySchema>;
export type MoleculeAtom = z.infer<typeof MoleculeAtomSchema>;
export type MoleculeBondDisplay = z.infer<typeof MoleculeBondDisplaySchema>;
export type MoleculeBond = z.infer<typeof MoleculeBondSchema>;
export type BondRef = z.infer<typeof BondRefSchema>;
export type CrossingOverride = z.infer<typeof CrossingOverrideSchema>;
export type MoleculeTransformState = z.infer<typeof MoleculeTransformStateSchema>;
export type MoleculeObject = z.infer<typeof MoleculeObjectSchema>;
export type ReactionComponent = z.infer<typeof ReactionComponentSchema>;
export type ReactionObject = z.infer<typeof ReactionObjectSchema>;
export type ArrowObject = z.infer<typeof ArrowObjectSchema>;
export type MechanismArrowObject = z.infer<typeof MechanismArrowObjectSchema>;
export type ElectronMarkObject = z.infer<typeof ElectronMarkObjectSchema>;
export type TextSpan = z.infer<typeof TextSpanSchema>;
export type TextObject = z.infer<typeof TextObjectSchema>;
export type BracketObject = z.infer<typeof BracketObjectSchema>;
export type GraphicGradientStop = z.infer<typeof GraphicGradientStopSchema>;
export type GraphicPaint = z.infer<typeof GraphicPaintSchema>;
export type VisualEffect = z.infer<typeof VisualEffectSchema>;
export type VisualEffectStyle = z.infer<typeof VisualEffectStyleSchema>;
export type GraphicEffect = VisualEffect;
export type GraphicMarker = z.infer<typeof GraphicMarkerSchema>;
export type GraphicPathNode = z.infer<typeof GraphicPathNodeSchema>;
export type GraphicFreehandPoint = z.infer<typeof GraphicFreehandPointSchema>;
export type GraphicFreehandOptions = z.infer<typeof GraphicFreehandOptionsSchema>;
export type GraphicObjectStyle = z.infer<typeof GraphicObjectStyleSchema>;
export type GraphicObjectData = z.infer<typeof GraphicObjectDataSchema>;
export type GraphicObject = z.infer<typeof GraphicObjectSchema>;
export type PlusObject = z.infer<typeof PlusObjectSchema>;
export type GroupObject = z.infer<typeof GroupObjectSchema>;
export type AnnotationObject = z.infer<typeof AnnotationObjectSchema>;
export type SuperatomObject = z.infer<typeof SuperatomObjectSchema>;
export type RGroupLabelObject = z.infer<typeof RGroupLabelObjectSchema>;
export type GenericAtomLabelObject = z.infer<typeof GenericAtomLabelObjectSchema>;
export type UnknownCompatibilityObject = z.infer<typeof UnknownCompatibilityObjectSchema>;
export type DocumentObject = z.infer<typeof DocumentObjectSchema>;
export type PageSizePresetId = z.infer<typeof PageSizePresetIdSchema>;
export type PageSizeUnit = z.infer<typeof PageSizeUnitSchema>;
export type PageOrientation = z.infer<typeof PageOrientationSchema>;
export type PageLayout = z.infer<typeof PageLayoutSchema>;
export type DocumentPage = z.infer<typeof DocumentPageSchema>;
export type DocumentSelection = z.infer<typeof DocumentSelectionSchema>;
export type ChemDraftDocument = z.infer<typeof ChemDraftDocumentSchema>;
