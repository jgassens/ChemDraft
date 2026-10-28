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
const { exportDocumentToSvg } = await load("packages/export-engine/src/index.ts");
// Exactly the exporter/crop/raster pipeline used by `chemdraft render-document`.
const { cropDocumentSvgToContent, svgToPng } = await load("packages/chemdraft-cli/src/document.ts");
const { installNodeRendering } = await load("packages/chemdraft-cli/src/nodeRendering.ts");

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: node tools/template-layouts/render-check.mjs [--out <directory>]");
  process.exit(0);
}
if (args.length && (args.length !== 2 || args[0] !== "--out" || !args[1])) {
  throw new Error("Usage: render-check.mjs [--out <directory>]");
}
const out = args.length ? path.resolve(args[1]) : path.join(repositoryRoot, "tools", "template-layouts", ".check");
await mkdir(out, { recursive: true });
installNodeRendering();

const escapeXml = (text) => text.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
})[char]);
const columns = 3, cellWidth = 360, cellHeight = 310;
const cells = [];
for (const [index, template] of structureTemplates.entries()) {
  const document = createEmptyDocument({ title: template.name });
  const molecule = structureTemplateMolecule(template, {
    document, centre: { x: document.pages[0].width / 2, y: document.pages[0].height / 2 }
  });
  document.pages[0].objects.push(molecule);
  const exported = exportDocumentToSvg(document, { background: "#ffffff" });
  if (exported.warnings.length) {
    throw new Error(`${template.id}: ${exported.warnings.map((warning) => warning.message).join("; ")}`);
  }
  const cropped = cropDocumentSvgToContent(exported.contents, document, 24, "white", true);
  const png = svgToPng(cropped.svg, 800);
  const file = path.join(out, `${template.id}.png`);
  await writeFile(file, png);
  console.log(file);
  const x = (index % columns) * cellWidth, y = Math.floor(index / columns) * cellHeight;
  cells.push(`<image x="${x + 12}" y="${y + 12}" width="${cellWidth - 24}" height="${cellHeight - 52}" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${Buffer.from(png).toString("base64")}"/>` +
    `<text x="${x + cellWidth / 2}" y="${y + cellHeight - 16}" text-anchor="middle" font-family="Arial, sans-serif" font-size="16">${escapeXml(template.name)}</text>`);
}
const width = columns * cellWidth;
const height = Math.max(1, Math.ceil(structureTemplates.length / columns)) * cellHeight;
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="white"/>${cells.join("")}</svg>`;
const sheetPath = path.join(out, "contact-sheet.png");
await writeFile(sheetPath, svgToPng(sheet, width));
console.log(sheetPath);
