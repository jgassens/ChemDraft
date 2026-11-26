import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPack, checkPack } from "./build.mjs";

async function withPack(svg: string, test: (paths: { source: string; dest: string; art: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "chemdraft-art-pack-"));
  const source = join(root, "source");
  const dest = join(root, "pack");
  try {
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(source, "manifest.json"), JSON.stringify({
      subjects: [{
        id: "test", name: "Test", description: "", category: "Tests", subcategory: "SVG",
        variants: { one: "assets/test.svg" }
      }]
    }));
    await writeFile(join(source, "assets", "test.svg"), svg);
    await buildPack(source, dest);
    await test({ source, dest, art: join(dest, "art", "test.svg") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';

describe("built-in art pack", () => {
  it("validates committed SVGs and checksums", () => {
    execFileSync(process.execPath, ["--import", "tsx", "tools/art-pack/build.mjs", "--check"], {
      cwd: process.cwd(),
      stdio: "pipe"
    });
  }, 120000);

  it("reports an orphan and a stale report, and rebuilds a clean destination", async () => {
    await withPack(svg, async ({ source, dest }) => {
      const report = join(dest, "SANITIZATION.txt");
      const originalReport = await readFile(report, "utf8");
      const orphan = join(dest, "art", "old", "unlisted.txt");
      await mkdir(join(dest, "art", "old"));
      await writeFile(orphan, "old export");
      await expect(checkPack(dest)).rejects.toThrow("Unlisted art entry: art/old/unlisted.txt");

      await rm(join(dest, "art", "old"), { recursive: true });
      await writeFile(report, "stale");
      await expect(checkPack(dest)).rejects.toThrow("Stale SANITIZATION.txt");

      const manifest = join(dest, "pack.json");
      const manifestContents = await readFile(manifest, "utf8");
      await writeFile(manifest, manifestContents.trim());
      await expect(checkPack(dest)).rejects.toThrow("Noncanonical pack.json");

      await mkdir(join(dest, "art", "old"));
      await writeFile(orphan, "old export");
      await buildPack(source, dest);
      await expect(readFile(orphan)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(report, "utf8")).toBe(originalReport);
      await rm(source, { recursive: true });
      await expect(checkPack(dest)).resolves.toBeUndefined();
    });
  });

  it("strips inter-element trailing whitespace while preserving text and xml:space", async () => {
    const indent = " \t\n";
    const sourceSvg = [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">',
      '<g>\n', indent, '<rect width="10" height="10"/>\n', indent, '</g>',
      '<text>A', indent, '<tspan>\n', indent, '</tspan>B</text>',
      '<g xml:space="preserve">\n', indent, '<g>\n', indent, '<circle r="1"/></g></g>',
      '</svg>'
    ].join("");
    await withPack(sourceSvg, async ({ dest, art }) => {
      const expected = sourceSvg.replace('<g>\n' + indent, '<g>\n\n')
        .replace('height="10"/>\n' + indent, 'height="10"/>\n\n');
      expect(await readFile(art, "utf8")).toBe(expected);
      await expect(checkPack(dest)).resolves.toBeUndefined();
    });
  });
});
