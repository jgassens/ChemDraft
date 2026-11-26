import { describe, expect, it } from "vitest";
import { itemSchema, MAX_DIMENSION, MAX_ITEMS, MAX_KEYWORDS, MAX_VARIANTS, packSchema, svgPathSchema } from "./index";

const variant = { file: "art/cell.svg", sha256: "a".repeat(64), width: 10, height: 20 };
const item = {
  id: "cell", name: "Cell", description: "", category: "Cells", subcategory: "Immune",
  keywords: [], variants: { default: variant }
};
const pack = { id: "p", name: "Pack", version: "1", license: "CC-BY-4.0", items: [item] };

describe("art pack limits and paths", () => {
  it("allows exactly the maximum item count and rejects one more", () => {
    const items = Array.from({ length: MAX_ITEMS }, (_, i) => ({
      ...item, id: "cell-" + i, variants: { default: { ...variant, file: "art/cell-" + i + ".svg" } }
    }));
    expect(packSchema.safeParse({ ...pack, items }).success).toBe(true);
    expect(packSchema.safeParse({ ...pack, items: [...items, { ...item, id: "extra" }] }).success).toBe(false);
  });

  it("rejects duplicate item ids even with distinct variant files", () => {
    const duplicate = { ...item, variants: { default: { ...variant, file: "art/other.svg" } } };
    expect(() => packSchema.parse({ ...pack, items: [item, duplicate] })).toThrow("Duplicate item id: cell");
  });

  it("checks both sides of the variant limit and the keyword limit", () => {
    const variants = Object.fromEntries(Array.from({ length: MAX_VARIANTS }, (_, i) => [
      "v-" + i, { ...variant, file: "art/v-" + i + ".svg" }
    ]));
    const keywords = Array.from({ length: MAX_KEYWORDS }, (_, i) => "keyword-" + i);
    expect(itemSchema.safeParse({ ...item, variants, keywords }).success).toBe(true);
    expect(itemSchema.safeParse({ ...item, variants: { ...variants, extra: variant } }).success).toBe(false);
    expect(itemSchema.safeParse({ ...item, variants: {} }).success).toBe(false);
    expect(itemSchema.safeParse({ ...item, keywords: [...keywords, "extra"] }).success).toBe(false);
  });

  it("builds a null-prototype variant record and rejects invalid keys", () => {
    const variants = Object.assign(Object.create({ inherited: variant }), { constructor: variant });
    const parsed = itemSchema.parse({ ...item, variants }).variants;
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.keys(parsed)).toEqual(["constructor"]);
    expect(itemSchema.safeParse({ ...item, variants: { ["__proto__"]: variant } }).success).toBe(false);
    expect(itemSchema.safeParse({ ...item, variants: { "lowercase\n": variant } }).success).toBe(false);
  });

  it.each(["width", "height"] as const)("requires a finite positive %s within the limit", dimension => {
    const sized = (value: number) => ({ ...item, variants: { default: { ...variant, [dimension]: value } } });
    expect(itemSchema.safeParse(sized(MAX_DIMENSION)).success).toBe(true);
    for (const invalid of [0, -1, Infinity, NaN, MAX_DIMENSION + 1]) {
      expect(itemSchema.safeParse(sized(invalid)).success).toBe(false);
    }
  });

  it.each([
    "art/CON.svg", "art/nul/cell.svg", "art/COM1.svg", "art/lpt².more.svg", "art/aux .svg",
    "art/conout$.svg", "art/folder./cell.svg", "art/folder /cell.svg", "art/cell.svg ", "art/cell?.svg",
    "art/CELL.SVG"
  ])("rejects Windows aliases and noncanonical pack path %s", file => {
    expect(svgPathSchema.safeParse(file).success).toBe(false);
  });

  it.each(["ART/CELL.svg", "art./cell.svg", "art /cell.svg", "art/cell.svg"])(
    "rejects colliding variant path %s across items and within an item", file => {
      const alias = { ...variant, file };
      expect(() => packSchema.parse({ ...pack, items: [{ ...item, variants: { one: variant, two: alias } }] }))
        .toThrow("Duplicate variant file");
      const other = { ...item, id: "other", variants: { default: alias } };
      expect(() => packSchema.parse({ ...pack, items: [item, other] })).toThrow("Duplicate variant file");
    }
  );

  it("rejects canonically equivalent variant paths while preserving distinct paths", () => {
    const composed = { ...variant, file: "art/é.svg" };
    const decomposed = { ...variant, file: "art/e\u0301.svg" };
    const withVariants = (second: typeof variant) => ({
      ...pack, items: [{ ...item, variants: { one: composed, two: second } }]
    });
    expect(() => packSchema.parse(withVariants(decomposed))).toThrow("Duplicate variant file");
    const distinct = { ...variant, file: "art/ê.svg" };
    expect(packSchema.parse(withVariants(distinct)).items[0]!.variants.one!.file).toBe(composed.file);
  });
});
