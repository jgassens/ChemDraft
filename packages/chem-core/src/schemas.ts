import { z } from "zod";
import { NativeFieldPatternSchema } from "./nativeFieldPatterns";
import { NativeExtensionsSchema, NativeVersionSchema } from "./nativeCompatibilityState";
import { normalizeAtomIsotope } from "./isotopes";
import { atomicNumberForElementSymbol } from "./elements";
import { decodeImageBase64, imageBase64Error } from "./imageBytes";
import { imagePixelLimitError, validatePngImage } from "./imageInfo";
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

// Optional metadata keeps older documents loadable without adding a preset during parsing.
const ObjectStyleMetadataSchema = z.object({
  stylePresetId: z.string().optional()
});

export const ArrowAttachmentFrameSchema = z.object({
  origin: PointSchema, tangent: PointSchema, normal: PointSchema,
  length: z.number().finite().positive().optional()
}).strict().refine(frame => Math.abs(Math.hypot(frame.tangent.x, frame.tangent.y) - 1) < 1e-6 &&
  Math.abs(Math.hypot(frame.normal.x, frame.normal.y) - 1) < 1e-6 &&
  Math.abs(frame.tangent.x * frame.normal.x + frame.tangent.y * frame.normal.y) < 1e-6,
  "Arrow attachment axes must be perpendicular unit vectors");
export const ArrowAttachmentSchema = z.object({
  kind: z.literal("conditions"), parentObjectId: IdSchema,
  side: z.enum(["above", "below"]), frame: ArrowAttachmentFrameSchema, offset: PointSchema,
  placement: z.enum(["auto", "manual"]).optional()
}).strict();
export type ArrowAttachment = z.infer<typeof ArrowAttachmentSchema>;
export type ArrowAttachmentFrame = z.infer<typeof ArrowAttachmentFrameSchema>;

const BaseObjectSchema = z
  .object({
    id: IdSchema,
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
    rotation: z.number().finite().default(0),
    // Keep the record first: an object/catchall parser moves declared keys before metadata,
    // changing legacy serialized bytes when stylePresetId is already present in the record.
    style: MetadataSchema.and(ObjectStyleMetadataSchema).default({}),
    compatibility: CompatibilityMetadataSchema.optional()
  })
  .strict();

