import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { JSDOM } from "jsdom";
import { sanitizeSvgPicture } from "../../packages/export-engine/src/svgSafety/svgSanitizer.ts";
import { readSvgInfo } from "../../packages/chem-core/src/imageInfo.ts";
import { packSchema, svgPathSchema } from "../../packages/art-library/src/index.ts";

const script = fileURLToPath(import.meta.url);
const dest = path.resolve(path.dirname(script), "../../data/art/bioart");
const { window } = new JSDOM("");
const options = { domParser: new window.DOMParser(), xmlSerializer: new window.XMLSerializer() };
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const TEXT_ELEMENTS = new Set(["text", "tspan", "textPath", "style", "title", "desc", "metadata"]);
const PACK_METADATA = {
  id: "bioart",
  name: "BioArt",
  version: "3.1",
  license: "CC-BY-4.0",
  attribution: "ChemDraft BioArt"
};
const OUTPUT_NAMES = ["art", "pack.json", "SANITIZATION.txt"];

function hash(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

// Keep line breaks, text content, CSS, metadata, CDATA and all xml:space-preserved descendants.
function trimInterElementWhitespace(svg) {
  if (!/[ \t]\n/.test(svg)) return svg;

  const document = options.domParser.parseFromString(svg, "image/svg+xml");
  let changed = false;
  function visit(element) {
    if (TEXT_ELEMENTS.has(element.localName) || element.getAttributeNS(XML_NS, "space") === "preserve") return;
    if (!element.firstElementChild) return;

    for (const child of element.childNodes) {
      if (child.nodeType === window.Node.ELEMENT_NODE) {
        visit(child);
      } else if (child.nodeType === window.Node.TEXT_NODE && /^[ \t\n]*$/.test(child.data)) {
        // The last line's indentation belongs to the following tag.
        const lines = child.data.split("\n");
        for (let index = 0; index < lines.length - 1; index++) {
          lines[index] = lines[index].replace(/[ \t]+$/, "");
        }
        const trimmed = lines.join("\n");
        if (trimmed !== child.data) {
          child.data = trimmed;
          changed = true;
        }
      }
    }
  }
  visit(document.documentElement);
  return changed ? options.xmlSerializer.serializeToString(document.documentElement) : svg;
}

function packJson(pack) {
  return JSON.stringify(pack, null, 2) + "\n";
}

function allVariants(pack) {
  return pack.items.flatMap(item => Object.values(item.variants));
}

function sanitizationReport(manifest, variants) {
  return [
    `Sanitized SVGs (${variants.length}). All listed files are in canonical sanitized form.`,
    `Pack manifest SHA-256: ${hash(manifest)}`,
    "",
    ...variants.map(variant => `${variant.sha256}  ${variant.file}`),
    ""
  ].join("\n");
}

async function verifyArtTree(destination, variants) {
  const files = new Set();
  const folders = new Set(["art"]);
  for (const { file } of variants) {
    if (!file.startsWith("art/")) throw new Error(`Expected a variant under art/: ${file}`);
    files.add(file);
    const parts = file.split("/");
    for (let depth = 2; depth < parts.length; depth++) {
      folders.add(parts.slice(0, depth).join("/"));
    }
  }

  async function visit(parts) {
    const entries = await readdir(path.join(destination, ...parts), { withFileTypes: true });
    for (const entry of entries) {
      const entryParts = [...parts, entry.name];
      const relative = entryParts.join("/");
      if (entry.isDirectory()) {
        await visit(entryParts);
        if (folders.has(relative)) continue;
      } else if (entry.isFile() && files.delete(relative)) {
        continue;
      }
      throw new Error(`Unlisted art entry: ${relative}`);
    }
  }

  if (!(await lstat(path.join(destination, "art"))).isDirectory()) throw new Error("Expected an art directory");
  await visit(["art"]);
  if (files.size) throw new Error(`Missing variant file: ${files.values().next().value}`);
}

async function readGeneratedFile(file) {
  if (!(await lstat(file)).isFile()) throw new Error(`Expected a regular generated file: ${file}`);
  return readFile(file);
}

/** Verifies the generated pack, exact file inventory, canonical bytes, and report without sources. */
export async function checkPack(destination = dest) {
  const entries = new Set(await readdir(destination));
  for (const name of OUTPUT_NAMES) {
    if (!entries.has(name)) throw new Error(`Missing generated pack entry: ${name}`);
  }
  const manifest = await readGeneratedFile(path.join(destination, "pack.json"));
  const pack = packSchema.parse(JSON.parse(manifest.toString("utf8")));
  const serialized = packJson(pack);
  if (!manifest.equals(Buffer.from(serialized)) ||
      Object.entries(PACK_METADATA).some(([key, value]) => pack[key] !== value)) {
    throw new Error("Noncanonical pack.json");
  }

  const variants = allVariants(pack);
  await verifyArtTree(destination, variants);
  for (const variant of variants) {
    const bytes = await readGeneratedFile(path.join(destination, ...variant.file.split("/")));
    if (hash(bytes) !== variant.sha256) throw new Error(`Hash mismatch: ${variant.file}`);
    const source = bytes.toString("utf8");
    const result = sanitizeSvgPicture(source, options);
    if (!result.ok || result.removedActive || result.removedExternal ||
        !bytes.equals(Buffer.from(trimInterElementWhitespace(result.svg)))) {
      throw new Error(`Not canonically sanitized: ${variant.file}`);
    }
    const size = readSvgInfo(source)?.physicalSize;
    if (!size || size.width !== variant.width || size.height !== variant.height) {
      throw new Error(`Size mismatch: ${variant.file}`);
    }
  }

  const reportPath = path.join(destination, "SANITIZATION.txt");
  const report = await readGeneratedFile(reportPath);
  if (!report.equals(Buffer.from(sanitizationReport(serialized, variants)))) throw new Error("Stale SANITIZATION.txt");
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
    variants: Object.create(null)
  };
}

