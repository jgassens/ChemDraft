import type { DocumentObject, DocumentPatch } from "@chemdraft/chem-core";
import { z } from "zod";
import {
  boundedRequestJson, PluginRequestLimits as limits, type PluginRequestJson, type RequestCollectionBounds
} from "./requestPayload";
import { PluginToolDefinitionSchema, PluginToolInputValueSchema, PluginToolNameSchema, toolDefinitionBounds } from "./toolSessionSchemas";

const maxIdLength = 256;
const id = z.string().min(1).max(maxIdLength);
const revision = id;
const finite = z.number().finite();
const positive = finite.positive();
const requestId = { requestId: id };
const pageId = { pageId: id };
const objectIds = z.array(id).max(limits.objects);
const point = z.object({ x: finite, y: finite }).strict();
const rect = point.extend({ width: positive, height: positive }).strict();
const inkRect = point.extend({ width: finite.nonnegative(), height: finite.nonnegative() }).strict();
const warnings = z.array(z.string().max(1_000)).max(64);
const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;

const request = <S extends z.ZodTypeAny>(schema: S, bounds?: RequestCollectionBounds) =>
  boundedRequestJson(schema, limits.requestBytes, bounds);

export const PluginRequestErrorSchema = z.object({
  code: z.enum(["unsupported", "invalid", "permission", "missingHandler", "failed",
    "stale", "scope", "chemistry", "cancelled", "limit", "interrupted", "busy", "unavailable"]),
  message: z.string().min(1).max(1_000)
}).strict();
export type PluginRequestError = z.infer<typeof PluginRequestErrorSchema>;
export type PluginRequestFailure = { ok: false; error: PluginRequestError };
export type PluginRequestResult<T> = { ok: true; value: T } | PluginRequestFailure;

export function pluginRequestFailure(code: PluginRequestError["code"], message: string): PluginRequestFailure {
  return { ok: false, error: { code, message } };
}

export function pluginRequestResultSchema<S extends z.ZodTypeAny>(value: S, bounds?: RequestCollectionBounds, omitUndefined = false) {
  return boundedRequestJson(z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), error: PluginRequestErrorSchema }).strict()
  ]), limits.resultBytes, bounds && { fields: { value: bounds } }, omitUndefined);
}

const objectRef = z.object({ ...pageId, objectId: id }).strict();
const objectRevision = objectRef.extend({ revision }).strict();

export const PluginBeginRequestSchema = request(z.object({ label: z.string().trim().min(1).max(200) }).strict());
export const PluginBeginRequestResultSchema = pluginRequestResultSchema(z.object(requestId).strict());
export const PluginRequestIdSchema = request(z.object(requestId).strict());
export const PluginRequestContextResultSchema = pluginRequestResultSchema(z.object({
  ...requestId,
  documentKey: id,
  pages: z.array(z.object({ ...pageId, width: positive, height: positive, revision }).strict()).min(1).max(limits.pages),
  viewport: rect.extend(pageId).strict().optional(),
  selection: z.array(objectRef).max(limits.objects),
  insertions: z.array(objectRef).max(limits.objects),
  objectRevisions: z.array(objectRevision).max(limits.objects * 2)
}).strict());
export const PluginEndRequestResultSchema = pluginRequestResultSchema(
  z.object({ touched: z.array(objectRef).max(limits.objects) }).strict()
);

const graphLimits = {
  atoms: z.array(z.unknown()).max(limits.atomsPerMolecule).optional(),
  bonds: z.array(z.unknown()).max(limits.bondsPerMolecule).optional()
};
const graphBounds = { fields: { atoms: { max: limits.atomsPerMolecule }, bonds: { max: limits.bondsPerMolecule } } };
// Result schemas expose the wire envelope. The desktop validates native fields before transport.
const nativeObjectEnvelope = z.object({
  id,
  type: z.enum(["molecule", "reaction", "reaction-arrow", "mechanism-arrow", "electron-mark", "text", "table",
    "bracket", "graphic", "plus", "group", "annotation", "superatom", "r-group-label", "generic-atom-label",
    "unknown-compatibility-object"]),
  ...point.shape,
  width: finite.nonnegative(),
  height: finite.nonnegative(),
  ...graphLimits
}).passthrough();
const nativeObject = nativeObjectEnvelope.transform(value => value as DocumentObject);
const objectChanges = z.object(graphLimits).passthrough().transform(value => value as Partial<DocumentObject>);
const annotation = nativeObject.refine((value): value is Extract<DocumentObject, { type: "annotation" }> => value.type === "annotation");