export const GraphicObjectStyleSchema = ObjectStyleMetadataSchema
  .extend({
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

export const ImageObjectDataSchema = z.object({
  mimeType: z.enum(["image/png", "image/svg+xml"]),
  dataBase64: z.string(),
  pixelWidth: z.number().int().positive(),
  pixelHeight: z.number().int().positive(),
  pixelsPerMeter: z.object({
    x: z.number().int().positive(),
    y: z.number().int().positive()
  }).strict().optional()
}).strict();

export const GraphicObjectDataSchema = z
  .object({
    lineStart: PointSchema.optional(),
    lineEnd: PointSchema.optional(),
    pathControlPoint: PointSchema.optional(),
    pathD: z.string().optional(),
    artPathKind: z.enum(["line", "wavy", "arc", "quadratic", "polyline", "bezier", "freehand"]).optional(),
    waveSmoothness: z.number().finite().min(0).max(100).optional(),
    waveHeight: z.number().finite().min(0).max(48).optional(),
    waveWidth: z.number().finite().min(4).max(120).optional(),
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
    // Explicit size for the shaft mark; absent = derived from stroke width (max(12, stroke×5)).
    shaftMarkSizePx: z.number().finite().optional(),
    // Equilibrium arrows: two parallel half-shafts pointing opposite ways along lineStart->lineEnd.
    // `markerEnd` heads the forward (offset +normal) shaft, `markerStart` the reverse one, so head
    // sizing rides the ordinary marker machinery. Each shaft's length is an independent fraction of
    // the axis, because an equilibrium's two directions are rarely equal.
    dualShaft: z.boolean().optional(),
    // Retrosynthetic arrows: both shafts run the same way with one open head spanning them (the
    // double-shafted "=>"), rather than the equilibrium's two opposed half-arrows.
    dualShaftParallel: z.boolean().optional(),
    dualShaftGapPx: z.number().finite().positive().optional(),
    // Dual-shaft arrows: overall heft (the middle-knob resize). Scales the shaft gap together with
    // the head(s) — a retrosynthetic's spanning head, an equilibrium's harpoon pair — so a bigger
    // arrow keeps its proportions rather than growing heads onto hairline shafts.
    dualShaftScale: z.number().finite().positive().optional(),
    dualShaftForwardFrac: z.number().finite().positive().optional(),
    dualShaftReverseFrac: z.number().finite().positive().optional(),
    cornerRadiusPx: z.number().finite().nonnegative().optional(),
    imageHref: z.string().optional(),
    imageMimeType: z.string().optional(),
    // Additive optional data, like the other graphic fields: existing v1 documents need no migration.
    image: ImageObjectDataSchema.optional(),
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
    /** Expanded atoms already present in the owning molecule's graph; never count them twice. */
    atomIds: z.array(IdSchema).min(1).optional(),
    expandedStructureFormat: z.enum(["molfile-v3000", "molfile-v2000", "smiles", "unknown"]).optional(),
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
    /** Import provenance for bracket membership; new atoms must not inherit a deleted atom's source id. */
    cdxmlSourceId: IdSchema.optional(),
    element: z.string().min(1),
    /** Explicit isotope mass number; absent means natural abundance. D/T use their own symbols. */
    isotope: z.number().int().positive().max(999).optional(),
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite().optional(),
    formalCharge: z.number().int().default(0),
    /**
     * The portion of `formalCharge` contributed by nearby charge-mark objects rather than the
     * atom's own (drawn or imported) charge. Maintained by the charge-mark reconciliation:
     * present only while a mark is associated, and always contained in `formalCharge`. Lets the
     * label suppress a superscript the floating mark already draws, and lets a copied molecule
     * (or a mark dragged away) shed the contribution instead of baking it in forever.
     */
    markCharge: z.number().int().optional(),
    /**
     * Unpaired electrons contributed by associated radical marks (•, •+, •−). Like `markCharge`,
     * maintained by the charge-mark reconciliation. Each one consumes a bonding slot, so the
     * implicit hydrogen count drops by one per radical.
     */
    markRadicals: z.number().int().nonnegative().optional(),
    labelVisible: z.boolean().optional(),
    /**
     * The label was typed with the text tool and means exactly what it says: no implicit
     * hydrogens are drawn or counted for this atom, and its valence is checked literally
     * (a lone typed "N" is a flagged hypovalent N, not NH3). Atoms drawn or relabeled via
     * hotkeys stay implicit-hydrogen atoms and never set this.
     */
    labelLiteral: z.boolean().optional(),
    /**
     * The hydrogen count the source file stated for this atom (CDXML `NumHydrogens`), kept only for
     * atoms on aromatic bonds. Aromatic bonds alone cannot say whether a ring N is pyridine-type
     * (no H) or pyrrole-type (N–H); this settles it when the bonds are resolved into a Kekulé
     * pattern. The drawn label and formula still follow the valence model, which agrees with it
     * whenever the ring honours it. This is an import-time hint: editing the atom's element,
     * charge or incident bonds (including dative bonds) drops it before revalidation, and adding
     * or updating a molecule drops it from any atom left with no aromatic bond in a ring.
     */
    hydrogenCount: z.number().int().nonnegative().optional(),
    /**
     * The user dismissed this atom's warning from the context menu. Hides only the canvas
     * badge; validation, chemistry metadata, analysis and export diagnostics still report it.
     * Restore from the same menu.
     */
    warningSuppressed: z.boolean().optional(),
    /**
     * Which side of the label its one bond came from when the label was written, for a label whose
     * meaning depends on it: "SCN" with its bond on the left is a thiocyanate, with it on the right
     * an isothiocyanate. Recorded when the label or its bond is committed (typing, a bond edit,
     * opening or importing a file) and read from here, never from the live coordinates, so moving,
     * rotating or flipping the drawing never changes its chemistry. `atomId` is the neighbour it
     * was read against; the record holds only while that is still the label's one bonded atom.
     */
    labelBondSide: z.object({ side: z.enum(["left", "right"]), atomId: z.string() }).strict().optional(),
    labelOffset: PointSchema.optional()
  })
  .strict()
  .superRefine((atom, context) => {
    if (atom.isotope === undefined) return;
    const message = atom.element === "D" || atom.element === "T"
      ? "D and T must not carry an isotope field."
      : atomicNumberForElementSymbol(atom.element) === undefined
        ? `Isotope mass number requires an element symbol; "${atom.element}" is a label.`
        : undefined;
    if (message) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["isotope"], message });
    }
  });

