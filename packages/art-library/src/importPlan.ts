import { NO_USABLE_MANIFEST_HINTS, type ManifestHints } from "./foreignManifest";
import { allocateItemId, slugId } from "./ids";
import { importPathProblem } from "./paths";
import { parseVariantFilename, prettifyStem } from "./variants";

/** A discovered file and its content fingerprint. */
export interface ImportFile {
  path: string;
  sha256: string;
  byteSize: number;
}

/** A proposed library item with its source files grouped by variant. */
export interface ImportItem {
  id: string;
  name: string;
  description: string;
  category: string;
  subcategory: string;
  variants: Record<string, ImportFile>;
}

/** The proposed collection and reasons for excluding files. */
export interface ImportPlan {
  name: string;
  items: ImportItem[];
  leftOut: { file: ImportFile; reason: string }[];
  /** Set when a supplied manifest has no usable file hints. */
  manifestIgnoredReason?: string;
}

function sortedByPath(a: ImportFile, b: ImportFile): number {
  const comparison = a.path.localeCompare(b.path, "en");
  if (comparison !== 0 || a.path === b.path) return comparison;
  // A collation tie must not make input order decide which ID is allocated first.
  return a.path < b.path ? -1 : 1;
}

function categoryFolders(directories: string[]): string[] {
  return /^(assets|art|svg)$/i.test(directories[0] ?? "") ? directories.slice(1) : directories;
}

/** Groups discovered files for review before import. */
export function planImport(files: readonly ImportFile[], hints?: ManifestHints, folderName = "My Art"): ImportPlan {
  const usableHints = hints && files.some(file => Object.hasOwn(hints.files, file.path) && !importPathProblem(file.path))
    ? hints : undefined;
  const plan: ImportPlan = { name: usableHints?.name || folderName, items: [], leftOut: [] };
  if (hints && !usableHints) plan.manifestIgnoredReason = hints.ignoredReason ?? NO_USABLE_MANIFEST_HINTS;

  const hashes = new Set<string>();
  const ids = new Set<string>();
  const nextSuffix = new Map<string, number>();
  const groups = new Map<string, ImportItem>();
  for (const file of [...files].sort(sortedByPath)) {
    const pathProblem = importPathProblem(file.path);
    if (pathProblem) {
      plan.leftOut.push({ file, reason: pathProblem });
      continue;
    }

    const hint = usableHints && Object.hasOwn(usableHints.files, file.path) ? usableHints.files[file.path] : undefined;
    if (usableHints && !hint) {
      plan.leftOut.push({ file, reason: "Not listed in the manifest" });
      continue;
    }
    if (hashes.has(file.sha256)) {
      plan.leftOut.push({ file, reason: "Exact duplicate of a chosen file" });
      continue;
    }

    const directories = file.path.split("/");
    const filename = directories.pop()!;
    const folders = categoryFolders(directories);
    const parsed = parseVariantFilename(filename);
    const stem = parsed?.stem ?? filename.replace(/\.svg$/i, "");
    const variant = slugId(hint?.variant ?? parsed?.variant ?? "", "default");
    const category = hint?.category || prettifyStem(folders[0] ?? "") || "Uncategorized";
    const subcategory = hint?.subcategory || (folders.length > 1 && prettifyStem(folders.at(-1)!)) || "General";
    const key = hint?.groupId === undefined
      ? JSON.stringify(["filename", directories, stem, category, subcategory])
      : JSON.stringify(["manifest", hint.groupId]);
    let item = groups.get(key);
    if (!item) {
      const name = hint?.name || prettifyStem(stem) || filename;
      item = {
        id: allocateItemId(hint?.name || stem, ids, nextSuffix),
        name,
        description: hint?.description || "",
        category,
        subcategory,
        variants: Object.create(null)
      };
      groups.set(key, item);
      plan.items.push(item);
    }
    if (Object.hasOwn(item.variants, variant)) {
      plan.leftOut.push({ file, reason: 'Variant "' + variant + '" already chosen' });
      continue;
    }
    item.variants[variant] = file;
    hashes.add(file.sha256);
  }
  return plan;
}
