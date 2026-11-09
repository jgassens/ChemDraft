import { z } from "zod";
import { ChemDraftDocumentSchema, type ChemDraftDocument } from "./schemas";
import { NativeDocumentBaselineAppVersion, NativeDocumentFormatVersion, NativeDocumentReaderVersion } from "./documentFeatures";
import { DefaultNativeDrawingStyle, DocumentStylePreset } from "./styles";
import {
  compareNativeVersions, isNativeRecord, NativeVersionSchema, ownNativeValue,
  setNativeValue, stableExtensionPath, type NativeExtension
} from "./nativeCompatibilityState";

export type NativeDocumentWarningCode =
  | "NATIVE_UNKNOWN_FIELD_PRESERVED"
  | "NATIVE_BOND_STYLE_FALLBACK"
  | "NATIVE_STYLE_PRESET_FALLBACK"
  | "NATIVE_VISUAL_ENUM_FALLBACK";

export interface NativeDocumentReadWarning {
  code: NativeDocumentWarningCode;
  path: (string | number)[];
  originalValue: unknown;
  message: string;
}

export interface NativeDocumentReadResult {
  document: ChemDraftDocument;
  warnings: NativeDocumentReadWarning[];
  /** Absent on legacy files; the schema string still identifies the v1 object model. */
  formatVersion: string | undefined;
  /** Effective minimum; legacy files default to the released v1.1.1 baseline. */
  minAppVersion: string;
}

export class NativeDocumentReadError extends Error {
  constructor(
    public readonly code: "NATIVE_INVALID_DOCUMENT" | "NATIVE_UNSUPPORTED_CHEMISTRY" | "NATIVE_UNSUPPORTED_VALUE",
    public readonly path: (string | number)[],
    public readonly originalValue: unknown,
    detail: string
  ) {
    super(`Unsupported or invalid ChemDraft document: ${path.join(".") || "<root>"}: ${detail}`);
    this.name = "NativeDocumentReadError";
  }
}

/**
 * Forward reader for an already-decoded native file. Strict parsing and patch validation remain
 * strict. Only files declaring a newer writer contract or minimum app receive tolerant handling.
 * Legacy migrations are supplied by document.ts to avoid a reader/migration import cycle.
 */
