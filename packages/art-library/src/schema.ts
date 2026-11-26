import { z } from "zod";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_DIMENSION,
  MAX_ID_LENGTH,
  MAX_ITEMS,
  MAX_KEYWORDS,
  MAX_PATH_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_VARIANTS
} from "./limits";

const id = z.string().min(1).max(MAX_ID_LENGTH).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const text = z.string().min(1).max(MAX_TEXT_LENGTH);

/** Validates a relative SVG path stored in a pack. */
export const svgPathSchema = z.string().min(1).max(MAX_PATH_LENGTH).refine(path =>
  !path.startsWith("/") &&
  !path.includes("\\") &&
  !path.includes(":") &&
  !/[\u0000-\u001f\u007f]/u.test(path) &&
  path.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..") &&
  path.endsWith(".svg")
);

/** Validates the file reference and dimensions for one SVG variant. */
export const variantSchema = z.object({
  file: svgPathSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  width: z.number().finite().positive().max(MAX_DIMENSION),
  height: z.number().finite().positive().max(MAX_DIMENSION)
}).strict();

function hasValidVariantCount(variants: Record<string, unknown>): boolean {
  const count = Object.keys(variants).length;
  return count > 0 && count <= MAX_VARIANTS;
}

/** Validates one subject and its variants in a pack. */
export const itemSchema = z.object({
  id,
  name: text,
  description: z.string().max(MAX_DESCRIPTION_LENGTH),
  category: text,
  subcategory: text,
  keywords: z.array(text).max(MAX_KEYWORDS),
  variants: z.record(id, variantSchema).refine(hasValidVariantCount),
  convertible: z.enum(["exact", "approximate"]).optional()
}).strict();

function checkItemIds(pack: { items: ArtItem[] }, ctx: z.RefinementCtx): void {
  const ids = new Set<string>();
  for (const item of pack.items) {
    if (ids.has(item.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate item id: " + item.id });
    }
    ids.add(item.id);
  }
}

/** Validates a pack manifest, including collection-wide uniqueness of item IDs. */
export const packSchema = z.object({
  id,
  name: text,
  version: text,
  license: text,
  attribution: text.optional(),
  items: z.array(itemSchema).max(MAX_ITEMS)
}).strict().superRefine(checkItemIds);

/** A validated pack manifest. */
export type ArtPack = z.infer<typeof packSchema>;

/** A validated subject within a pack. */
export type ArtItem = z.infer<typeof itemSchema>;
