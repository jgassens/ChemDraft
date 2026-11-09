// Regenerate the lossless export font and shared layout metrics from the bundled TTF.
// Run: node packages/export-engine/src/fonts/generatePatrickHand.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const root = new URL("../../../../", import.meta.url);
const font = readFileSync(new URL("apps/desktop/src/assets/fonts/PatrickHand-Regular.ttf", root));
const hash = createHash("sha256").update(font).digest("hex");
if (hash !== "0f173b3e6cb6d1af25babf7f0057c5ac4ee11f9992b0469bb817e967ef4ad0fc") {
  throw new Error("Patrick Hand font checksum differs from the reviewed 1.003 asset.");
}
// OFL source of truth; keep export-source and installed notices byte-identical.
const ofl = readFileSync(new URL("apps/desktop/src/assets/fonts/OFL.txt", root));
writeFileSync(new URL("packages/export-engine/src/fonts/LICENSE_PATRICK_HAND.txt", root), ofl);
writeFileSync(new URL("apps/desktop/src-tauri/resources/fonts/PatrickHand-OFL.txt", root), ofl);
function table(name) {
  for (let i = 0; i < font.readUInt16BE(4); i++) {
    const record = 12 + i * 16;
    if (font.toString("ascii", record, record + 4) === name) {
      return font.subarray(font.readUInt32BE(record + 8), font.readUInt32BE(record + 8) + font.readUInt32BE(record + 12));
    }
  }
  throw new Error(`Missing TrueType table ${name}`);
}
const cmap = table("cmap");
let mapping;
for (let i = 0; i < cmap.readUInt16BE(2); i++) {
  const record = 4 + i * 8;
  if (cmap.readUInt16BE(record) !== 3 || cmap.readUInt16BE(record + 2) !== 1) continue;
  mapping = cmap.subarray(cmap.readUInt32BE(record + 4));
  break;
}
if (!mapping || mapping.readUInt16BE(0) !== 4) throw new Error("Missing format 4 Unicode cmap");
const count = mapping.readUInt16BE(6) / 2;
const starts = 16 + count * 2, deltas = starts + count * 2, offsets = deltas + count * 2;
const head = table("head"), hmtx = table("hmtx"), hhea = table("hhea");
const em = head.readUInt16BE(18), metricCount = hhea.readUInt16BE(34);
const advances = {}, ranges = [];
for (let i = 0; i < count; i++) {
  const start = mapping.readUInt16BE(starts + i * 2), end = mapping.readUInt16BE(14 + i * 2);
  const address = offsets + i * 2, offset = mapping.readUInt16BE(address);
  const delta = mapping.readInt16BE(deltas + i * 2);
  for (let code = start; code <= end && code < 0xffff; code++) {
    let glyph = offset ? mapping.readUInt16BE(address + offset + 2 * (code - start)) : code;
    if (!offset || glyph) glyph = (glyph + delta) & 0xffff;
    if (!glyph) continue;
    advances[code] = hmtx.readUInt16BE(Math.min(glyph, metricCount - 1) * 4) / em;
    if (ranges.length && ranges.at(-1) + 1 === code) ranges[ranges.length - 1] = code;
    else ranges.push(code, code);
  }
}
const header = `// Generated from Patrick Hand Regular 1.003 by export-engine/src/fonts/generatePatrickHand.mjs.\n// TTF SHA-256: ${hash}. SIL OFL 1.1; see export-engine/src/fonts/LICENSE_PATRICK_HAND.txt.\n`;
writeFileSync(new URL("PatrickHand-Regular.ts", import.meta.url),
  `// Patrick Hand Regular 1.003, unmodified TTF encoded as base64. See LICENSE_PATRICK_HAND.txt.\nexport default "${font.toString("base64")}";\n`);
writeFileSync(new URL("patrickHandCoverage.generated.ts", import.meta.url), header +
  `export const patrickHandCoverage: readonly number[] = ${JSON.stringify(ranges)};\n`);
writeFileSync(new URL("packages/layout-engine/src/patrickHandMetrics.generated.ts", root), header +
  `export const patrickHandAdvances: Readonly<Record<number, number>> = ${JSON.stringify(advances, null, 2)};\n`);
// Restore this family if the existing Noto/DejaVu coverage generator was run first.
const coverageFile = new URL("coverage.ts", import.meta.url);
const existing = readFileSync(coverageFile, "utf8")
  .replace(/import \{ patrickHandCoverage \} from "\.\/patrickHandCoverage.generated";\n/g, "")
  .replace(/  ChemDraftPatrickHand: \{[\s\S]*?\n  \},\n/g, "");
writeFileSync(coverageFile, existing.replace("const ranges0", 'import { patrickHandCoverage } from "./patrickHandCoverage.generated";\nconst ranges0')
  .replace("export const fontCoverage = {", `export const fontCoverage = {\n  ChemDraftPatrickHand: {\n    normal: patrickHandCoverage,\n    bold: patrickHandCoverage,\n    italic: patrickHandCoverage,\n    bolditalic: patrickHandCoverage\n  },`));