export function readNativeDocument(
  candidate: unknown,
  migrateLegacy: (candidate: unknown) => ChemDraftDocument
): NativeDocumentReadResult {
  const formatVersion = fileVersion(candidate, "formatVersion");
  const minAppVersion = fileVersion(candidate, "minAppVersion") ?? NativeDocumentBaselineAppVersion;
  const newer = (formatVersion !== undefined && compareNativeVersions(formatVersion, NativeDocumentFormatVersion) > 0)
    || compareNativeVersions(minAppVersion, NativeDocumentReaderVersion) > 0;

  if (!newer) {
    // This field is internal state, never a file capability. Do not accept a forged sidecar.
    if (ownNativeValue(ownNativeValue(candidate, "compatibility"), "nativeExtensions") !== undefined) {
      throw new NativeDocumentReadError("NATIVE_INVALID_DOCUMENT", ["compatibility", "nativeExtensions"], undefined,
        "nativeExtensions is reserved for in-memory read state.");
    }
    return { document: migrateLegacy(candidate), warnings: [], formatVersion, minAppVersion };
  }

  // JSON cloning both detaches untrusted objects and gives preservation exactly JSON semantics.
  const working = JSON.parse(JSON.stringify(candidate, (_key, value: unknown) => {
    // JSON.parse can produce Infinity for an overflowing exponent. Never silently turn that into
    // null while cloning opaque future data for preservation.
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new NativeDocumentReadError("NATIVE_INVALID_DOCUMENT", [], value, "Native JSON numbers must be finite.");
    }
    return value;
  })) as unknown;
  const warnings: NativeDocumentReadWarning[] = [];
  const extensions: NativeExtension[] = [];

  const preserve = (
    path: (string | number)[],
    kind: NativeExtension["kind"],
    code: NativeDocumentWarningCode,
    originalValue: unknown,
    fallbackValue?: unknown,
    warning?: { path: (string | number)[]; originalValue: unknown }
  ) => {
    extensions.push({ path: stableExtensionPath(candidate, path), kind, originalValue,
      ...(fallbackValue !== undefined ? { fallbackValue } : {}) });
    const warningPath = warning?.path ?? path;
    const warningOriginal = warning ? warning.originalValue : originalValue;
    warnings.push({ code, path: warningPath, originalValue: warningOriginal,
      message: kind === "field" ? `Preserved unrecognized field ${path.join(".")}.`
        : `Unsupported value ${JSON.stringify(warningOriginal)} at ${warningPath.join(".")}; using ${JSON.stringify(fallbackValue) ?? "the default"}.` });
  };

  // A future writer might happen to use our internal key. Preserve it as file data, never execute it.
  const compatibility = ownNativeValue(working, "compatibility");
  if (isNativeRecord(compatibility) && Object.hasOwn(compatibility, "nativeExtensions")) {
    preserve(["compatibility", "nativeExtensions"], "field", "NATIVE_UNKNOWN_FIELD_PRESERVED", compatibility.nativeExtensions);
    delete compatibility.nativeExtensions;
  }

  normalizeStylePresetIds(working, preserve);
  while (true) {
    const parsed = ChemDraftDocumentSchema.safeParse(working);
    if (parsed.success) {
      // Zod deliberately omits __proto__ record keys. Keep them as inert file data, just like
      // unknown strict-object keys, rather than installing them on the active metadata object.
      preserveOmittedJsonKeys(working, parsed.data, [], preserve);
      if (extensions.length) parsed.data.compatibility.nativeExtensions = extensions;
      return { document: parsed.data, warnings, formatVersion, minAppVersion };
    }
    let changed = false;
    for (const issue of parsed.error.issues) {
      if (issue.code === z.ZodIssueCode.unrecognized_keys) {
        const parent = valueAtPath(working, issue.path);
        if (!isNativeRecord(parent)) continue;
        for (const key of issue.keys) {
          if (!Object.hasOwn(parent, key)) continue;
          const path = [...issue.path, key];
          if (isUnknownAtomKind(path)) {
            throw new NativeDocumentReadError("NATIVE_UNSUPPORTED_CHEMISTRY", path, parent[key],
              `Unsupported atom kind ${JSON.stringify(parent[key])}; chemical identity cannot be preserved.`);
          }
          if (isUnknownChemicalField(path)) {
            throw new NativeDocumentReadError("NATIVE_UNSUPPORTED_CHEMISTRY", path, parent[key],
              `Unsupported chemistry field "${key}" with value ${JSON.stringify(parent[key])}; chemical identity cannot be preserved.`);
          }
          preserve(path, "field", "NATIVE_UNKNOWN_FIELD_PRESERVED", ownNativeValue(parent, key));
          delete parent[key];
          changed = true;
        }
      } else if (issue.code === z.ZodIssueCode.invalid_enum_value || issue.code === z.ZodIssueCode.invalid_union_discriminator) {
        const originalValue = valueAtPath(working, issue.path);
        // Missing discriminators and wrong types are malformed structure, never future enum values.
        if (typeof originalValue !== "string") throw new NativeDocumentReadError("NATIVE_INVALID_DOCUMENT", issue.path, originalValue, issue.message);
        const fallback = visualFallback(working, issue.path);
        if (!fallback) throwUnsupportedValue(issue.path, originalValue);
        const replacementPath = fallback.container ? issue.path.slice(0, -1) : issue.path;
        const parent = valueAtPath(working, replacementPath.slice(0, -1));
        const key = replacementPath.at(-1)!;
        if (fallback.container && Array.isArray(parent) && typeof key === "number") {
          preserve(replacementPath, "enum", fallback.code, parent[key], fallback.value,
            { path: issue.path, originalValue });
          parent[key] = fallback.value;
          changed = true;
          continue;
        }
        if (!isNativeRecord(parent)) continue;
        preserve(replacementPath, "enum", fallback.code, valueAtPath(working, replacementPath), fallback.value,
          { path: issue.path, originalValue });
        if (fallback.value === undefined) delete parent[key];
        else setNativeValue(parent, key, fallback.value);
        changed = true;
      } else if (issue.code === z.ZodIssueCode.invalid_literal) {
        throwUnsupportedValue(issue.path, valueAtPath(working, issue.path));
      } else {
        throw new NativeDocumentReadError("NATIVE_INVALID_DOCUMENT", issue.path, valueAtPath(working, issue.path), issue.message);
      }
    }
    if (!changed) {
      throw new NativeDocumentReadError("NATIVE_INVALID_DOCUMENT", [], undefined, parsed.error.message);
    }
  }
}

