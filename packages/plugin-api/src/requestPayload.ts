import { z } from "zod";

export type PluginRequestJson = null | boolean | number | string | PluginRequestJson[] | PluginRequestJsonObject;
export interface PluginRequestJsonObject { [key: string]: PluginRequestJson }

export const PluginRequestLimits = {
  requestBytes: 1024 * 1024,
  resultBytes: 8 * 1024 * 1024,
  catalogBytes: 128 * 1024,
  schemaBytes: 16 * 1024,
  jsonDepth: 32,
  jsonNodes: 250_000,
  objectFields: 1_024,
  definitions: 32,
  pages: 256,
  readObjects: 64,
  objects: 256,
  patches: 256,
  heavyAtoms: 500,
  atomsPerMolecule: 2_500,
  bondsPerMolecule: 5_000,
  pngBytes: 2 * 1024 * 1024,
  pngEdge: 4_096,
  pngPixels: 4_194_304,
  pendingCapabilities: 16,
  pendingToolCalls: 4
} as const;

const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
const encoder = new TextEncoder();

class PayloadError extends Error {
  constructor(readonly code: "invalid" | "limit", message: string) { super(message); }
}

export interface RequestCollectionBounds {
  max?: number;
  fields?: Readonly<Record<string, RequestCollectionBounds>>;
  additionalFields?: RequestCollectionBounds;
  items?: RequestCollectionBounds;
  combined?: { fields: readonly string[]; max: number };
}

/** Detach and bound data before a schema copies or recurses into it. */
function snapshotJson(raw: unknown, maxBytes: number, bounds?: RequestCollectionBounds, omitUndefined = false): PluginRequestJson {
  let remaining = maxBytes;
  let nodes = 0;
  const ancestors = new Set<object>();
  const invalid = (message: string): never => { throw new PayloadError("invalid", message); };
  const limit = (message: string): never => { throw new PayloadError("limit", message); };
  const charge = (bytes: number) => {
    remaining -= bytes;
    if (remaining < 0) limit(`JSON exceeds ${maxBytes} UTF-8 bytes.`);
  };
  const chargeString = (value: string) => {
    if (value.length + 2 > remaining) limit(`JSON exceeds ${maxBytes} UTF-8 bytes.`);
    charge(encoder.encode(JSON.stringify(value)).length);
  };
  const dataField = (value: object, key: PropertyKey): unknown => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field?.enumerable && "value" in field ? field.value : invalid("Expected enumerable JSON data.");
  };
  const arrayLength = (value: unknown[]): number => {
    const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
    return typeof length === "number" && Number.isInteger(length) && length >= 0 && length <= 0xffffffff
      ? length : invalid("Invalid JSON array length.");
  };
  const checkCount = (length: number, max: number | undefined) => {
    if (max !== undefined && length > max) limit(`JSON collection exceeds ${max} entries.`);
  };
  const visit = (value: unknown, depth: number, rule?: RequestCollectionBounds, checkedLength?: number): PluginRequestJson => {
    if (depth > PluginRequestLimits.jsonDepth) limit("JSON nesting is too deep.");
    if (++nodes > PluginRequestLimits.jsonNodes) limit("JSON contains too many values.");
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      charge(String(value).length);
      return value;
    }
    if (typeof value === "string") {
      chargeString(value);
      return value;
    }
    if (typeof value !== "object" || ancestors.has(value)) return invalid("Expected finite, acyclic JSON data.");
    ancestors.add(value);
    const proto = Object.getPrototypeOf(value);
    let copy: PluginRequestJson;
    if (Array.isArray(value)) {
      if (proto !== Array.prototype) return invalid("Expected a plain JSON array.");
      const length = checkedLength ?? arrayLength(value);
      checkCount(length, rule?.max);
      charge(2 + Math.max(0, length - 1));
      if (length > PluginRequestLimits.jsonNodes - nodes) limit("JSON contains too many values.");
      if (Reflect.ownKeys(value).length !== length + 1) return invalid("Expected a dense JSON array.");
      copy = Array.from({ length }, (_, index) => visit(dataField(value, index), depth + 1, rule?.items));
    } else {
      if (proto !== Object.prototype && proto !== null) return invalid("Expected a plain JSON object.");
      const keys = Reflect.ownKeys(value);
      if (keys.length > PluginRequestLimits.objectFields) limit("JSON object contains too many fields.");
      charge(2 + Math.max(0, keys.length - 1));
      const record: PluginRequestJsonObject = {};
      // Check the aggregate before copying any of its member arrays. Reuse the captured fields
      // and lengths for copying so a proxy cannot change the values after the check.
      const combined = rule?.combined;
      const members = combined && new Map<string, { value: unknown[]; length: number }>();
      let count = 0;
      if (combined && members) {
        for (const key of combined.fields) {
          if (!keys.includes(key)) continue;
          const field = dataField(value, key);
          if (!Array.isArray(field)) return invalid("Expected a JSON array.");
          const length = arrayLength(field);
          count += length;
          checkCount(count, combined.max);
          members.set(key, { value: field, length });
        }
      }
      for (const key of keys) {
        if (typeof key !== "string" || forbiddenKeys.has(key)) return invalid("Invalid JSON object key.");
        const member = members?.get(key);
        const field = member ? member.value : dataField(value, key);
        if (omitUndefined && field === undefined) continue;
        chargeString(key);
        charge(1);
        const fieldRule = rule?.fields && Object.hasOwn(rule.fields, key) ? rule.fields[key] : rule?.additionalFields;
        record[key] = visit(field, depth + 1, fieldRule, member?.length);
      }
      copy = record;
    }
    ancestors.delete(value);
    return copy;
  };
  return visit(raw, 0, bounds);
}

