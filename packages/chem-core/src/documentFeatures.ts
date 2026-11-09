import { z } from "zod";
import type { ChemDraftDocument } from "./schemas";
import { compareNativeVersions, isNativeRecord, nativeExtensionTarget, ownNativeValue } from "./nativeCompatibilityState";

export const NativeDocumentBaselineAppVersion = "1.1.1";
export const NativeDocumentFormatVersion = "1.2.0";
export const NativeDocumentReaderVersion = "1.2.0";

export interface NativeDocumentFeatureVersion {
  introducedIn: string;
  kind: "feature" | "envelope" | "internal";
  /** Open metadata keys/values have no Zod field/enum to inventory; they still need version rules. */
  schemaTracked?: false;
}

/**
 * The single registry of schema additions since v1.1.1. Keys are schema inventory tokens.
 * Add every new field and enum/literal value here, including children of new object types.
 * Envelope/internal state does not itself raise the minimum application version.
 * There are currently no drawing-schema differences from the released v1.1.1 baseline.
 */
export const NativeDocumentFeatureVersions: Readonly<Record<string, NativeDocumentFeatureVersion>> = {
  "field:formatVersion": { introducedIn: "1.2.0", kind: "envelope" },
  "field:minAppVersion": { introducedIn: "1.2.0", kind: "envelope" },
  "field:compatibility.nativeExtensions": { introducedIn: "1.2.0", kind: "internal" },
  "field:compatibility.nativeExtensions.*.path": { introducedIn: "1.2.0", kind: "internal" },
  "field:compatibility.nativeExtensions.*.path.*.id": { introducedIn: "1.2.0", kind: "internal" },
  "field:compatibility.nativeExtensions.*.kind": { introducedIn: "1.2.0", kind: "internal" },
  'value:compatibility.nativeExtensions.*.kind="field"': { introducedIn: "1.2.0", kind: "internal" },
  'value:compatibility.nativeExtensions.*.kind="enum"': { introducedIn: "1.2.0", kind: "internal" },
  "field:compatibility.nativeExtensions.*.originalValue": { introducedIn: "1.2.0", kind: "internal" },
  "field:compatibility.nativeExtensions.*.fallbackValue": { introducedIn: "1.2.0", kind: "internal" }
};

/** Schema inspection shared by the registry guard and usage detection; no validation is weakened. */
export function nativeSchemaInventory(schema: z.ZodTypeAny): Set<string> {
  const tokens = new Set<string>();
  visitNativeSchema(schema, undefined, [], (token) => tokens.add(token));
  return tokens;
}

export function minimumAppVersionForDocument(document: ChemDraftDocument): string {
  let minimum = minimumVersionForRegisteredFeatures(document, NativeDocumentFeatureVersions);
  const extensions = document.compatibility.nativeExtensions;
  if (extensions?.length) {
    const compatibility = { ...document.compatibility };
    delete compatibility.nativeExtensions;
    const activeModel = { ...document, compatibility };
    if (extensions.some((extension) => nativeExtensionTarget(activeModel, extension))) {
      const sourceMinimum = document.minAppVersion && compareNativeVersions(document.minAppVersion, NativeDocumentBaselineAppVersion) > 0
        ? document.minAppVersion : document.formatVersion ?? NativeDocumentFormatVersion;
      if (compareNativeVersions(sourceMinimum, minimum) > 0) minimum = sourceMinimum;
      if (compareNativeVersions(minimum, NativeDocumentBaselineAppVersion) <= 0) minimum = NativeDocumentFormatVersion;
    }
  }
  return minimum;
}

// Saves inspect only registered additions, rather than walking every atom through the entire Zod
// schema again. With no post-baseline drawing features this is constant work, even for large files.
function minimumVersionForRegisteredFeatures(
  value: unknown,
  registry: Readonly<Record<string, NativeDocumentFeatureVersion>>
): string {
  let minimum = NativeDocumentBaselineAppVersion;
  for (const [token, feature] of Object.entries(registry)) {
    if (feature.kind !== "feature") continue;
    // Discriminator paths contain '=' too; enum values can themselves contain '=' or '.'.
    const equals = token.startsWith("field:") ? -1 : enumValueDelimiter(token);
    const path = token.startsWith("field:") ? token.slice(6) : token.slice(6, equals);
    let values = [value];
    for (const segment of path.split(".")) {
      const match = /^(.*?)(?:\[([^=]+)=(.*)\])?$/.exec(segment)!;
      const [, key, discriminator, variant] = match;
      values = values.flatMap((item) => key === "*" ? Array.isArray(item) ? item : [] : [ownNativeValue(item, key!)])
        .filter((item) => item !== undefined && (!discriminator || ownNativeValue(item, discriminator) === variant));
    }
    const used = token.startsWith("field:") ? values.length > 0 : values.some((item) => JSON.stringify(item) === token.slice(equals + 1));
    if (used && compareNativeVersions(feature.introducedIn, minimum) > 0) minimum = feature.introducedIn;
  }
  return minimum;
}

