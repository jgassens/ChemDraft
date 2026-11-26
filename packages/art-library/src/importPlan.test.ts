import { describe, expect, it } from "vitest";
import { MAX_ID_LENGTH, planImport, readForeignManifest } from "./index";

function discoveredFiles(...paths: string[]) {
  return paths.map(path => ({ path, sha256: path, byteSize: 1 }));
}

function planFromManifest(paths: string[], manifest: unknown) {
  return planImport(discoveredFiles(...paths), readForeignManifest(manifest, paths), "Dropped folder");
}

describe("art import planning", () => {
  it("groups a manifest subject even if its variant filenames have different stems", () => {
    const plan = planFromManifest(["light.svg", "dark.svg", "other.svg"], {
      subjects: [
        { name: "Lymph node", variants: { light: "light.svg", dark: "dark.svg" } },
        { name: "Lymph node", variants: { light: "other.svg" } }
      ]
    });
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]).toMatchObject({
      name: "Lymph node",
      variants: { light: { path: "light.svg" }, dark: { path: "dark.svg" } }
    });
    expect(Object.keys(plan.items[1]!.variants)).toEqual(["light"]);
    expect(plan.leftOut).toEqual([]);
  });

  it.each([
    [{"id": "node", "display_name": "Node light"}, {"id": "node", "display_name": "Node dark"}],
    [{"id": "light", "display_name": "Lymph node"}, {"id": "dark", "display_name": "Lymph node"}]
  ])("groups asset rows by shared id or display name", (light, dark) => {
    const plan = planFromManifest(["light.svg", "dark.svg"], {
      assets: [
        { ...light, style: "Light", path: "light.svg" },
        { ...dark, style: "Dark", path: "dark.svg" }
      ]
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]!.variants).toEqual({
      light: { path: "light.svg", sha256: "light.svg", byteSize: 1 },
      dark: { path: "dark.svg", sha256: "dark.svg", byteSize: 1 }
    });
    expect(plan.leftOut).toEqual([]);
  });

  it("normalizes unsafe variant keys and explains collisions", () => {
    const variants = JSON.parse('{"__proto__":"a.svg","constructor":"b.svg","Light Style":"c.svg","light-style":"d.svg"}');
    variants["x".repeat(MAX_ID_LENGTH + 1)] = "e.svg";
    const plan = planFromManifest(["a.svg", "b.svg", "c.svg", "d.svg", "e.svg"], {
      subjects: [{ name: "Lymph node", variants }]
    });
    const chosen = plan.items[0]!.variants;
    expect(Object.getPrototypeOf(chosen)).toBeNull();
    expect(Object.keys(chosen)).toEqual(["proto", "constructor", "light-style", "x".repeat(MAX_ID_LENGTH)]);
    expect(chosen["proto"]?.path).toBe("a.svg");
    expect(plan.leftOut).toEqual([{ file: discoveredFiles("d.svg")[0], reason: 'Variant "light-style" already chosen' }]);
  });

  it("ignores inherited entries in file hints", () => {
    const files = discoveredFiles("a.svg", "b.svg");
    const hints = Object.assign(Object.create({ "b.svg": { name: "Inherited" } }), {
      "a.svg": { name: "Own" }
    });
    const plan = planImport(files, { files: hints });
    expect(plan.items.map(item => item.name)).toEqual(["Own"]);
    expect(plan.leftOut[0]?.file.path).toBe("b.svg");
  });

  it("allocates canonical collection-wide item IDs deterministically", () => {
    const longStem = "x".repeat(MAX_ID_LENGTH + 1);
    const files = discoveredFiles("b/cell.svg", "a/cell.svg", "My Cell.svg", "Café.svg", "细胞.svg",
      "a/" + longStem + ".svg", "b/" + longStem + ".svg", "a/middle/one/node.svg", "a/other/one/node.svg");
    const plan = planImport(files);
    const ids = plan.items.map(item => item.id);
    expect(ids).toHaveLength(files.length);
    expect(new Set(ids)).toEqual(new Set([
      "cell", "cell-2", "my-cell", "cafe", "item", "x".repeat(MAX_ID_LENGTH), "x".repeat(MAX_ID_LENGTH - 2) + "-2",
      "node", "node-2"
    ]));
    expect(plan.items.find(item => item.id === "item")?.name).toBe("细胞");
    expect(planImport([...files].reverse())).toEqual(plan);
  });

  it("reports why a recognized manifest was ignored and discovers loose files", () => {
    const plan = planFromManifest(["cell.svg", "proofs/copy.svg", "unsafe/../x.svg"], {
      title: "Unavailable collection",
      assets: [{ path: "missing.svg" }, { path: "proofs/copy.svg" }, { path: "unsafe/../x.svg" }]
    });
    expect(plan.name).toBe("Dropped folder");
    expect(plan.items.map(item => item.id)).toEqual(["cell"]);
    expect(plan.manifestIgnoredReason).toMatch(/manifest ignored.*no usable/i);
    expect(plan.leftOut.map(entry => entry.reason)).toEqual(["Non-art folder", "Not a safe SVG path"]);
  });

  it("accepts uppercase loose SVGs and omits the art root at both category levels", () => {
    const paths = ["CELL.SVG", "assets/cells/immune/node.SVG", "Art/cells/spleen.svg", "svg/sample.svg"];
    const plan = planImport(discoveredFiles(...paths));
    expect(plan.leftOut).toEqual([]);
    expect(plan.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cell", category: "Uncategorized", subcategory: "General" }),
      expect.objectContaining({ id: "node", category: "Cells", subcategory: "Immune" }),
      expect.objectContaining({ id: "spleen", category: "Cells", subcategory: "General" }),
      expect.objectContaining({ id: "sample", category: "Uncategorized", subcategory: "General" })
    ]));
    const withManifest = planFromManifest(paths, {
      assets: [{ path: "CELL.SVG", display_name: "From manifest", style: "Default" }]
    });
    expect(withManifest.items.map(item => item.name)).toEqual(["From manifest"]);
  });
});
