import { z } from "zod";

// Stable release versions only: prerelease/build strings must not accidentally compare as releases.
export const NativeVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

const ExtensionPathSegmentSchema = z.union([
  z.string(),
  z.number().int().nonnegative(),
  z.object({ id: z.string() }).strict(),
  z.object({
    index: z.number().int().nonnegative(),
    tableColumnIds: z.array(z.string()).optional(),
    arrayFingerprint: z.object({
      length: z.number().int().nonnegative(),
      hashes: z.array(z.string()),
      // Keep exact content too: even a hash collision must never attach data to another element.
      contents: z.array(z.string())
    }).strict()
  }).strict()
]);

/** Internal, JSON-cloneable state; never emitted as a sidecar in a native file. */
export const NativeExtensionsSchema = z.array(z.object({
  path: z.array(ExtensionPathSegmentSchema).min(1),
  kind: z.enum(["field", "enum"]),
  originalValue: z.unknown(),
  fallbackValue: z.unknown().optional(),
  // A pending array-loss warning, separate from restoration. Once set, matching content
  // cannot reactivate this entry. Store a path prefix length so copies can remap its scope.
  droppedArrayPathLength: z.number().int().nonnegative().optional()
}).strict());

export type NativeExtension = z.infer<typeof NativeExtensionsSchema>[number];

export interface NativeDocumentWriteWarning {
  code: "NATIVE_EXTENSION_DATA_DROPPED";
  path: (string | number)[];
  originalValue: unknown;
  message: string;
}

