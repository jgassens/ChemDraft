import type { ManifestHints } from "./foreignManifest";
import { svgPathSchema } from "./schema";
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
}

/** Groups discovered files for review before import. */
export function planImport(files: readonly ImportFile[], hints?: ManifestHints, folderName = "My Art"): ImportPlan {
  const items: ImportItem[] = [];
  const leftOut: ImportPlan["leftOut"] = [];
  const hashes = new Set<string>();
  const groups = new Map<string, ImportItem>();
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path, "en"))) {
    const parts = file.path.split("/");
    const hint = hints?.files[file.path];
    if (!svgPathSchema.safeParse(file.path).success) {
      leftOut.push({ file, reason: "Not a safe SVG path" });
      continue;
    }
    if (parts.slice(0, -1).some(part => /^(evidence|proofs?)$/i.test(part))) {
      leftOut.push({ file, reason: "Non-art folder" });
      continue;
    }
    if (hints && !hint) {
      leftOut.push({ file, reason: "Not listed in the manifest" });
      continue;
    }
    if (hashes.has(file.sha256)) {
      leftOut.push({ file, reason: "Exact duplicate of a chosen file" });
      continue;
    }

    const parsed = parseVariantFilename(file.path);
    const stem = parsed?.stem ?? parts[parts.length - 1]!.replace(/\.svg$/i, "");
    const variant = hint?.variant || parsed?.variant || "default";
    const category = hint?.category ||
      (parts.length > 1 && parts[0] !== "assets" ? prettifyStem(parts[0]!) : "Uncategorized");
    const subcategory = hint?.subcategory || (parts.length > 2 ? prettifyStem(parts[parts.length - 2]!) : "General");
    const key = [category, subcategory, stem].join("\0");
    let item = groups.get(key);
    if (!item) {
      item = {
        id: stem,
        name: hint?.name || prettifyStem(stem),
        description: hint?.description || "",
        category,
        subcategory,
        variants: {}
      };
      groups.set(key, item);
      items.push(item);
    }
    if (Object.hasOwn(item.variants, variant)) {
      leftOut.push({ file, reason: "Variant already chosen" });
      continue;
    }
    item.variants[variant] = file;
    hashes.add(file.sha256);
  }
  return { name: hints?.name || folderName, items, leftOut };
}
