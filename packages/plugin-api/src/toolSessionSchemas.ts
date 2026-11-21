import { z } from "zod";
import {
  boundedRequestJson, PluginRequestLimits, type PluginRequestJson, type PluginRequestJsonObject, type RequestCollectionBounds
} from "./requestPayload";

export const PluginToolNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const description = z.string().max(1_000);

export type PluginToolInputSchema =
  | ({ type: "object"; properties?: Record<string, PluginToolInputSchema>; required?: string[]; additionalProperties?: boolean } & SchemaAnnotations)
  | ({ type: "array"; items: PluginToolInputSchema; minItems?: number; maxItems?: number } & SchemaAnnotations)
  | ({ type: "string"; minLength?: number; maxLength?: number } & SchemaAnnotations)
  | ({ type: "number" | "integer"; minimum?: number; maximum?: number } & SchemaAnnotations)
  | ({ type: "boolean" | "null" } & SchemaAnnotations);

interface SchemaAnnotations { description?: string; enum?: PluginRequestJson[] }

const maxSchemaList = 128;
const toolInputSchemaBounds: RequestCollectionBounds = { fields: {
  enum: { max: maxSchemaList },
  required: { max: maxSchemaList },
  items: { get fields() { return toolInputSchemaBounds.fields; } },
  properties: { get additionalFields() { return toolInputSchemaBounds; } }
} };
export const toolDefinitionBounds = { fields: { inputSchema: toolInputSchemaBounds } };

const annotationFields = {
  description: description.optional(),
  enum: z.array(z.custom<PluginRequestJson>()).min(1).max(maxSchemaList).optional()
};
const nonNegative = z.number().int().min(0).max(PluginRequestLimits.requestBytes);
const objectSchema = z.object({
  type: z.literal("object"),
  properties: z.record(z.string().min(1).max(256), z.lazy(() => toolInputSchema)).optional(),
  required: z.array(z.string().min(1).max(256)).max(maxSchemaList).optional(),
  additionalProperties: z.boolean().optional(),
  ...annotationFields
}).strict();

const toolInputSchema: z.ZodType<PluginToolInputSchema> = z.discriminatedUnion("type", [
  objectSchema,
  z.object({ type: z.literal("array"), items: z.lazy(() => toolInputSchema), minItems: nonNegative.optional(),
    maxItems: nonNegative.optional(), ...annotationFields }).strict(),
  z.object({ type: z.literal("string"), minLength: nonNegative.optional(), maxLength: nonNegative.optional(), ...annotationFields }).strict(),
  z.object({ type: z.enum(["number", "integer"]), minimum: z.number().finite().optional(),
    maximum: z.number().finite().optional(), ...annotationFields }).strict(),
  z.object({ type: z.enum(["boolean", "null"]), ...annotationFields }).strict()
]).superRefine((schema, ctx) => {
  const invalid = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (schema.type === "object") {
    if ((schema.required ?? []).some(key => !Object.hasOwn(schema.properties ?? {}, key))) {
      invalid("Every required property must be declared in properties.");
    }
    if (new Set(schema.required).size !== (schema.required?.length ?? 0)) invalid("Required properties must be unique.");
  }
  const bounds: [number | undefined, number | undefined] =
    schema.type === "array" ? [schema.minItems, schema.maxItems] :
    schema.type === "string" ? [schema.minLength, schema.maxLength] :
    schema.type === "number" || schema.type === "integer" ? [schema.minimum, schema.maximum] : [undefined, undefined];
  if (bounds[0] !== undefined && bounds[1] !== undefined && bounds[0] > bounds[1]) invalid("Minimum exceeds maximum.");
});

export interface PluginToolDefinition {
  /** Restricts this invocation even when the plugin has document.write. */
  readOnly?: boolean;
  name: string;
  description: string;
  inputSchema: Extract<PluginToolInputSchema, { type: "object" }>;
}

export const PluginToolDefinitionSchema: z.ZodType<PluginToolDefinition, z.ZodTypeDef, unknown> = boundedRequestJson(z.object({
  name: PluginToolNameSchema,
  readOnly: z.boolean().optional(),
  description,
  inputSchema: boundedRequestJson(
    toolInputSchema.refine((schema): schema is Extract<PluginToolInputSchema, { type: "object" }> => schema.type === "object",
      "A tool input schema must describe an object."),
    PluginRequestLimits.schemaBytes, toolInputSchemaBounds
  )
}).strict(), PluginRequestLimits.catalogBytes, toolDefinitionBounds);

export const PluginToolInputValueSchema = z.custom<PluginRequestJsonObject>(value =>
  value !== null && typeof value === "object" && !Array.isArray(value), "Expected a JSON object.");
