import type { ArtItem } from "./schema";

/** A named collection of art items. */
export interface CatalogCollection {
  id: string;
  name: string;
  items: ArtItem[];
}

/** The collections available in the library. */
export interface ArtCatalog {
  collections: CatalogCollection[];
}

/** Categories and subcategories within one collection. */
export interface CategoryTree {
  collection: CatalogCollection;
  categories: { name: string; subcategories: { name: string; items: ArtItem[] }[] }[];
}

/** Groups catalog items by category and subcategory in their original order. */
export function buildCategoryTree(catalog: ArtCatalog): CategoryTree[] {
  return catalog.collections.map(collection => {
    const categories: CategoryTree["categories"] = [];
    for (const item of collection.items) {
      let category = categories.find(entry => entry.name === item.category);
      if (!category) {
        category = { name: item.category, subcategories: [] };
        categories.push(category);
      }

      let subcategory = category.subcategories.find(entry => entry.name === item.subcategory);
      if (!subcategory) {
        subcategory = { name: item.subcategory, items: [] };
        category.subcategories.push(subcategory);
      }
      subcategory.items.push(item);
    }
    return { collection, categories };
  });
}
