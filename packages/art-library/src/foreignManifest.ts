import { svgPathSchema } from "./schema";

/** Optional metadata supplied by a foreign manifest for a file. */
export interface FileHint {
  name?: string;
  description?: string;
  category?: string;
  subcategory?: string;
  variant?: string;
}

/** Collection metadata and file hints recognized in a foreign manifest. */
export interface ManifestHints {
  name?: string;
  files: Record<string, FileHint>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asNonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

/** Reads recognized subject and asset layouts from a foreign manifest. */
export function readForeignManifest(value: unknown, paths: readonly string[]): ManifestHints | undefined {
  const root = asRecord(value);
  if (!root) return undefined;

  const present = new Set(paths);
  const files: Record<string, FileHint> = Object.create(null);
  let known = false;
  function addHint(path: string, hint: FileHint): void {
    if (present.has(path) && svgPathSchema.safeParse(path).success) {
      files[path] = hint;
    }
  }

  if (Array.isArray(root.subjects)) {
    for (const raw of root.subjects) {
      const subject = asRecord(raw);
      const variants = asRecord(subject?.variants);
      if (!subject || !variants) continue;

      for (const [variant, path] of Object.entries(variants)) {
        if (typeof path !== "string") continue;
        known = true;
        addHint(path, {
          name: asNonemptyString(subject.name),
          description: asNonemptyString(subject.description),
          category: asNonemptyString(subject.category),
          subcategory: asNonemptyString(subject.subcategory),
          variant
        });
      }
    }
  }

  if (Array.isArray(root.assets)) {
    for (const raw of root.assets) {
      const asset = asRecord(raw);
      if (!asset || typeof asset.path !== "string" || !asset.path.endsWith(".svg")) continue;
      known = true;
      addHint(asset.path, {
        name: asNonemptyString(asset.display_name),
        description: asNonemptyString(asset.description),
        category: asNonemptyString(asset.category),
        subcategory: asNonemptyString(asset.subcategory),
        variant: asNonemptyString(asset.style)?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      });
    }
  }

  return known ? { name: asNonemptyString(root.title) ?? asNonemptyString(root.library), files } : undefined;
}
