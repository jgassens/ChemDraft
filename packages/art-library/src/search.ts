import type { ArtCatalog, CatalogCollection } from "./catalog";
import type { ArtItem } from "./schema";

/** Folds case, Greek letters, spacing, and punctuation for name matching. */
export function normalizeArtSearch(text: string): string {
  const greek: Record<string, string> = { α: "alpha", ɑ: "alpha", β: "beta", γ: "gamma", δ: "delta" };
  return text.normalize("NFKC").toLowerCase()
    .replace(/[αɑβγδ]/gu, letter => greek[letter]!)
    .replace(/[\s\p{White_Space}\p{Dash}()[\]{},'\u2018-\u201B\u02B9-\u02BC\u2032-\u2037]/gu, "");
}

function wordScore(word: string, name: string, keywords: string, description: string, category: string): number {
  if (name.startsWith(word)) return 0;
  if (name.includes(word)) return 1;
  if (keywords.includes(word)) return 2;
  if (description.includes(word)) return 3;
  if (category.includes(word)) return 4;
  return 100;
}

/** Finds entries that match every query word, ordered by match quality. */
export function searchCatalog(catalog: ArtCatalog, query: string): { collection: CatalogCollection; item: ArtItem }[] {
  const words = query.trim().split(/\s+/u).map(normalizeArtSearch).filter(Boolean);
  const entries = catalog.collections.flatMap(collection => collection.items.map(item => ({ collection, item })));
  return entries.map((entry, index) => {
    const { collection, item } = entry;
    const name = normalizeArtSearch(item.name);
    const keywords = normalizeArtSearch(item.keywords.join(" "));
    const description = normalizeArtSearch(item.description);
    const category = normalizeArtSearch(`${collection.name} ${item.category} ${item.subcategory}`);
    const scores = words.map(word => wordScore(word, name, keywords, description, category));
    return {
      entry,
      index,
      score: scores.reduce<number>((sum, score) => sum + score, 0),
      matches: scores.every(score => score < 100)
    };
  }).filter(result => result.matches)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map(result => result.entry);
}