export const PluginReadRequestSchema = request(z.object({
  ...requestId, ...pageId, cursor: id.optional(),
  objectIds: z.array(id).min(1).max(limits.readObjects).refine(unique, "Object IDs must be unique.").optional()
}).strict(), { fields: { objectIds: { max: limits.readObjects } } });
export const PluginReadRequestResultSchema = pluginRequestResultSchema(z.object({
  ...pageId,
  revision,
  objects: z.array(z.object({ object: nativeObjectEnvelope, revision }).strict()).max(limits.readObjects),
  nextCursor: id.optional()
}).strict(), { fields: { objects: { max: limits.readObjects, items: { fields: { object: graphBounds } } } } }, true);

const leafPatch = z.discriminatedUnion("op", [
  z.object({ op: z.literal("addObject"), ...pageId, object: nativeObject }).strict(),
  z.object({ op: z.literal("addAnnotation"), ...pageId, annotation }).strict(),
  z.object({ op: z.literal("updateObject"), objectId: id, changes: objectChanges }).strict(),
  z.object({ op: z.literal("removeObject"), objectId: id }).strict(),
  z.object({ op: z.literal("moveObject"), objectId: id, ...point.shape }).strict(),
  z.object({ op: z.literal("setObjectOrder"), ...pageId, objectIds: objectIds.refine(unique, "Object IDs must be unique.") }).strict()
]);
const patch = z.union([leafPatch, z.object({
  op: z.literal("batch"), patches: z.array(leafPatch).min(1).max(limits.patches)
}).strict()]);
const leafPatchFields = {
  object: graphBounds, annotation: graphBounds, changes: graphBounds, objectIds: { max: limits.objects }
};
const patchBounds = { fields: { ...leafPatchFields, patches: { max: limits.patches, items: { fields: leafPatchFields } } } };
export const PluginRequestPatchSchema = request(patch, patchBounds);
/** The ordinary proposal and table APIs also carry bounded JSON when used in a request. */
export const PluginBoundWritePayloadSchema = boundedRequestJson(z.unknown(), limits.requestBytes, undefined, true);
type IsNativePatch<T extends DocumentPatch> = T;
/** The native patch operations accepted by a request, including flat atomic batches. */
export type PluginRequestPatch = IsNativePatch<z.output<typeof patch>>;

export const PluginRequestPreconditionSchema = z.discriminatedUnion("kind", [
  objectRef.extend({ kind: z.literal("objectRevision"), token: revision }).strict(),
  z.object({ kind: z.literal("pageAtLeast"), ...pageId, width: positive, height: positive }).strict()
]);
export type PluginRequestPrecondition = z.infer<typeof PluginRequestPreconditionSchema>;
const insertionIndex = z.number().int().min(0).max(limits.patches - 1);
const smiles = z.string().min(1).max(5_000).refine(value => value.trim().length > 0, "SMILES must not be blank.");
const expectedStructures = z.discriminatedUnion("kind", [
  objectRef.extend({ kind: z.literal("object"), sourceSmiles: smiles }).strict(),
  z.object({ kind: z.literal("insertion"), opIndex: insertionIndex, sourceSmiles: smiles }).strict()
]);

export const PluginApplyRequestPatchSchema = request(z.object({
  ...requestId,
  patch,
  preconditions: z.array(PluginRequestPreconditionSchema).max(limits.patches).optional(),
  expectedStructures: z.array(expectedStructures).max(limits.patches).optional(),
  pageSpace: z.object({ ...pageId, decisionId: id }).strict().optional()
}).strict().superRefine((value, ctx) => {
  const expectations = value.expectedStructures ?? [];
  const keys = expectations.map(item => item.kind === "object" ?
    JSON.stringify([item.pageId, item.objectId]) : String(item.opIndex));
  if (!unique(keys)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Structure expectations must have unique targets." });
  const ops = value.patch.op === "batch" ? value.patch.patches : [value.patch];
  for (const [index, item] of expectations.entries()) {
    if (item.kind === "insertion") {
      const op = ops[item.opIndex];
      if (op?.op !== "addObject" || op.object.type !== "molecule") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["expectedStructures", index],
          message: "An insertion expectation must refer to a molecule addObject operation." });
      }
    }
  }
}), { fields: { patch: patchBounds, preconditions: { max: limits.patches }, expectedStructures: { max: limits.patches } } });
export const PluginApplyRequestPatchResultSchema = pluginRequestResultSchema(z.object({
  touched: z.array(objectRef).max(limits.objects),
  insertions: z.array(objectRevision.extend({ opIndex: insertionIndex }).strict()).max(limits.patches)
}).strict());