function fileVersion(candidate: unknown, key: string): string | undefined {
  const value = ownNativeValue(candidate, key);
  if (value === undefined) return undefined;
  const parsed = NativeVersionSchema.safeParse(value);
  if (!parsed.success) throw new NativeDocumentReadError("NATIVE_INVALID_DOCUMENT", [key], value,
    "Version must be a stable major.minor.patch string.");
  return parsed.data;
}

function valueAtPath(root: unknown, path: (string | number)[]): unknown {
  return path.reduce<unknown>((value, key) => ownNativeValue(value, key), root);
}

function isUnknownAtomKind(path: (string | number)[]): boolean {
  return /^pages\.\d+\.objects\.\d+\.atoms\.\d+\.(kind|type|atomKind)$/.test(path.join("."));
}

function isUnknownChemicalField(path: (string | number)[]): boolean {
  const location = path.join(".");
  return /^pages\.\d+\.objects\.\d+\.atoms\.\d+\.(atomicNumber|charge|radical|radicals|radicalState|radicalCount|isotopes|hydrogens|implicitHydrogens|stereo|stereochemistry)$/.test(location)
    || /^pages\.\d+\.objects\.\d+\.bonds\.\d+\.(bondOrder|bondType|stereoKind|stereochemistry)$/.test(location)
    || /^pages\.\d+\.objects\.\d+\.bonds\.\d+\.display\.(stereo|stereoKind|stereochemistry)$/.test(location);
}

function throwUnsupportedValue(path: (string | number)[], originalValue: unknown): never {
  const chemistry = /\.(atoms|bonds)\.\d+\.(order|stereo|kind|type|atomKind|element|formalCharge|isotope|markRadicals)$/.test(path.join("."))
    || path.at(-1) === "structureFormat" || path.at(-1) === "expandedStructureFormat"
    || path.at(-1) === "markKind" || path.at(-1) === "role" || path.at(-1) === "querySemantics"
    || path.at(-1) === "side" || path.at(-1) === "type" || path.at(-1) === "arrowKind" || path.at(-1) === "mappingState"
    || path.at(-1) === "kind";
  throw new NativeDocumentReadError(chemistry ? "NATIVE_UNSUPPORTED_CHEMISTRY" : "NATIVE_UNSUPPORTED_VALUE", path, originalValue,
    `Unsupported value ${JSON.stringify(originalValue)}; ${chemistry ? "chemical identity cannot be preserved" : "no safe fallback is defined"}.`);
}

function visualFallback(root: unknown, path: (string | number)[]): { value: unknown; code: NativeDocumentWarningCode; container?: boolean } | undefined {
  const key = path.join(".");
  if (/^pages\.\d+\.objects\.\d+\.bonds\.\d+\.display\.bondStyle$/.test(key)) {
    return { value: undefined, code: "NATIVE_BOND_STYLE_FALLBACK" };
  }
  let value: unknown;
  if (/^pages\.\d+\.objects\.\d+\.bonds\.\d+\.display\.doubleBondSide$/.test(key)) value = "automatic";
  else if (/^pages\.\d+\.layout\.presetId$/.test(key)) value = "custom";
  else if (/^pages\.\d+\.layout\.orientation$/.test(key)) {
    const layout = valueAtPath(root, path.slice(0, -1));
    value = Number(ownNativeValue(layout, "widthPx")) > Number(ownNativeValue(layout, "heightPx")) ? "landscape" : "portrait";
  } else if (/^pages\.\d+\.objects\.\d+\.columns\.\d+\.align$/.test(key)) value = "unknown";
  else if (/^pages\.\d+\.objects\.\d+\.tableStyle\.preset$/.test(key)) value = "three-line";
  else if (/^pages\.\d+\.objects\.\d+\.(graphicKind|bracketKind)$/.test(key)) value = "unknown";
  else if (/^pages\.\d+\.objects\.\d+\.arrowKind$/.test(key)
    && ownNativeValue(valueAtPath(root, path.slice(0, -1)), "type") === "reaction-arrow") value = "unknown";
  else if (/^pages\.\d+\.objects\.\d+\.style\.strokeLineCap$/.test(key)) value = "butt";
  else if (/^pages\.\d+\.objects\.\d+\.style\.strokeLineJoin$/.test(key)) value = "miter";
  else if (/^pages\.\d+\.objects\.\d+\.style\.fillMode$/.test(key)) value = "solid";
  else if (/^pages\.\d+\.objects\.\d+\.style\.(strokePaint|fillPaint)\.kind$/.test(key)) value = "none";
  else if (/^pages\.\d+\.objects\.\d+\.columns\.\d+\.width\.mode$/.test(key)) value = "auto";
  else if (/^pages\.\d+\.objects\.\d+\.data\.marker(Start|End)\.kind$/.test(key)) value = "none";
  else if (/^pages\.\d+\.objects\.\d+\.chargeStyle$/.test(key)) value = "circled";
  else if (/^pages\.\d+\.objects\.\d+\.(columns\.\d+|rows\.\d+\.cells\.\d+)\.formula$/.test(key)) value = "off";
  else if (/^pages\.\d+\.objects\.\d+\..*spans\.\d+\.script$/.test(key)) value = "normal";
  else if (/^pages\.\d+\.objects\.\d+\.(style\.effect|data\.(artPathKind|shaftMark))$/.test(key)) value = undefined;
  else if (/^pages\.\d+\.objects\.\d+\.style\.(visualEffects|inactiveVisualEffects|effects|inactiveEffects)\.\d+\.kind$/.test(key)) {
    // An invisible known effect is neutral and keeps array positions stable for preservation.
    return { value: { kind: "shadow", opacity: 0 }, code: "NATIVE_VISUAL_ENUM_FALLBACK", container: true };
  } else return undefined;
  return { value, code: "NATIVE_VISUAL_ENUM_FALLBACK" };
}

