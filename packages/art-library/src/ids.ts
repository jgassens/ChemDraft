import { MAX_ID_LENGTH } from "./limits";

/** The pack ID grammar shared by pack, item and variant IDs. */
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/u;

function truncateId(value: string, limit: number): string {
  return value.slice(0, limit).replace(/-$/, "");
}

/** Folds arbitrary import labels into an ID that satisfies the pack grammar. */
export function slugId(value: string, fallback: string): string {
  const slug = value.normalize("NFKD").toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return truncateId(slug, MAX_ID_LENGTH) || fallback;
}

/** Allocates stable, unique IDs in the order items are discovered. */
export function allocateItemId(value: string, used: Set<string>, nextSuffix: Map<string, number>): string {
  const base = slugId(value, "item");
  let id = base;
  let suffix = nextSuffix.get(base) ?? 2;
  while (used.has(id)) {
    const ending = "-" + suffix++;
    id = truncateId(base, MAX_ID_LENGTH - ending.length) + ending;
  }
  nextSuffix.set(base, suffix);
  used.add(id);
  return id;
}
