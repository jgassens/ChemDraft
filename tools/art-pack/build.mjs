import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { sanitizeSvgPicture } from "../../packages/export-engine/src/svgSafety/svgSanitizer.ts";
import { readSvgInfo } from "../../packages/chem-core/src/imageInfo.ts";
import { packSchema, svgPathSchema } from "../../packages/art-library/src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dest = path.join(root, "data", "art", "bioart");
const { window } = new JSDOM("");
const options = { domParser: new window.DOMParser(), xmlSerializer: new window.XMLSerializer() };

function hash(svg) {
  return createHash("sha256").update(svg).digest("hex");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function checkPack() {
  const pack = packSchema.parse(await readJson(path.join(dest, "pack.json")));
  for (const item of pack.items) {
    for (const variant of Object.values(item.variants)) {
      const source = await readFile(path.join(dest, ...variant.file.split("/")), "utf8");
      if (hash(source) !== variant.sha256) throw new Error(`Hash mismatch: ${variant.file}`);
      const result = sanitizeSvgPicture(source, options);
      if (!result.ok || result.svg !== source || result.removedActive || result.removedExternal) {
        throw new Error(`Not sanitized: ${variant.file}`);
      }
      const size = readSvgInfo(source)?.physicalSize;
      if (!size || size.width !== variant.width || size.height !== variant.height) {
        throw new Error(`Size mismatch: ${variant.file}`);
      }
    }
  }
  console.log(`Verified ${pack.items.length} items`);
}

function packItem(subject) {
  const keywords = [subject.group, subject.subcategory, subject.source_display_name]
    .filter(value => typeof value === "string" && value.length);
  return {
    id: subject.id,
    name: subject.name,
    description: subject.description,
    category: subject.category,
    subcategory: subject.subcategory,
    keywords: [...new Set(keywords)],
    variants: {}
  };
}

async function buildPack(sourceDir) {
  if (!sourceDir) throw new Error("Provide the BioArt source directory");
  const manifest = await readJson(path.join(sourceDir, "manifest.json"));
  const pack = {
    id: "bioart",
    name: "BioArt",
    version: "3.1",
    license: "CC-BY-4.0",
    attribution: "ChemDraft BioArt",
    items: []
  };
  let changed = 0;
  let active = 0;
  let external = 0;
  for (const subject of manifest.subjects) {
    const item = packItem(subject);
    for (const [variant, relative] of Object.entries(subject.variants)) {
      if (!svgPathSchema.safeParse(relative).success || !relative.startsWith("assets/")) {
        throw new Error(`Unsafe source: ${relative}`);
      }
      const input = await readFile(path.join(sourceDir, ...relative.split("/")), "utf8");
      const result = sanitizeSvgPicture(input, options);
      if (!result.ok) throw new Error(`${relative}: ${result.error}`);
      if (input !== result.svg) changed++;
      if (result.removedActive) active++;
      if (result.removedExternal) external++;

      const size = readSvgInfo(result.svg)?.physicalSize;
      if (!size) throw new Error(`Missing size: ${relative}`);
      const file = `art/${relative.slice("assets/".length)}`;
      item.variants[variant] = { file, sha256: hash(result.svg), width: size.width, height: size.height };
      const target = path.join(dest, ...file.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, result.svg);
    }
    pack.items.push(item);
  }
  packSchema.parse(pack);
  await writeFile(path.join(dest, "pack.json"), JSON.stringify(pack, null, 2) + "\n");
  console.log(
    `Built ${pack.items.length} items; ${changed} serialized differently, ${active} active content removals, ` +
    `${external} external or unsupported content removals`
  );
}

if (process.argv.includes("--check")) {
  await checkPack();
} else {
  await buildPack(process.argv[2]);
}
