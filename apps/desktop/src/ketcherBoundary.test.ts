import { describe, expect, it } from "vitest";

const sourceModules = import.meta.glob([
  "./**/*.{ts,tsx}",
  "../../../packages/*/src/**/*.{ts,tsx}"
], {
  query: "?raw",
  import: "default",
  eager: true
}) as Record<string, string>;

const allowedDirectKetcherImports = new Set(["apps/desktop/src/KetcherEditorHost.tsx"]);
const directKetcherImportPattern =
  /(?:from\s+["']ketcher-(?:react|standalone|core)["']|import\(["']ketcher-(?:react|standalone|core)(?:\/dist\/index\.css)?["']\))/;

describe("Ketcher integration boundary", () => {
  it("keeps direct Ketcher imports inside the narrow desktop host component", () => {
    const directImportFiles = Object.entries(sourceModules)
      .filter(([, contents]) => directKetcherImportPattern.test(contents))
      .map(([path]) => normalizeSourcePath(path))
      .sort();

    expect(directImportFiles).toEqual([...allowedDirectKetcherImports]);
  });
});

function normalizeSourcePath(path: string): string {
  return path
    .replace(/^\.\//, "apps/desktop/src/")
    .replace(/^\.\.\/\.\.\/\.\.\/packages\//, "packages/")
    .replaceAll("\\", "/");
}