export const MoleculeBondDisplaySchema = z
  .object({
    doubleBondSide: z.enum(["left", "right", "center", "automatic"]).optional(),
    /** Wavy explicitly leaves the stereocentre at fromAtomId unknown; single bonds only. */
    bondStyle: z.enum(["bold", "wedge", "hashed", "dashed", "wavy"]).optional(),
    /** Perspective depth cue baked by the 3D flatten: 0 = farthest bond, 1 = nearest.
     *  Display-only (stroke weight) — never part of chemical identity. */
    depthWeight: z.number().min(0).max(1).optional()
  })
  .strict();

export const MoleculeBondSchema = z
  .object({
    id: IdSchema,
    /** Import provenance for bracket membership; new bonds have no source identity. */
    cdxmlSourceId: IdSchema.optional(),
    fromAtomId: IdSchema,
    toAtomId: IdSchema,
    order: z.enum(["single", "double", "triple", "aromatic", "unknown"]).default("single"),
    /** Explicitly unspecified E/Z; absence retains geometry-defined interpretation. */
    stereo: z.literal("either").optional(),
    display: MoleculeBondDisplaySchema.optional()
  })
  .strict()
  .refine((bond) => bond.stereo === undefined || bond.order === "double", {
    path: ["stereo"],
    message: 'Bond stereo "either" is valid only for a double bond.'
  })
  .refine((bond) => bond.display?.bondStyle !== "wavy" || bond.order === "single", {
    path: ["display", "bondStyle"],
    message: 'Bond style "wavy" is valid only for a single bond.'
  })
  .transform((bond) => {
    if (bond.stereo === undefined) delete bond.stereo;
    return bond;
  });

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
  structureFormat: z.enum(["molfile-v3000", "molfile-v2000", "smiles", "unknown"]),
  structure: z.string(),
  chemistry: ChemicalMetadataSchema.optional(),
  atoms: z.array(MoleculeAtomSchema).transform((atoms) => atoms.map(normalizeAtomIsotope)).default([]),
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
  /** Shared drawable objects; a multi-step intermediate is referenced, never copied. */
  arrowObjectIds: z.array(IdSchema).optional(),
  plusObjectIds: z.array(IdSchema).optional(),
  mappingState: z.enum(["absent", "partial", "complete", "unknown"]).default("unknown")
}).strict();

export const ArrowObjectSchema = BaseObjectSchema.extend({
  type: z.literal("reaction-arrow"),
  arrowKind: z.enum(["forward", "resonance", "equilibrium", "retrosynthesis", "unknown"]),
  start: AnchorSchema,
  end: AnchorSchema,
  labels: z.array(IdSchema).default([])
}).strict();

export const MechanismArrowObjectSchema = BaseObjectSchema.extend({
  type: z.literal("mechanism-arrow"),
  arrowKind: z.enum(["full-headed", "half-headed", "unknown"]),
  source: AnchorSchema,
  target: AnchorSchema,
  controlPoints: z.array(PointSchema).default([]),
  warnings: z.array(CompatibilityWarningSchema).default([])
}).strict();

export const ElectronMarkObjectSchema = BaseObjectSchema.extend({
  type: z.literal("electron-mark"),
  markKind: z.enum(["lone-pair", "radical-dot", "charge", "unknown"]),
  anchor: AnchorSchema,
  /** An atom chosen by a direct drop stays attached even when the symbol is placed farther away. */
  atomAssociation: z.literal("explicit").optional(),
  charge: z.number().int().optional(),
  /** Charge marks draw circled (⊕/⊖) by default; "plain" renders the bare +/− glyph. */
  chargeStyle: z.enum(["circled", "plain"]).optional(),
  /** A charge mark with `radical` is a radical ion symbol (•+ / •−): one unpaired electron rides along. */
  radical: z.boolean().optional()
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
  spans: z.array(TextSpanSchema).default([]),
  arrowAttachment: ArrowAttachmentSchema.optional()
}).strict();

export const TABLE_LIMITS = {
  maxColumns: 64, maxRows: 500, maxCellCharacters: 2000, maxFootnotes: 50,
  maxSpansPerCell: 200, maxFontFamilyLength: 200, maxFontSizePx: 400, maxTableCharacters: 200000
} as const;

export const TableRichTextSchema = z.object({
  text: z.string().max(TABLE_LIMITS.maxCellCharacters),
  spans: z.array(TextSpanSchema).default([]).superRefine((spans, ctx) => {
    if (spans.length > TABLE_LIMITS.maxSpansPerCell) ctx.addIssue({ code: z.ZodIssueCode.custom,
      message: `maxSpansPerCell is ${TABLE_LIMITS.maxSpansPerCell}; actual value is ${spans.length}` });
  })
}).strict();