export const PluginRequestPageSpaceSchema = request(z.object({
  ...requestId, ...pageId, requiredBounds: rect.refine(({ x, y, width, height }) =>
    Number.isFinite(x + width) && Number.isFinite(y + height) && x + width > x && y + height > y), revision
}).strict());
const pageDecision = { decisionId: id };
export const PluginRequestPageSpaceResultSchema = pluginRequestResultSchema(z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("fits"), ...pageDecision }).strict(),
  z.object({ outcome: z.literal("keep"), ...pageDecision }).strict(),
  z.object({ outcome: z.literal("enlarge"), ...pageDecision }).strict(),
  z.object({ outcome: z.literal("unanswered") }).strict()
]));

export const PluginOpenToolSessionSchema = boundedRequestJson(z.object({
  ...requestId,
  definitions: z.array(PluginToolDefinitionSchema).max(limits.definitions),
  hostTools: z.array(PluginToolNameSchema).max(limits.definitions).optional()
}).strict().superRefine((value, ctx) => {
  const names = [...value.definitions.map(item => item.name), ...(value.hostTools ?? [])];
  if (names.length > limits.definitions) ctx.addIssue({ code: z.ZodIssueCode.custom,
    message: `The session catalog may have at most ${limits.definitions} tools.`, params: { requestCode: "limit" } });
  if (!unique(names)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Session tool names must be unique." });
}), limits.catalogBytes, {
  combined: { fields: ["definitions", "hostTools"], max: limits.definitions },
  fields: { definitions: { items: toolDefinitionBounds } }
});
export const PluginOpenToolSessionResultSchema = pluginRequestResultSchema(z.object({
  sessionId: id, tools: z.array(PluginToolNameSchema).max(limits.definitions).refine(unique)
}).strict());
export const PluginCloseToolSessionSchema = request(z.object({ sessionId: id }).strict());
export const PluginEmptyRequestResultSchema = pluginRequestResultSchema(z.null());
export const PluginToolCallSchema = request(z.object({
  ...requestId, sessionId: id, name: PluginToolNameSchema, input: PluginToolInputValueSchema
}).strict());
export const PluginToolCallResultSchema = pluginRequestResultSchema(z.custom<PluginRequestJson>(value => value !== undefined));

export const PluginActiveDocumentChangedSchema = request(z.object({
  documentKey: id.nullable(), sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict());

const serializedStructure = z.discriminatedUnion("format", [
  z.object({ format: z.literal("smiles"), structure: smiles }).strict(),
  z.object({ format: z.enum(["molfile-v2000", "molfile-v3000"]), structure: z.string().min(1).max(256 * 1024) }).strict()
]);
export const PluginInspectStructureSchema = request(z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("serialized"), source: serializedStructure }).strict(),
  objectRef.extend({ kind: z.literal("molecule"), ...requestId }).strict()
]));
export const PluginInspectStructureResultSchema = pluginRequestResultSchema(z.object({
  source: serializedStructure, canonicalIsomericSmiles: smiles,
  formula: z.string().min(1).max(5_000),
  stereochemistry: z.array(z.string().max(100)).max(limits.atomsPerMolecule + limits.bondsPerMolecule),
  heavyAtoms: z.number().int().min(0).max(limits.heavyAtoms), warnings
}).strict());
export const PluginRingsSchema = request(objectRef.extend({
  ...requestId, representation: z.enum(["chemical", "drawable", "both"]).optional()
}).strict());
const ringMembership = {
  atomIds: z.array(id).min(3).max(limits.atomsPerMolecule).refine(unique),
  bondIds: z.array(id).min(3).max(limits.bondsPerMolecule).refine(unique)
};
// Drawable keys encode the face's bond IDs separated by pipes.
const drawableRingKey = z.string().min(1).max(limits.bondsPerMolecule * (maxIdLength + 1) - 1);
const chemicalRings = z.array(z.object(ringMembership).strict()).max(limits.heavyAtoms);
const drawableRings = z.array(z.object({ key: drawableRingKey, ...ringMembership }).strict()).max(limits.heavyAtoms);
export const PluginRingsResultSchema = pluginRequestResultSchema(z.discriminatedUnion("representation", [
  z.object({ representation: z.literal("chemical"), revision,
    rings: chemicalRings, warnings }).strict(),
  z.object({ representation: z.literal("drawable"), revision,
    rings: drawableRings, warnings }).strict(),
  z.object({ representation: z.literal("both"), revision, chemicalRings, drawableRings, warnings }).strict()
]));