function enumValueDelimiter(token: string): number {
  let brackets = 0;
  for (let index = 6; index < token.length; index += 1) {
    if (token[index] === "[") brackets += 1;
    else if (token[index] === "]") brackets -= 1;
    else if (token[index] === "=" && brackets === 0) return index;
  }
  throw new Error(`Invalid native enum feature token: ${token}`);
}

export function minimumVersionForNativeFeatures(
  schema: z.ZodTypeAny,
  value: unknown,
  registry: Readonly<Record<string, NativeDocumentFeatureVersion>>
): string {
  const inventory = nativeSchemaInventory(schema);
  for (const token of Object.keys(registry)) {
    if (registry[token]!.schemaTracked !== false && !inventory.has(token)) {
      throw new Error(`Native feature registry entry is absent from the schema: ${token}`);
    }
  }
  return minimumVersionForRegisteredFeatures(value, registry);
}

function visitNativeSchema(
  schema: z.ZodTypeAny,
  value: unknown,
  path: string[],
  visit: (token: string, used: boolean) => void
): void {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    visitNativeSchema(schema.unwrap(), value, path, visit);
  } else if (schema instanceof z.ZodDefault || schema instanceof z.ZodCatch) {
    visitNativeSchema(schema._def.innerType, value, path, visit);
  } else if (schema instanceof z.ZodEffects) {
    visitNativeSchema(schema.innerType(), value, path, visit);
  } else if (schema instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(schema.shape) as [string, z.ZodTypeAny][]) {
      const childPath = [...path, key];
      visit(`field:${childPath.join(".")}`, isNativeRecord(value) && Object.hasOwn(value, key)
        && ownNativeValue(value, key) !== undefined);
      visitNativeSchema(child, ownNativeValue(value, key), childPath, visit);
    }
  } else if (schema instanceof z.ZodArray) {
    // Visit absent/empty arrays once as well, so the inventory includes their element shape.
    for (const item of Array.isArray(value) && value.length ? value : [undefined]) {
      visitNativeSchema(schema.element, item, [...path, "*"], visit);
    }
  } else if (schema instanceof z.ZodDiscriminatedUnion) {
    for (const option of schema.options as z.ZodObject<z.ZodRawShape>[]) {
      const discriminator = option.shape[schema.discriminator] as z.ZodLiteral<string>;
      const branchPath = [...path];
      branchPath[branchPath.length - 1] += `[${schema.discriminator}=${discriminator.value}]`;
      visitNativeSchema(option, ownNativeValue(value, schema.discriminator) === discriminator.value ? value : undefined,
        branchPath, visit);
    }
  } else if (schema instanceof z.ZodUnion) {
    for (const option of schema.options as z.ZodTypeAny[]) visitNativeSchema(option, value, path, visit);
  } else if (schema instanceof z.ZodTuple) {
    schema.items.forEach((item: z.ZodTypeAny, index: number) => {
      visitNativeSchema(item, ownNativeValue(value, index), [...path, String(index)], visit);
    });
  } else if (schema instanceof z.ZodRecord) {
    visitNativeSchema(schema.valueSchema, undefined, [...path, "*"], visit);
  } else if (schema instanceof z.ZodLazy) {
    visitNativeSchema(schema.schema, value, path, visit);
  } else if (schema instanceof z.ZodIntersection) {
    visitNativeSchema(schema._def.left, value, path, visit);
    visitNativeSchema(schema._def.right, value, path, visit);
  } else if (schema instanceof z.ZodPipeline) {
    visitNativeSchema(schema._def.in, value, path, visit);
    visitNativeSchema(schema._def.out, value, path, visit);
  } else if (schema instanceof z.ZodBranded || schema instanceof z.ZodReadonly) {
    visitNativeSchema(schema.unwrap(), value, path, visit);
  } else if (schema instanceof z.ZodEnum || schema instanceof z.ZodLiteral || schema instanceof z.ZodNativeEnum) {
    const values: unknown[] = schema instanceof z.ZodEnum ? schema.options
      : schema instanceof z.ZodNativeEnum ? Object.values(schema.enum) : [schema.value];
    for (const option of values) visit(`value:${path.join(".")}=${JSON.stringify(option)}`, value === option);
  }
}
