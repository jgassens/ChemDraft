import { z } from "zod";

// Stable release versions only: prerelease/build strings must not accidentally compare as releases.
export const NativeVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

const ExtensionPathSegmentSchema = z.union([
  z.string(),
  z.number().int().nonnegative(),
  z.object({ id: z.string() }).strict()
]);

/** Internal, JSON-cloneable state; never emitted as a sidecar in a native file. */
export const NativeExtensionsSchema = z.array(z.object({
  path: z.array(ExtensionPathSegmentSchema).min(1),
  kind: z.enum(["field", "enum"]),
  originalValue: z.unknown(),
  fallbackValue: z.unknown().optional()
}).strict());

export type NativeExtension = z.infer<typeof NativeExtensionsSchema>[number];

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
  return path.map((segment, index) => {
    const value = ownNativeValue(current, segment);
    const id = ownNativeValue(value, "id");
    const stable = typeof segment === "number" && Array.isArray(current) && typeof id === "string"
      && ["pages", "objects", "atoms", "bonds", "rows", "columns"].includes(String(path[index - 1]))
      && current.filter((item) => ownNativeValue(item, "id") === id).length === 1
      ? { id } : segment;
    current = value;
    return stable;
  });
}

export function nativeExtensionTarget(root: unknown, extension: NativeExtension): { parent: object; key: string | number } | undefined {
  let parent = root;
  for (const segment of extension.path.slice(0, -1)) {
    parent = typeof segment === "object"
      ? Array.isArray(parent) ? parent.find((item) => ownNativeValue(item, "id") === segment.id) : undefined
      : ownNativeValue(parent, segment);
  }
  const key = extension.path.at(-1);
  if ((!isNativeRecord(parent) && !Array.isArray(parent)) || typeof key === "object" || key === undefined) return undefined;
  const active = extension.kind === "field" ? !Object.hasOwn(parent, key)
    : JSON.stringify(ownNativeValue(parent, key)) === JSON.stringify(extension.fallbackValue);
  return active ? { parent, key } : undefined;
}

/** Restore only while the owning object and its fallback still exist. Edits/deletes win. */
export function restoreNativeExtensions(root: unknown, extensions: NativeExtension[]): number {
  let restored = 0;
  for (const extension of extensions) {
    const target = nativeExtensionTarget(root, extension);
    if (!target) continue;
    setNativeValue(target.parent, target.key, extension.originalValue);
    restored += 1;
  }
  return restored;
}