async function stagePack(sourceDir, stage) {
  const manifest = JSON.parse(await readFile(path.join(sourceDir, "manifest.json"), "utf8"));
  const pack = { ...PACK_METADATA, items: [] };
  await mkdir(path.join(stage, "art"));
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
      const svg = trimInterElementWhitespace(result.svg);
      if (input !== svg) changed++;
      if (result.removedActive) active++;
      if (result.removedExternal) external++;

      const size = readSvgInfo(svg)?.physicalSize;
      if (!size) throw new Error(`Missing size: ${relative}`);
      const file = `art/${relative.slice("assets/".length)}`;
      item.variants[variant] = { file, sha256: hash(svg), width: size.width, height: size.height };
      const target = path.join(stage, ...file.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, svg);
    }
    pack.items.push(item);
  }

  const validated = packSchema.parse(pack);
  const serialized = packJson(validated);
  await writeFile(path.join(stage, "pack.json"), serialized);
  await writeFile(path.join(stage, "SANITIZATION.txt"), sanitizationReport(serialized, allVariants(validated)));

  return `Built ${pack.items.length} items; ${changed} serialized differently, ${active} active content removals, ` +
    `${external} external or unsupported content removals`;
}

async function publishPack(stage, destination) {
  const backup = path.join(stage, "previous");
  await mkdir(backup);
  const saved = [];
  const published = [];
  try {
    for (const name of OUTPUT_NAMES) {
      try {
        await rename(path.join(destination, name), path.join(backup, name));
        saved.push(name);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    for (const name of OUTPUT_NAMES) {
      await rename(path.join(stage, name), path.join(destination, name));
      published.push(name);
    }
  } catch (error) {
    try {
      for (const name of published.reverse()) await rename(path.join(destination, name), path.join(stage, name));
      for (const name of saved.reverse()) await rename(path.join(backup, name), path.join(destination, name));
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], `Pack rollback failed; previous files are in ${backup}`);
    }
    throw error;
  }
}

/** Builds and replaces the generated files together after validating the source pack. */
export async function buildPack(sourceDir, destination = dest) {
  if (!sourceDir) throw new Error("Provide the BioArt source directory");
  await mkdir(destination, { recursive: true });
  const stage = await mkdtemp(path.join(destination, ".art-pack-"));
  try {
    const summary = await stagePack(sourceDir, stage);
    await publishPack(stage, destination);
    console.log(summary);
  } catch (error) {
    if (error instanceof AggregateError) throw error; // Keep the backup available for recovery.
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  await rm(stage, { recursive: true, force: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  if (process.argv.includes("--check")) {
    await checkPack();
  } else {
    await buildPack(process.argv[2]);
  }
}