export const TableCellSchema = TableRichTextSchema.extend({
  formula: z.enum(["auto", "off"]).optional()
}).strict();

export const TableColumnSchema = z.object({
  id: IdSchema,
  align: z.enum(["left", "center", "right", "decimal", "unknown"]),
  width: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("auto") }).strict(),
    z.object({ mode: z.literal("fixed"), px: z.number().finite().positive().max(4000) }).strict()
  ]),
  formula: z.enum(["auto", "off"]).default("auto")
}).strict();

export const TableRowSchema = z.object({ id: IdSchema, cells: z.array(TableCellSchema) }).strict();

export const TableStyleSchema = z.object({
  preset: z.enum(["three-line", "grid", "unknown"]).default("three-line"),
  topRulePt: z.number().finite().min(0).max(6).default(1),
  headerRulePt: z.number().finite().min(0).max(6).default(0.5),
  bottomRulePt: z.number().finite().min(0).max(6).default(1),
  gridRulePt: z.number().finite().min(0).max(6).default(0.5),
  headerBold: z.boolean().default(false),
  autoColumnMinEm: z.number().finite().gt(0).max(10).optional(),
  cellPaddingPx: z.object({
    x: z.number().finite().min(0).max(48).default(6),
    y: z.number().finite().min(0).max(48).default(2)
  }).strict().default({})
}).strict();

const TableObjectShapeSchema = BaseObjectSchema.extend({
  type: z.literal("table"),
  tableVersion: z.literal(1),
  columns: z.array(TableColumnSchema).min(1).max(TABLE_LIMITS.maxColumns),
  rows: z.array(TableRowSchema).min(1).max(TABLE_LIMITS.maxRows),
  headerRowCount: z.number().int().nonnegative(),
  caption: TableRichTextSchema.optional(),
  footnotes: z.array(TableRichTextSchema).max(TABLE_LIMITS.maxFootnotes).default([]),
  tableStyle: TableStyleSchema.default({})
}).strict();

function refineTable(table: z.infer<typeof TableObjectShapeSchema>, ctx: z.RefinementCtx): void {
  const total = table.rows.flatMap(row => row.cells).reduce((sum, cell) => sum + cell.text.length, 0)
    + (table.caption?.text.length ?? 0) + table.footnotes.reduce((sum, note) => sum + note.text.length, 0);
  if (total > TABLE_LIMITS.maxTableCharacters) ctx.addIssue({ code: z.ZodIssueCode.custom,
    message: `maxTableCharacters is ${TABLE_LIMITS.maxTableCharacters}; actual value is ${total}` });
  const family = table.style.fontFamily;
  if (typeof family === "string" && family.length > TABLE_LIMITS.maxFontFamilyLength) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["style", "fontFamily"],
      message: `maxFontFamilyLength is ${TABLE_LIMITS.maxFontFamilyLength}; actual value is ${family.length}`
    });
  }
  const size = table.style.fontSizePx;
  if (typeof size === "number" && (!Number.isFinite(size) || size < 1 || size > TABLE_LIMITS.maxFontSizePx)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["style", "fontSizePx"],
      message: `fontSizePx must be 1..${TABLE_LIMITS.maxFontSizePx}; actual value is ${size}` });
  }
  const columnIds = new Set<string>();
  table.columns.forEach((column, index) => {
    if (columnIds.has(column.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["columns", index, "id"], message: `Duplicate column id "${column.id}".` });
    columnIds.add(column.id);
  });
  const rowIds = new Set<string>();
  table.rows.forEach((row, index) => {
    if (rowIds.has(row.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index, "id"], message: `Duplicate row id "${row.id}".` });
    rowIds.add(row.id);
    if (row.cells.length !== table.columns.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rows", index, "cells"], message: `Row "${row.id}" must have ${table.columns.length} cells, one per column.` });
  });
  if (table.headerRowCount > table.rows.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headerRowCount"], message: "Header row count exceeds the number of rows." });
}

export const TableObjectSchema = TableObjectShapeSchema.superRefine(refineTable);

