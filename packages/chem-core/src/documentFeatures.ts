import { z } from "zod";
import type { ChemDraftDocument } from "./schemas";
import { nativeFieldPatternValues } from "./nativeFieldPatterns";
import { compareNativeVersions, isNativeRecord, nativeExtensionTarget, ownNativeValue } from "./nativeCompatibilityState";

export const NativeDocumentBaselineAppVersion = "1.1.1";
export const NativeDocumentFormatVersion = "1.2.0";
export const NativeDocumentReaderVersion = "1.2.0";

export interface NativeDocumentFeatureVersion {
  introducedIn: string;
  kind: "feature" | "envelope" | "internal";
  /** True only for display-only additions; false for chemistry, envelope and internal state. */
  ignorable: boolean;
  /** Open metadata keys/values have no Zod field/enum to inventory; they still need version rules. */
  schemaTracked?: false;
  /** A newly typed field that the released reader already preserves in open metadata. */
  preservedByBaseline?: true;
}

/**
 * The single registry of schema additions since v1.1.1. Keys are schema inventory tokens.
 * Add every new field and enum/literal value here, including children of new object types.
 * Envelope/internal state does not itself raise the minimum application version.
 * Drawing features introduced in 1.2 raise the minimum only when used. Newly typed metadata
 * already preserved by the baseline reader does not require newer application support.
 * The released strict 1.1.1 reader rejects versioned files; a forward-capable older reader
 * may omit display-only fields while preserving them for re-save. Chemistry and relations
 * are never declared safe to ignore.
 */