const pagePreview = { ...requestId, ...pageId, preview: patch.optional() };
const target = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("objects"), objectIds: objectIds.min(1).refine(unique) }).strict(),
  z.object({ kind: z.literal("region"), bounds: rect }).strict()
]);
const targetRequestBounds = { fields: { preview: patchBounds, target: { fields: { objectIds: { max: limits.objects } } } } };
export const PluginMeasureDepictionSchema = request(z.object({ ...pagePreview, target }).strict(), targetRequestBounds);
export const PluginMeasureDepictionResultSchema = pluginRequestResultSchema(z.object({
  units: z.literal("document"), bounds: inkRect.nullable(),
  objects: z.array(z.object({
    objectId: id, bounds: inkRect.nullable(),
    labelBounds: inkRect.optional(),
    atomLabels: z.array(z.object({ atomId: id, bounds: inkRect }).strict()).max(limits.atomsPerMolecule).optional(),
    bondLength: z.object({ nominal: positive, measured: positive.nullable() }).strict().optional()
  }).strict()).max(limits.objects),
  unsupported: z.array(z.object({ objectId: id, type: id }).strict()).max(limits.objects),
  warnings
}).strict());

const rasterDimension = z.number().int().positive().max(limits.pngEdge);
const rasterSize = { widthPx: rasterDimension, heightPx: rasterDimension };
const tooManyPixels = ({ widthPx, heightPx }: { widthPx: number; heightPx: number }) => widthPx * heightPx > limits.pngPixels;
const pixelIssue = { code: z.ZodIssueCode.custom, message: "PNG pixel limit exceeded.", params: { requestCode: "limit" } } as const;
export const PluginRenderRegionSchema = request(z.object({
  ...pagePreview, target, ...rasterSize
}).strict().superRefine((value, ctx) => { if (tooManyPixels(value)) ctx.addIssue(pixelIssue); }), targetRequestBounds);

const pngBase64 = z.string().min(32).max(4 * Math.ceil(limits.pngBytes / 3));
export const PluginRenderRegionResultSchema = pluginRequestResultSchema(z.object({
  mimeType: z.literal("image/png"), base64: pngBase64, ...rasterSize, bounds: rect, warnings
}).strict().superRefine(({ base64, widthPx, heightPx }, ctx) => {
  if (tooManyPixels({ widthPx, heightPx })) ctx.addIssue(pixelIssue);
  if (base64.length < 32 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Expected standard base64 PNG data." });
    return;
  }
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  if (base64.length / 4 * 3 - padding > limits.pngBytes) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "PNG byte limit exceeded.", params: { requestCode: "limit" } });
    return;
  }
  const header = atob(base64.slice(0, 32));
  const bytes = new DataView(Uint8Array.from(header, character => character.charCodeAt(0)).buffer);
  if (header.length < 24 || !header.startsWith("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR") ||
      bytes.getUint32(16) !== widthPx || bytes.getUint32(20) !== heightPx) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "PNG signature or dimensions do not match." });
  }
}));

