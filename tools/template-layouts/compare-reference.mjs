// Compare pictures only. No pixels or coordinates are read back into template geometry.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";
import { repositoryRoot } from "./generate.mjs";

const args = process.argv.slice(2), options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1];
  if (!["--ours", "--reference", "--out"].includes(key) || !value || options.has(key)) {
    throw new Error("Usage: compare-reference.mjs --ours <PNG> --reference <PNG> --out <PNG>");
  }
  options.set(key, value);
}
if (options.size !== 3) throw new Error("Usage: compare-reference.mjs --ours <PNG> --reference <PNG> --out <PNG>");
register({ tsconfig: path.join(repositoryRoot, "tsconfig.json") });
registerCjs({ tsconfig: path.join(repositoryRoot, "tsconfig.json") });
const { svgToPng } = await import(pathToFileURL(path.join(repositoryRoot, "packages/chemdraft-cli/src/document.ts")).href);
const pictures = await Promise.all(["--ours", "--reference"].map(key => readFile(path.resolve(options.get(key)))));
const embed = (picture, x) => `<image x="${x}" y="65" width="550" height="490" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${picture.toString("base64")}"/>`;
const label = (text, x) => `<text x="${x}" y="36" text-anchor="middle" font-family="Arial, sans-serif" font-size="21">${text}</text>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1160" height="580" viewBox="0 0 1160 580"><rect width="100%" height="100%" fill="white"/>${
  label("ChemDraft p-tert-butylcalix[4]arene", 290) + label("Owner reference (picture only)", 870)
  + embed(pictures[0], 15) + embed(pictures[1], 595)}</svg>`;
const out = path.resolve(options.get("--out"));
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, svgToPng(svg, 1160));
console.log(out);
