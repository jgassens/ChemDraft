import { z } from "zod";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_DIMENSION,
  MAX_ID_LENGTH,
  MAX_ITEMS,
  MAX_KEYWORDS,
  MAX_TEXT_LENGTH,
  MAX_VARIANTS
} from "./limits";
import { ID_PATTERN } from "./ids";
import { isLooseSvgPath, isWindowsSafeSegment, windowsPathKey } from "./paths";

const id = z.string().min(1).max(MAX_ID_LENGTH).regex(ID_PATTERN);
const text = z.string().min(1).max(MAX_TEXT_LENGTH);

/** Validates a portable relative SVG path stored in a pack. */
export const svgPathSchema = z.string().refine(path =>
  isLooseSvgPath(path) &&
  path.endsWith(".svg") &&
  path.split("/").every(isWindowsSafeSegment),
  "Unsafe pack SVG path"
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

const ownVariantRecord = z.preprocess(value => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  // Zod 3's record parser visits inherited enumerable properties. Only accept own entries.
  return Object.assign(Object.create(null), value);
}, z.record(id, variantSchema).refine(hasValidVariantCount));

type VariantRecord = z.output<typeof ownVariantRecord>;
const variantRecordSchema = ownVariantRecord.pipe(z.custom<VariantRecord>()
  .transform(variants => Object.assign(Object.create(null) as VariantRecord, variants)));

/** Validates one subject and its variants in a pack. */
export const itemSchema = z.object({
  id,
  name: text,
  description: z.string().max(MAX_DESCRIPTION_LENGTH),
  category: text,
  subcategory: text,
  keywords: z.array(text).max(MAX_KEYWORDS),
  variants: variantRecordSchema,
  convertible: z.enum(["exact", "approximate"]).optional()
}).strict();

function checkPackUniqueness(pack: { items: ArtItem[] }, ctx: z.RefinementCtx): void {
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const [index, item] of pack.items.entries()) {
    if (ids.has(item.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate item id: " + item.id });
    }
    ids.add(item.id);
    for (const [variantId, variant] of Object.entries(item.variants)) {
      const key = windowsPathKey(variant.file).normalize("NFC");
      if (files.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "variants", variantId, "file"],
          message: "Duplicate variant file: " + variant.file
        });
      }
      files.add(key);
    }
  }
}

/** Validates a pack manifest, including collection-wide uniqueness of item IDs and variant files. */
export const packSchema = z.object({
  id,
  name: text,
  version: text,
  license: text,
  attribution: text.optional(),
  items: z.array(itemSchema).max(MAX_ITEMS)
}).strict().superRefine(checkPackUniqueness);

/** A validated pack manifest. */
export type ArtPack = z.infer<typeof packSchema>;

/** A validated subject within a pack. */
export type ArtItem = z.infer<typeof itemSchema>;
