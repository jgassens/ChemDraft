import { slugId } from "./ids";
import { importPathProblem } from "./paths";

/** Optional metadata supplied by a foreign manifest for a file. */
export interface FileHint {
  name?: string;
  description?: string;
  category?: string;
  subcategory?: string;
  variant?: string;
  /** An opaque identity shared by files declared as variants of one item. */
  groupId?: string;
}

/** Collection metadata and file hints from a recognized manifest shape. */
export interface ManifestHints {
  name?: string;
  files: Record<string, FileHint>;
  /** Explains why this recognized manifest cannot guide discovery when its file map is empty. */
  ignoredReason?: string;
}

/** Diagnostic for a recognized manifest with no usable matches. */
export const NO_USABLE_MANIFEST_HINTS = "Manifest ignored: no usable SVG paths match the discovered files.";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asNonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function subjectHints(subjects: unknown[], addHint: (path: unknown, hint: FileHint) => void): void {
  for (const [index, raw] of subjects.entries()) {
    const subject = asRecord(raw);
    const variants = asRecord(subject?.variants);
    if (!subject || !variants) continue;

    for (const [variant, path] of Object.entries(variants)) {
      addHint(path, {
        groupId: "subject:" + index,
        name: asNonemptyString(subject.name),
        description: asNonemptyString(subject.description),
        category: asNonemptyString(subject.category),
        subcategory: asNonemptyString(subject.subcategory),
        variant
      });
    }
  }
}

function assetHints(
  assets: unknown[],
  isUsablePath: (path: unknown) => path is string,
  addHint: (path: string, hint: FileHint) => void
): void {
  const entries: { id?: string; idKey?: string; path: string; hint: FileHint }[] = [];
  const seenIds = new Set<string>();
  const sharedIds = new Set<string>();
  for (const raw of assets) {
    const asset = asRecord(raw);
    if (!asset || !isUsablePath(asset.path)) continue;

    const id = asNonemptyString(asset.id);
    const subject = asNonemptyString(asset.subject_id) ?? asNonemptyString(asset.subject);
    const category = asNonemptyString(asset.category);
    const subcategory = asNonemptyString(asset.subcategory);
    const idKey = id && !subject ? JSON.stringify(["asset-id", id, category, subcategory]) : undefined;
    if (idKey) {
      if (seenIds.has(idKey)) sharedIds.add(idKey);
      seenIds.add(idKey);
    }
    entries.push({
      id,
      idKey,
      path: asset.path,
      hint: {
        groupId: subject ? JSON.stringify(["asset-subject", subject]) : undefined,
        name: asNonemptyString(asset.display_name),
        description: asNonemptyString(asset.description),
        category,
        subcategory,
        variant: asNonemptyString(asset.style)
      }
    });
  }

  for (const { id, idKey, path, hint } of entries) {
    if (idKey && sharedIds.has(idKey)) {
      hint.groupId = idKey;
    } else if (id && !hint.groupId) {
      // Asset IDs may carry the same --variant suffix as their filenames.
      const variant = slugId(hint.variant ?? "", "");
      const suffix = "--" + variant;
      const stem = variant && id.length > suffix.length && id.toLowerCase().endsWith(suffix)
        ? id.slice(0, -suffix.length)
        : id;
      hint.groupId = JSON.stringify(["asset-stem", stem, hint.name, hint.category, hint.subcategory]);
    }
    addHint(path, hint);
  }
}

/** Reads file hints from a recognized subject or asset layout, with a diagnostic for empty matches. */
export function readForeignManifest(value: unknown, paths: readonly string[]): ManifestHints | undefined {
  const root = asRecord(value);
  if (!root || (!Array.isArray(root.subjects) && !Array.isArray(root.assets))) return undefined;

  const present = new Set(paths.filter(path => !importPathProblem(path)));
  const files: Record<string, FileHint> = Object.create(null);
  const isUsablePath = (path: unknown): path is string => typeof path === "string" && present.has(path);
  function addHint(path: unknown, hint: FileHint): void {
    if (isUsablePath(path) && !Object.hasOwn(files, path)) files[path] = hint;
  }

  if (Array.isArray(root.subjects)) subjectHints(root.subjects, addHint);
  if (Array.isArray(root.assets)) assetHints(root.assets, isUsablePath, addHint);

  if (!Object.keys(files).length) return { files, ignoredReason: NO_USABLE_MANIFEST_HINTS };
  return { name: asNonemptyString(root.title) ?? asNonemptyString(root.library), files };
}
