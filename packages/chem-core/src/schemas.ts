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
    element: z.string().min(1),
    x: z.number().finite(),
    y: z.number().finite(),
    formalCharge: z.number().int().default(0),
    labelVisible: z.boolean().optional()
  })
  .strict();

export const MoleculeBondDisplaySchema = z
  .object({
    doubleBondSide: z.enum(["left", "right"]).optional(),
    bondStyle: z.enum(["bold", "wedge", "hashed", "dashed"]).optional()
  })
  .strict();

export const MoleculeBondSchema = z
  .object({
    id: IdSchema,
    fromAtomId: IdSchema,
    toAtomId: IdSchema,
    order: z.enum(["single", "double", "triple", "aromatic", "unknown"]).default("single"),
    display: MoleculeBondDisplaySchema.optional()
  })
  .strict();

export const MoleculeTransformStateSchema = z
  .object({
    scaleX: z.number().finite().positive().default(1),
    scaleY: z.number().finite().positive().default(1),
    rotationDegrees: z.number().finite().default(0)
  })
  .strict();

export const MoleculeObjectSchema = BaseObjectSchema.extend({
  type: z.literal("molecule"),
  structureFormat: z.enum(["molfile-v3000", "molfile-v2000", "smiles", "unknown"]),
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
  mappingState: z.enum(["absent", "partial", "complete", "unknown"]).default("unknown")
}).strict();

export const ArrowObjectSchema = BaseObjectSchema.extend({
  type: z.literal("reaction-arrow"),
  arrowKind: z.enum(["forward", "equilibrium", "retrosynthesis", "unknown"]),
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
  bracketKind: z.enum(["square", "round", "curly", "polymer", "unknown"]),
  label: z.string().optional(),
  containedObjectIds: z.array(IdSchema).default([])
}).strict();

export const GraphicObjectSchema = BaseObjectSchema.extend({
  type: z.literal("graphic"),
  graphicKind: z.enum(["line", "rect", "ellipse", "path", "image", "unknown"]),
  data: MetadataSchema.default({})
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
    objects: z.array(DocumentObjectSchema)
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