export function boundedRequestJson<Schema extends z.ZodTypeAny>(
  schema: Schema, maxBytes: number, bounds?: RequestCollectionBounds, omitUndefined = false
): z.ZodType<z.output<Schema>, z.ZodTypeDef, unknown> {
  const snapshot = (raw: unknown) => {
    try {
      return { ok: true as const, value: snapshotJson(raw, maxBytes, bounds, omitUndefined) };
    } catch (error) {
      return { ok: false as const,
        failure: error instanceof PayloadError ? error : new PayloadError("invalid", "Expected plain JSON data.") };
    }
  };
  const checked = z.custom<ReturnType<typeof snapshot>>().transform((value, ctx) => {
    if (value.ok) return value.value;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: value.failure.message,
      params: { requestCode: value.failure.code } });
    return z.NEVER;
  }).pipe(schema);

  // Zod checks for then/catch when it enters a parse. Inspect descriptors before that check.
  class BoundedRequestJsonSchema extends z.ZodType<z.output<Schema>, z.ZodTypeDef, unknown> {
    _parse(input: z.ParseInput): z.ParseReturnType<this["_output"]> {
      return checked._parse({ data: snapshot(input.data), parent: input.parent, path: input.path });
    }

    safeParse(value: unknown, params?: Partial<z.ParseParams>): z.SafeParseReturnType<unknown, this["_output"]> {
      return checked.safeParse(snapshot(value), params);
    }

    safeParseAsync(value: unknown, params?: Partial<z.ParseParams>): Promise<z.SafeParseReturnType<unknown, this["_output"]>> {
      return checked.safeParseAsync(snapshot(value), params);
    }

    ["~validate"](value: unknown): ReturnType<z.ZodType<this["_output"]>["~validate"]> {
      return checked["~validate"](snapshot(value));
    }
  }

  return new BoundedRequestJsonSchema({});
}

export function requestValidationCode(error: z.ZodError): "invalid" | "limit" {
  return error.issues.some(issue => issue.code === "too_big" ||
    (issue.code === "custom" && issue.params?.requestCode === "limit")) ? "limit" : "invalid";
}