export function compareNativeVersions(left: string, right: string): number {
  const a = NativeVersionSchema.parse(left).split(".").map(BigInt);
  const b = NativeVersionSchema.parse(right).split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

export function isNativeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own properties only, including JSON keys such as __proto__; never traverse prototypes. */
export function ownNativeValue(value: unknown, key: string | number): unknown {
  return value !== null && typeof value === "object" && Object.hasOwn(value, key)
    ? (value as Record<string | number, unknown>)[key]
    : undefined;
}

export function setNativeValue(target: object, key: string | number, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

export function stableExtensionPath(root: unknown, path: (string | number)[]): NativeExtension["path"] {
  let current = root;
  let tableColumnIds: string[] | undefined;
  return path.map((segment, index) => {
    tableColumnIds = nativeTableColumnIds(current) ?? tableColumnIds;
    const value = ownNativeValue(current, segment);
    const id = ownNativeValue(value, "id");
    const stable = typeof segment === "number" && Array.isArray(current) && typeof id === "string"
      && current.filter((item) => ownNativeValue(item, "id") === id).length === 1
      ? { id } : typeof segment === "number" && Array.isArray(current)
        ? { index: segment, arrayFingerprint: arrayFingerprint(current),
          ...(path[index - 1] === "cells" && tableColumnIds ? { tableColumnIds } : {}) } : segment;
    current = value;
    return stable;
  });
}

export function nativeExtensionTarget(root: unknown, extension: NativeExtension): { parent: object; key: string | number } | undefined {
  return resolveExtensionTarget(root, extension).target;
}

/** The page/object scope of document-level state. Atom and bond IDs remain molecule-local. */
export function nativeExtensionObjectScope(extension: NativeExtension): { pageId: string; objectId: string } | undefined {
  const [pages, page, objects, object] = extension.path;
  return pages === "pages" && typeof page === "object" && "id" in page
    && objects === "objects" && typeof object === "object" && "id" in object
    ? { pageId: page.id, objectId: object.id } : undefined;
}

/** Retire mismatched positional entries permanently while keeping their pending loss warning.
 * Removed identities and explicitly replaced non-positional fallbacks are discarded outright. */
export function retainNativeExtension(root: unknown, extension: NativeExtension): NativeExtension | undefined {
  if (extension.droppedArrayPathLength !== undefined) return extension;
  const resolution = resolveExtensionTarget(root, extension);
  if (resolution.target) return extension;
  const editedSegment = resolution.editedArrayPath && extension.path[resolution.editedArrayPath.length];
  return typeof editedSegment === "object" && "index" in editedSegment
    ? { ...extension, droppedArrayPathLength: resolution.editedArrayPath!.length } : undefined;
}

function resolveExtensionTarget(root: unknown, extension: NativeExtension): {
  target?: { parent: object; key: string | number };
  editedArrayPath?: NativeExtension["path"];
} {
  if (extension.droppedArrayPathLength !== undefined) {
    return { editedArrayPath: extension.path.slice(0, extension.droppedArrayPathLength) };
  }
  let parent = root;
  let tableColumnIds: string[] | undefined;
  // Resolve the final segment too: an entire unknown effect can itself be an array member.
  for (let index = 0; index < extension.path.length; index += 1) {
    const segment = extension.path[index]!;
    tableColumnIds = nativeTableColumnIds(parent) ?? tableColumnIds;
    let key: string | number;
    if (typeof segment === "object" && "id" in segment) {
      if (!Array.isArray(parent)) return {};
      const matches = parent.flatMap((item, position) => ownNativeValue(item, "id") === segment.id ? [position] : []);
      if (matches.length !== 1) return { editedArrayPath: extension.path.slice(0, index) };
      key = matches[0]!;
    } else if (typeof segment === "object") {
      if (!Array.isArray(parent) || !sameArrayFingerprint(parent, segment.arrayFingerprint)
        || (segment.tableColumnIds && canonicalJson(segment.tableColumnIds) !== canonicalJson(tableColumnIds))) {
        return { editedArrayPath: extension.path.slice(0, index) };
      }
      key = segment.index;
    } else {
      // Old in-memory sidecars without a fingerprint cannot safely restore array positions.
      if (typeof segment === "number" && Array.isArray(parent)) {
        return { editedArrayPath: extension.path.slice(0, index) };
      }
      key = segment;
    }
    if (index === extension.path.length - 1) {
      if (!isNativeRecord(parent) && !Array.isArray(parent)) return {};
      const active = extension.kind === "field" ? !Object.hasOwn(parent, key)
        : canonicalJson(ownNativeValue(parent, key)) === canonicalJson(extension.fallbackValue);
      return active ? { target: { parent, key } } : {};
    }
    parent = ownNativeValue(parent, key);
  }
  return {};
}

/** Restore only while the owning object and its fallback still exist. Edits/deletes win. */
export function restoreNativeExtensions(root: unknown, extensions: NativeExtension[]): { restored: number; warnings: NativeDocumentWriteWarning[] } {
  let restored = 0;
  const warnings: NativeDocumentWriteWarning[] = [];
  const warned = new Set<string>();
  // Check every guard against the active known model, before restoring any future fields.
  const resolutions = extensions.map((extension) => resolveExtensionTarget(root, extension));
  extensions.forEach((extension, index) => {
    const { target, editedArrayPath } = resolutions[index]!;
    if (editedArrayPath) {
      const path = editedArrayPath.map((segment) => typeof segment !== "object" ? segment : "id" in segment ? segment.id : segment.index);
      const location = JSON.stringify(path);
      if (!warned.has(location)) {
        warned.add(location);
        warnings.push({ code: "NATIVE_EXTENSION_DATA_DROPPED", path, originalValue: extension.originalValue,
          message: `Newer-version data in ${path.join(".")} was dropped because this array was edited.` });
      }
    }
    if (!target) return;
    setNativeValue(target.parent, target.key, extension.originalValue);
    restored += 1;
  });
  return { restored, warnings };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isNativeRecord(value)) return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(ownNativeValue(value, key))}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

function contentHash(contents: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < contents.length; index += 1) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(contents.charCodeAt(index))) * 0x100000001b3n);
  }
  return hash.toString(16);
}

function arrayFingerprint(array: unknown[]) {
  const contents = array.map(canonicalJson);
  return { length: array.length, hashes: contents.map(contentHash), contents };
}

function sameArrayFingerprint(array: unknown[], fingerprint: ReturnType<typeof arrayFingerprint>): boolean {
  if (array.length !== fingerprint.length) return false;
  const current = arrayFingerprint(array);
  return current.contents.every((contents, index) => contents === fingerprint.contents[index]
    && current.hashes[index] === fingerprint.hashes[index]);
}

function nativeTableColumnIds(value: unknown): string[] | undefined {
  if (ownNativeValue(value, "type") !== "table") return undefined;
  const columns = ownNativeValue(value, "columns");
  return Array.isArray(columns) ? columns.map(column => String(ownNativeValue(column, "id"))) : undefined;
}