export const NativeDocumentFeatureVersions: Readonly<Record<string, NativeDocumentFeatureVersion>> = {
  "field:formatVersion": { introducedIn: "1.2.0", kind: "envelope", ignorable: false },
  "field:minAppVersion": { introducedIn: "1.2.0", kind: "envelope", ignorable: false },
  "field:ignorableFields": { introducedIn: "1.2.0", kind: "envelope", ignorable: false },
  "field:compatibility.nativeExtensions": { introducedIn: "1.2.0", kind: "internal", ignorable: false },
  "field:compatibility.nativeExtensions.*.path": { introducedIn: "1.2.0", kind: "internal", ignorable: false },
  "field:compatibility.nativeExtensions.*.path.*.id": { introducedIn: "1.2.0", kind: "internal", ignorable: false },
  "field:compatibility.nativeExtensions.*.path.*.index": { introducedIn: "1.2.0", kind: "internal", ignorable: false },
  "field:compatibility.nativeExtensions.*.path.*.tableColumnIds": { introducedIn: "1.2.0", kind: "internal", ignorable: false },
  "field:compatibility.nativeExtensions.*.path.*.arrayFingerprint": { introducedIn: "1.2.0", kind: "internal", ignorable: false },
  "field:compatibility.nativeExtensions.*.path.*.arrayFingerprint.length": { introducedIn: "1.2.0", kind: "internal", ignorable: false },
  "field:compatibility.nativeExtensions.*.path.*.arrayFingerprint.hashes": { introducedIn: "1.2.0", kind: "internal", ignorable: false },
  "field:compatibility.nativeExtensions.*.path.*.arrayFingerprint.contents": { introducedIn: "1.2.0", kind: "internal", ignorable: false },
  "field:compatibility.nativeExtensions.*.kind": { introducedIn: "1.2.0", kind: "internal", ignorable: false },
  'value:compatibility.nativeExtensions.*.kind="field"': { introducedIn: "1.2.0", kind: "internal", ignorable: false },
  'value:compatibility.nativeExtensions.*.kind="enum"': { introducedIn: "1.2.0", kind: "internal", ignorable: false },
  "field:compatibility.nativeExtensions.*.originalValue": { introducedIn: "1.2.0", kind: "internal", ignorable: false },
  "field:compatibility.nativeExtensions.*.fallbackValue": { introducedIn: "1.2.0", kind: "internal", ignorable: false },

  // #339: the released page and superatom schemas are strict. Neither page print/source
  // setup nor live expansion membership survives that reader; both carry document meaning.
  "field:pages.*.compatibility": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.compatibility.sourceFormat": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.compatibility.originalId": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.compatibility.warnings": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.compatibility.warnings.*.code": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.compatibility.warnings.*.message": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.compatibility.warnings.*.objectId": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.compatibility.unknown": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=molecule].superatoms.*.atomIds": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=superatom].metadata.atomIds": { introducedIn: "1.2.0", kind: "feature", ignorable: false },

  // #327: a wavy single bond explicitly leaves fromAtomId's stereochemistry unknown.
  // Dropping it would lose chemical meaning even though it lives in the display container.
  'value:pages.*.objects.*[type=molecule].bonds.*.display.bondStyle="wavy"': { introducedIn: "1.2.0", kind: "feature", ignorable: false },

  // #335: scheme steps refer to shared drawables rather than owning duplicate objects.
  "field:pages.*.objects.*[type=reaction].arrowObjectIds": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=reaction].plusObjectIds": { introducedIn: "1.2.0", kind: "feature", ignorable: false },

  // #338: bracket pairing, group usage, counts and crossing references carry document or
  // chemical meaning, including an opaque future usage. No part of these relations may be
  // declared safe for a reader to omit; preserving an unknown usage does not make it ignorable.
  "field:pages.*.objects.*[type=bracket].side": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  'value:pages.*.objects.*[type=bracket].side="open"': { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  'value:pages.*.objects.*[type=bracket].side="close"': { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=bracket].pairId": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=bracket].repeatUnit": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=bracket].bracketUsage": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  'value:pages.*.objects.*[type=bracket].bracketUsage="sru"': { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  'value:pages.*.objects.*[type=bracket].bracketUsage="multiple"': { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  'value:pages.*.objects.*[type=bracket].bracketUsage="generic"': { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  'value:pages.*.objects.*[type=bracket].bracketUsage="unknown"': { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=bracket].repeatCount": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=bracket].crossingBondIds": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=bracket].crossingBondIds.*.objectId": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=bracket].crossingBondIds.*.bondId": { introducedIn: "1.2.0", kind: "feature", ignorable: false },

  // #322 typed preset metadata that 1.1.1 already preserves in its open style records.
  // Only graphics had a strict style schema: their new preset field really requires 1.2.
  // Keep every addition inventoried without mistaking stricter validation for a new wire feature.
  "field:pages.*.objects.*[type=annotation].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },
  "field:pages.*.objects.*[type=bracket].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },
  "field:pages.*.objects.*[type=electron-mark].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },
  "field:pages.*.objects.*[type=generic-atom-label].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },
  "field:pages.*.objects.*[type=graphic].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true },
  "field:pages.*.objects.*[type=group].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },
  "field:pages.*.objects.*[type=mechanism-arrow].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },
  "field:pages.*.objects.*[type=molecule].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },
  "field:pages.*.objects.*[type=plus].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },
  "field:pages.*.objects.*[type=r-group-label].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },
  "field:pages.*.objects.*[type=reaction-arrow].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },
  "field:pages.*.objects.*[type=reaction].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },
  "field:pages.*.objects.*[type=superatom].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },
  "field:pages.*.objects.*[type=table].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },
  "field:pages.*.objects.*[type=text].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },
  "field:pages.*.objects.*[type=unknown-compatibility-object].style.stylePresetId": { introducedIn: "1.2.0", kind: "feature", ignorable: true, preservedByBaseline: true },

  // #332: graphic wave geometry is display-only. Older forward readers may show the legacy
  // waveform while retaining the smoothness, peak-to-trough height and wavelength for re-save.
  "field:pages.*.objects.*[type=graphic].data.waveSmoothness": { introducedIn: "1.2.0", kind: "feature", ignorable: true },
  "field:pages.*.objects.*[type=graphic].data.waveHeight": { introducedIn: "1.2.0", kind: "feature", ignorable: true },
  "field:pages.*.objects.*[type=graphic].data.waveWidth": { introducedIn: "1.2.0", kind: "feature", ignorable: true },

  // #333: an explicit electron-mark association controls which atom carries charge/radicals,
  // even outside the proximity radius. Ignoring it can change chemistry; require support.
  "field:pages.*.objects.*[type=electron-mark].atomAssociation": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  'value:pages.*.objects.*[type=electron-mark].atomAssociation="explicit"': { introducedIn: "1.2.0", kind: "feature", ignorable: false },

  // #331: conditions text belongs to a particular reaction arrow. The relation, side and
  // local placement frame govern coupled edits; omitting any part loses document meaning.
  // These fields and values require support rather than an ignorable display fallback.
  "field:pages.*.objects.*[type=text].arrowAttachment": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.kind": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  'value:pages.*.objects.*[type=text].arrowAttachment.kind="conditions"': { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.parentObjectId": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.side": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  'value:pages.*.objects.*[type=text].arrowAttachment.side="above"': { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  'value:pages.*.objects.*[type=text].arrowAttachment.side="below"': { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.frame": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.frame.origin": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.frame.origin.x": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.frame.origin.y": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.frame.tangent": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.frame.tangent.x": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.frame.tangent.y": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.frame.normal": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.frame.normal.x": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.frame.normal.y": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.frame.length": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.offset": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.offset.x": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.offset.y": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  "field:pages.*.objects.*[type=text].arrowAttachment.placement": { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  'value:pages.*.objects.*[type=text].arrowAttachment.placement="auto"': { introducedIn: "1.2.0", kind: "feature", ignorable: false },
  'value:pages.*.objects.*[type=text].arrowAttachment.placement="manual"': { introducedIn: "1.2.0", kind: "feature", ignorable: false }
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
// schema again. Work follows registered paths, without traversing unrelated chemistry fields.
function minimumVersionForRegisteredFeatures(
  value: unknown,
  registry: Readonly<Record<string, NativeDocumentFeatureVersion>>
): string {
  let minimum = NativeDocumentBaselineAppVersion;
  for (const [token, feature] of Object.entries(registry)) {
    if (feature.kind !== "feature" || feature.preservedByBaseline) continue;
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
    if (typeof registry[token]!.ignorable !== "boolean") {
      throw new Error(`Native feature registry entry must declare ignorable: ${token}`);
    }
    if (registry[token]!.schemaTracked !== false && !inventory.has(token)) {
      throw new Error(`Native feature registry entry is absent from the schema: ${token}`);
    }
  }
  return minimumVersionForRegisteredFeatures(value, registry);
}

/** Derive the display-only header from used fields, including restored future file data. */
export function ignorableFieldsForNativeFeatures(
  value: unknown,
  registry: Readonly<Record<string, NativeDocumentFeatureVersion>> = NativeDocumentFeatureVersions,
  sourcePatterns: readonly string[] = []
): string[] {
  const registered = Object.entries(registry).flatMap(([token, feature]) =>
    token.startsWith("field:") && feature.kind === "feature" && feature.ignorable ? [token.slice(6)] : []);
  return [...new Set([...registered, ...sourcePatterns])]
    .filter((pattern) => nativeFieldPatternValues(value, pattern).length > 0).sort();
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
