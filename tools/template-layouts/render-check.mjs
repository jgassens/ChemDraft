import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";
import { register as registerCjs } from "tsx/cjs/api";
import { repositoryRoot } from "./generate.mjs";

// Use this checkout's TS paths even when launched from another working directory.
register({ tsconfig: path.join(repositoryRoot, "tsconfig.json") });
registerCjs({ tsconfig: path.join(repositoryRoot, "tsconfig.json") });
const load = (relative) => import(pathToFileURL(path.join(repositoryRoot, relative)).href);
const { createEmptyDocument } = await load("packages/chem-core/src/index.ts");
const { structureTemplates } = await load("packages/template-library/src/index.ts");
const { structureTemplateMolecule } = await load("packages/document-workflow-core/src/index.ts");
const { nativeMoleculeBondDrawingStyle } = await load("packages/layout-engine/src/index.ts");
const { exportDocumentToSvg } = await load("packages/export-engine/src/index.ts");
// Exactly the exporter/crop/raster pipeline used by `chemdraft render-document`.
const { cropDocumentSvgToContent, svgToPng } = await load("packages/chemdraft-cli/src/document.ts");
const { installNodeRendering } = await load("packages/chemdraft-cli/src/nodeRendering.ts");
const { renderedLabelClearance } = await load("tools/template-layouts/label-clearance.ts");

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node tools/template-layouts/render-check.mjs [--out <directory>] [--family <family>] [--ids <id,id,...>]");
  process.exit(0);
}
const options = new Map();
for (let index = 0; index < args.length; index += 2) {
  const key = args[index], value = args[index + 1];
  if (!["--out", "--family", "--ids"].includes(key) || !value || value.startsWith("--") || options.has(key)) {
    throw new Error("Usage: render-check.mjs [--out <directory>] [--family <family>] [--ids <id,id,...>]");
  }
  options.set(key, value);
}
const ids = options.has("--ids") ? new Set(options.get("--ids").split(",")) : null;
const selected = structureTemplates
  .filter(template => (!options.has("--family") || template.family === options.get("--family")) && (!ids || ids.has(template.id)));
if (!selected.length) throw new Error(`Unknown or empty template family: ${options.get("--family")}`);
if (ids && selected.length !== ids.size) throw new Error("--ids contains an unknown template or an ID outside --family");
const out = options.has("--out") ? path.resolve(options.get("--out")) : path.join(repositoryRoot, "tools", "template-layouts", ".check");
await mkdir(out, { recursive: true });
installNodeRendering();

const escapeXml = (text) => text.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
})[char]);
const columns = 3, cellWidth = 360, cellHeight = 310;
const cells = [];
const trueScaleImages = [];
const labelClearances = [];
const renderReviews = [];
for (const [index, template] of selected.entries()) {
  const document = createEmptyDocument({ title: template.name });
  const molecule = structureTemplateMolecule(template, {
    document, centre: { x: document.pages[0].width / 2, y: document.pages[0].height / 2 }
  });
  document.pages[0].objects.push(molecule);
  labelClearances.push({ id: template.id, ...renderedLabelClearance(molecule) });
  const exported = exportDocumentToSvg(document, { background: "#ffffff" });
  if (exported.warnings.length) {
    throw new Error(`${template.id}: ${exported.warnings.map((warning) => warning.message).join("; ")}`);
  }
  const cropped = cropDocumentSvgToContent(exported.contents, document, 24, "white", true);
  const widths = molecule.bonds.filter(bond => bond.display?.bondStyle === "bold")
    .map(bond => nativeMoleculeBondDrawingStyle(molecule, bond.id).bondBoldWidthPx);
  const svgStrokeWidths = [...new Set([...exported.contents.matchAll(/stroke-width="([\d.]+)"/g)].map(match => Number(match[1])))];
  if (widths.length && widths.some(width => !svgStrokeWidths.some(value => Math.abs(value - width) < 0.0001))) {
    throw new Error(`${template.id}: inserted bold widths missing from the real SVG export`);
  }
  renderReviews.push({ id: template.id, bondLengthPx: molecule.style.bondLengthPx,
    boldBondCount: widths.length, boldWidthsPx: [...new Set(widths)], svgStrokeWidths,
    cropViewBox: cropped.viewBox, rasterWidthPx: 800 });
  const png = svgToPng(cropped.svg, 800);
  const file = path.join(out, `${template.id}.png`);
  await writeFile(file, png);
  console.log(file);
  const x = (index % columns) * cellWidth, y = Math.floor(index / columns) * cellHeight;
  cells.push(`<image x="${x + 12}" y="${y + 12}" width="${cellWidth - 24}" height="${cellHeight - 52}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${Buffer.from(png).toString("base64")}"/>` +
    `<text x="${x + cellWidth / 2}" y="${y + cellHeight - 16}" text-anchor="middle" font-family="Arial, sans-serif" font-size="16">${escapeXml(template.name)}</text>`);
  // The cropped viewBox is in native document units. Reuse it as the displayed size,
  // rather than the 800px inspection raster's dimensions: one native unit is one sheet
  // pixel: flat means and projection maxima equal the document default (22px).
  trueScaleImages.push({ name: template.name, png, width: cropped.viewBox.width, height: cropped.viewBox.height });
}
const width = columns * cellWidth;
await writeFile(path.join(out, "label-clearance.json"), JSON.stringify(labelClearances, null, 2) + "\n");
await writeFile(path.join(out, "render-review.json"), JSON.stringify(renderReviews, null, 2) + "\n");
const height = Math.max(1, Math.ceil(selected.length / columns)) * cellHeight;
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/>${cells.join("")}</svg>`;
const sheetPath = path.join(out, "contact-sheet.png");
await writeFile(sheetPath, svgToPng(sheet, width));
console.log(sheetPath);

const trueCellWidth = Math.ceil(Math.max(cellWidth, ...trueScaleImages.map((entry) => entry.width + 24)));
const trueCellHeight = Math.ceil(Math.max(cellHeight, ...trueScaleImages.map((entry) => entry.height + 52)));
const trueWidth = columns * trueCellWidth;
const trueHeight = Math.max(1, Math.ceil(trueScaleImages.length / columns)) * trueCellHeight;
const trueCells = trueScaleImages.map((entry, index) => {
  const x = (index % columns) * trueCellWidth, y = Math.floor(index / columns) * trueCellHeight;
  return `<image x="${x + (trueCellWidth - entry.width) / 2}" y="${y + 12 + (trueCellHeight - 52 - entry.height) / 2}" width="${entry.width}" height="${entry.height}" href="data:image/png;base64,${Buffer.from(entry.png).toString("base64")}"/>` +
    `<text x="${x + trueCellWidth / 2}" y="${y + trueCellHeight - 16}" text-anchor="middle" font-family="Arial, sans-serif" font-size="16">${escapeXml(entry.name)}</text>`;
});
const trueSheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${trueWidth}" height="${trueHeight}" viewBox="0 0 ${trueWidth} ${trueHeight}"><rect width="100%" height="100%" fill="white"/>${trueCells.join("")}</svg>`;
const trueSheetPath = path.join(out, "contact-sheet-true-scale.png");
await writeFile(trueSheetPath, svgToPng(trueSheet, trueWidth));
console.log(trueSheetPath);