/** Import provenance, not live membership. Coordinates deliberately do not participate. */
export const CdxmlBracketAtomSnapshotSchema = z.object({
  sourceId: IdSchema,
  atomId: IdSchema,
  element: z.string().min(1),
  incidentBonds: z.array(z.object({
    id: IdSchema,
    fromAtomId: IdSchema,
    toAtomId: IdSchema,
    fromElement: z.string().min(1),
    toElement: z.string().min(1)
  }).strict())
}).strict();

export const BracketObjectSchema = BaseObjectSchema.extend({
  type: z.literal("bracket"),
  bracketKind: z.enum(["square", "round", "curly", "polymer", "unknown"]),
  // Additive v1 fields: an absent side remains the original opening glyph.
  side: z.enum(["open", "close"]).optional(),
  pairId: IdSchema.optional(),
  repeatUnit: z.boolean().optional(),
  bracketUsage: z.enum(["sru", "multiple", "generic", "unknown"]).optional(),
  repeatCount: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  crossingBondIds: z.array(BondRefSchema).optional(),
  label: z.string().optional(),
  containedObjectIds: z.array(IdSchema).default([]),
  compatibility: CompatibilityMetadataSchema.extend({
    unknown: z.object({
      // Source ids bind these snapshots to cdxmlBracketMembers. Copying a pair remaps the
      // member's objectId but keeps molecule-local atom/bond ids, so this also survives copies.
      cdxmlBracketAtomSnapshots: z.array(CdxmlBracketAtomSnapshotSchema).optional()
    }).catchall(z.unknown()).default({})
  }).optional()
}).strict();

const GraphicObjectShapeSchema = BaseObjectSchema.extend({
  type: z.literal("graphic"),
  graphicKind: z.enum(["line", "rect", "ellipse", "path", "image", "unknown"]),
  style: GraphicObjectStyleSchema.default({}),
  data: GraphicObjectDataSchema.default({})
}).strict();

function validateGraphicImage(object: z.infer<typeof GraphicObjectShapeSchema>, context: z.RefinementCtx) {
  if (object.data.image) {
    const message = imageBase64Error(object.data.image.dataBase64, object.id);
    if (message) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["data", "image", "dataBase64"], message });
      return;
    }
    const image = object.data.image;
    // Existing SVG payloads are preserved on load; completeness is checked when pasting.
    if (image.mimeType !== "image/png") return;
    const bytes = decodeImageBase64(image.dataBase64, object.id);
    const result = validatePngImage(bytes);
    const error = result.error ?? imagePixelLimitError(image.pixelWidth, image.pixelHeight);
    if (error) context.addIssue({ code: z.ZodIssueCode.custom,
      path: ["data", "image", "dataBase64"],
      message: error.replace("Couldn't paste the picture:", `Image object ${object.id}:`) });
  }
}

export const GraphicObjectSchema = GraphicObjectShapeSchema.superRefine(validateGraphicImage);

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
  TableObjectShapeSchema,
  BracketObjectSchema,
  GraphicObjectShapeSchema,
  PlusObjectSchema,
  GroupObjectSchema,
  AnnotationObjectSchema,
  SuperatomObjectSchema,
  RGroupLabelObjectSchema,
  GenericAtomLabelObjectSchema,
  UnknownCompatibilityObjectSchema
]).superRefine((object, context) => {
  // Keep the discriminated union's fast dispatch while applying the same standalone validation.
  if (object.type === "table") refineTable(object, context);
  if (object.type === "graphic") validateGraphicImage(object, context);
});

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
    compatibility: CompatibilityMetadataSchema.optional(),
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
    formatVersion: NativeVersionSchema.optional(),
    minAppVersion: NativeVersionSchema.optional(),
    ignorableFields: z.array(NativeFieldPatternSchema).optional(),
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
        warnings: z.array(CompatibilityWarningSchema).default([]),
        // In-memory preservation state. The serializer restores the original fields instead.
        nativeExtensions: NativeExtensionsSchema.optional()
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
export type TableObject = z.infer<typeof TableObjectSchema>;
export type TableColumn = z.infer<typeof TableColumnSchema>;
export type TableRow = z.infer<typeof TableRowSchema>;
export type TableCell = z.infer<typeof TableCellSchema>;
export type TableRichText = z.infer<typeof TableRichTextSchema>;
export type TableStyle = z.infer<typeof TableStyleSchema>;
export type BracketObject = z.infer<typeof BracketObjectSchema>;
export type CdxmlBracketAtomSnapshot = z.infer<typeof CdxmlBracketAtomSnapshotSchema>;
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
export type ImageObjectData = z.infer<typeof ImageObjectDataSchema>;
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