const plannerObjects = z.array(id).min(1).max(limits.readObjects).refine(unique);
const plannerObjectsBounds = { max: limits.readObjects };
const maxConditions = 16;
const conditions = z.array(z.string().max(500)).max(maxConditions);
const localComponentReference = z.object({ ref: id }).strict();
const reactionComponentReference = z.union([id, localComponentReference]);
const reactionComponent = z.union([id, localComponentReference.extend({ smiles }), localComponentReference]);
const reactionComponents = z.array(reactionComponent).min(1).max(limits.readObjects);
const compoundLabel = z.string().trim().min(1).max(80).refine(text => !/[\r\n]/.test(text));
const reactionStep = z.object({
  reactants: reactionComponents, products: reactionComponents,
  agents: objectIds.max(limits.readObjects).refine(unique).optional(), above: conditions.optional(), below: conditions.optional(),
  arrowKind: z.enum(["forward", "resonance", "equilibrium", "retrosynthesis"]),
  compoundNumbers: z.array(z.object({ component: reactionComponentReference, text: compoundLabel }).strict())
    .max(limits.readObjects).optional()
}).strict();
const stepBounds = { fields: {
  reactants: plannerObjectsBounds, products: plannerObjectsBounds, agents: plannerObjectsBounds,
  compoundNumbers: plannerObjectsBounds, above: { max: maxConditions }, below: { max: maxConditions }
} };
const flowOptions = { anchor: point, gap: finite.nonnegative().optional(), wrapWidth: positive.optional() };
const maxSteps = 16;
export const PluginPlanLayoutSchema = request(z.object({
  ...pagePreview,
  spec: z.discriminatedUnion("kind", [
    reactionStep.extend({ kind: z.literal("reaction"), anchor: point, bondLength: positive.optional() }),
    z.object({ kind: z.literal("grid"), objectIds: plannerObjects, ...flowOptions,
      columns: z.number().int().min(1).max(limits.readObjects).optional(),
      columnGap: finite.nonnegative().optional(), rowGap: finite.nonnegative().optional() }).strict(),
    z.object({ kind: z.literal("row"), objectIds: plannerObjects, ...flowOptions }).strict(),
    z.object({ kind: z.literal("reactionRows"), steps: z.array(reactionStep).min(1).max(maxSteps),
      anchor: point, bondLength: positive.optional(), maxWidth: positive, gap: finite.nonnegative().optional(),
      breakBefore: z.array(z.number().int().min(1).max(maxSteps - 1)).max(maxSteps - 1).refine(unique).optional()
    }).strict()
  ])
}).strict(), { fields: { preview: patchBounds, spec: { fields: {
  ...stepBounds.fields, objectIds: plannerObjectsBounds, steps: { max: maxSteps, items: stepBounds },
  breakBefore: { max: maxSteps - 1 }
} } } });
export const PluginPlanLayoutResultSchema = pluginRequestResultSchema(z.object({
  // Native object IDs are local insertion references. Commit by addObject in one batch.
  objects: z.array(nativeObject).max(limits.objects),
  transforms: z.array(z.object({ objectId: id, dx: finite, dy: finite,
    changes: objectChanges }).strict()).max(limits.objects),
  insertionSources: z.array(z.object({ ref: id, objectId: id, sourceSmiles: smiles }).strict()).max(limits.readObjects).optional(),
  warnings
}).strict(), { fields: { objects: { max: limits.objects, items: graphBounds },
  transforms: { max: limits.objects, items: { fields: { changes: graphBounds } } } } }, true);

export const PluginListStylePresetsSchema = PluginRequestIdSchema;
export const PluginListStylePresetsResultSchema = pluginRequestResultSchema(z.object({
  presets: z.array(z.object({ id, name: z.string().min(1).max(200),
    bondLengthPx: positive, bondStrokeWidthPx: positive, bondBoldWidthPx: positive,
    atomLabelFontFamily: z.string().min(1).max(200), atomLabelFontSizePx: positive, atomLabelFontWeight: positive
  }).strict()).max(32),
  defaults: z.object({
    drawing: z.record(z.custom<PluginRequestJson>()),
    text: z.record(z.custom<PluginRequestJson>())
  }).strict()
}).strict());
export const PluginPlanStyleSchema = request(z.object({
  ...pagePreview, objectIds: plannerObjects, presetId: id.optional(), targetBondLength: positive.optional()
}).strict().refine(value => value.presetId !== undefined || value.targetBondLength !== undefined,
  "A style plan needs a preset or a target bond length."), { fields: { preview: patchBounds, objectIds: plannerObjectsBounds } });
export const PluginPlanStyleResultSchema = pluginRequestResultSchema(z.object({
  updates: z.array(z.object({ op: z.literal("updateObject"), objectId: id, changes: objectChanges }).strict()).max(limits.objects),
  affectedObjectIds: objectIds.refine(unique), movedMarkIds: objectIds.refine(unique), warnings
}).strict(), { fields: { updates: { max: limits.objects, items: { fields: { changes: graphBounds } } } } }, true);