function normalizeStylePresetIds(
  root: unknown,
  preserve: (path: (string | number)[], kind: NativeExtension["kind"], code: NativeDocumentWarningCode,
    originalValue: unknown, fallbackValue?: unknown) => void
): void {
  const known = new Set<string>([DefaultNativeDrawingStyle.stylePresetId, DocumentStylePreset.id]);
  // Metadata is deliberately open. Recognize this particular rendering setting, without walking
  // arbitrary plugin payloads or converting an unrelated property with the same name.
  const inspect = (style: unknown, path: (string | number)[]) => {
    if (!isNativeRecord(style) || !Object.hasOwn(style, "stylePresetId")) return;
    const id = style.stylePresetId;
    if (typeof id !== "string") throw new NativeDocumentReadError("NATIVE_INVALID_DOCUMENT", [...path, "stylePresetId"], id,
      "Style preset id must be a string.");
    if (known.has(id)) return;
    preserve([...path, "stylePresetId"], "enum", "NATIVE_STYLE_PRESET_FALLBACK", id, DefaultNativeDrawingStyle.stylePresetId);
    style.stylePresetId = DefaultNativeDrawingStyle.stylePresetId;
  };
  const pages = ownNativeValue(root, "pages");
  inspect(ownNativeValue(ownNativeValue(root, "styles"), "drawing"), ["styles", "drawing"]);
  if (!Array.isArray(pages)) return;
  pages.forEach((page, pageIndex) => {
    const objects = ownNativeValue(page, "objects");
    if (Array.isArray(objects)) objects.forEach((object, objectIndex) => {
      if (ownNativeValue(object, "type") === "molecule") {
        inspect(ownNativeValue(object, "style"), ["pages", pageIndex, "objects", objectIndex, "style"]);
      }
    });
  });
}

function preserveOmittedJsonKeys(
  source: unknown,
  parsed: unknown,
  path: (string | number)[],
  preserve: (path: (string | number)[], kind: NativeExtension["kind"], code: NativeDocumentWarningCode, originalValue: unknown) => void
): void {
  if (Array.isArray(source) && Array.isArray(parsed)) {
    source.forEach((item, index) => preserveOmittedJsonKeys(item, parsed[index], [...path, index], preserve));
  } else if (isNativeRecord(source) && isNativeRecord(parsed)) {
    for (const key of Object.keys(source)) {
      if (key === "__proto__" && !Object.hasOwn(parsed, key)) {
        preserve([...path, key], "field", "NATIVE_UNKNOWN_FIELD_PRESERVED", ownNativeValue(source, key));
      } else if (Object.hasOwn(parsed, key)) {
        preserveOmittedJsonKeys(ownNativeValue(source, key), ownNativeValue(parsed, key), [...path, key], preserve);
      }
    }
  }
}
