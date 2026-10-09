import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { exportDocumentToCdxml } from "@chemdraft/cdx-compat";
import { type ChemDraftDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { assertMolfileHasKnownBondOrders } from "@chemdraft/document-workflow-core";
import { exportDocumentToSvg, type ExportWarning } from "@chemdraft/export-engine";
import { perceiveStereoCentersFromMolfile } from "@chemdraft/ocl-adapter";
import { numericOption, parseOptions, stringOption } from "../args";
import { canonicalSmiles, cropDocumentSvgToContent, currentMoleculeIdentityMolfile, renderDefaults, svgToPng, validateRasterWidth } from "../document";
import { loadAgentDocument, validateDocumentOutputPath } from "../documentInput";
import { installNodeEngines } from "../engine";
import { installNodeRendering } from "../nodeRendering";
import { CliUsageError, cliExitCode, defaultCliIo, handleCliError, writeJsonLine,
  writeProgress, type CliIo } from "../output";
import { withPdfDom } from "./export";
import { perceiveDoubleBondStereo } from "./stereo";

export type DocumentRenderFormat = "svg" | "png" | "pdf" | "chemdraft" | "both";
const renderDocumentOptions = {
  "--document": { kind: "value" }, "--out": { kind: "value" }, "--format": { kind: "value" },
  "--width": { kind: "value" }, "--background": { kind: "value" }, "--padding": { kind: "value" },
  "--help": { kind: "boolean" }
} as const;
export const renderDocumentHelp = `Render editable native JSON or a ChemDraft envelope with the shared document exporter.
Usage: pnpm -s chemdraft render-document --document <file> --out <file>
  --format svg|png|pdf|chemdraft|both  Inferred from extension; both writes SVG and PNG
  --width <px>                       PNG width, 16–4000 (default 600)
  --background white|transparent     SVG/PNG background (default white)
  --padding <px>                     SVG/PNG crop padding (default 24)
SVG/PNG/PDF render the first page. PDF retains native page size. ChemDraft retains every page.
Input limit: 5 MB, 100 pages, 2000 objects/page, 500 heavy atoms/molecule.
Result: canonical SMILES and stereo counts per molecule, plus every export warning.
Exit 0 success, 1 export/chemistry failure (ok:false), 2 invalid input or arguments.`;

async function moleculeResults(document: ChemDraftDocument, warnings: ExportWarning[]) {
  installNodeEngines();
  const molecules = document.pages.flatMap((page) => page.objects.filter(
    (object): object is MoleculeObject => object.type === "molecule"));
  const results = [];
  for (const molecule of molecules) {
    const writerWarnings: string[] = [];
    const molfile = currentMoleculeIdentityMolfile(molecule, writerWarnings).contents;
    warnings.push(...writerWarnings.map((message) => ({ code: "export.molfile_loss", message,
      severity: "warning" as const, objectId: molecule.id })));
    // The helper regenerates the current graph; stored uncertainty flags require a matching CTAB.
    assertMolfileHasKnownBondOrders(molfile);
    // The same RDKit identifiers used by app/CLI exports, with no native/stored-SMILES fallback.
    const canonical = await canonicalSmiles(molfile, `molecule ${molecule.id}`);
    const centers = perceiveStereoCentersFromMolfile(molfile);
    const doubleBonds = await perceiveDoubleBondStereo(molfile);
    results.push({ objectId: molecule.id, canonicalSmiles: canonical,
      stereoCenters: centers.filter((center) => center.isStereoCenter && center.descriptor !== "unspecified").length,
      unspecifiedStereoCenters: centers.filter((center) => center.isStereoCenter && center.descriptor === "unspecified").length,
      unspecifiedDoubleBonds: doubleBonds.filter((bond) => bond.descriptor === "unspecified").length });
  }
  return results;
}

export async function runRenderDocumentCommand(argv: readonly string[], io: CliIo = defaultCliIo) {
  try {
    if (argv.includes("--help")) { io.stdout(renderDocumentHelp); return cliExitCode.ok; }
    const parsed = parseOptions(argv, renderDocumentOptions);
    if (parsed.positionals.length) throw new CliUsageError(`Unknown argument "${parsed.positionals[0]}".`);
    const file = stringOption(parsed, "--document"), out = stringOption(parsed, "--out");
    if (!file || !out) throw new CliUsageError("Provide --document and --out.");
    validateDocumentOutputPath(out);
    const extension = extname(out).toLowerCase().slice(1);
    const requested = stringOption(parsed, "--format");
    const format = requested ?? extension;
    if (!["svg", "png", "pdf", "chemdraft", "both"].includes(format)) {
      throw new CliUsageError("--format must be svg, png, pdf, chemdraft or both (or use a matching --out extension).");
    }
    if (requested && format !== "both" && ["svg", "png", "pdf", "chemdraft"].includes(extension) && extension !== format) {
      throw new CliUsageError(`--format ${format} conflicts with the --out extension .${extension}.`);
    }
    const background = stringOption(parsed, "--background") ?? renderDefaults.background;
    if (background !== "white" && background !== "transparent") throw new CliUsageError("--background must be white or transparent.");
    const widthValue = stringOption(parsed, "--width");
    const width = widthValue === undefined ? renderDefaults.width : numericOption(widthValue, "--width");
    try { validateRasterWidth(width, "--width"); } catch (error) {
      throw new CliUsageError(error instanceof Error ? error.message : String(error));
    }
    const paddingValue = stringOption(parsed, "--padding");
    const padding = paddingValue === undefined ? renderDefaults.padding : numericOption(paddingValue, "--padding", true);
    const opened = await loadAgentDocument(file);
    const document = opened.document!;
    const name = basename(out);
    writeProgress(io, `Rendering document ${file}…`);
    try {
      installNodeRendering();
      const warnings: ExportWarning[] = opened.warnings.map((warning) => ({ ...warning,
        objectId: warning.sourceObjectId, severity: "warning" }));
      const molecules = await moleculeResults(document, warnings);
      const files: string[] = [];
      const save = async (path: string, contents: string | Uint8Array) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents); files.push(path);
      };
      if (format === "chemdraft") {
        const saved = exportDocumentToCdxml(document);
        warnings.push(...saved.warnings.map((warning) => ({ ...warning,
          objectId: warning.sourceObjectId, severity: "warning" as const })));
        await save(extension === format ? out : `${out}.${format}`, saved.contents);
      } else if (format === "pdf") {
        const { exportDocumentToPdf } = await import("@chemdraft/export-engine/pdf");
        const pdf = await withPdfDom((domParser) => exportDocumentToPdf(document, { domParser }));
        warnings.push(...pdf.warnings);
        await save(extension === format ? out : `${out}.${format}`, pdf.bytes);
      } else {
        const exported = exportDocumentToSvg(document, { background: background === "white" ? "#ffffff" : "transparent" });
        warnings.push(...exported.warnings);
        const svg = document.pages[0]!.objects.length === 0 ? exported.contents
          : cropDocumentSvgToContent(exported.contents, document, padding, background, true).svg;
        const base = ["svg", "png"].includes(extension) ? out.slice(0, -extname(out).length) : out;
        if (format === "svg" || format === "both") await save(format === "both" ? `${base}.svg` : extension === format ? out : `${out}.svg`, svg);
        if (format === "png" || format === "both") await save(format === "both" ? `${base}.png` : extension === format ? out : `${out}.png`, svgToPng(svg, width));
      }
      if (format !== "chemdraft" && document.pages.length > 1) warnings.push({
        code: "export.first_page_only", severity: "warning", message: "Only the first page was rendered; other pages remain in the source document."
      });
      writeJsonLine(io, { name, ok: true, document: file, files, format,
        molecules: molecules.map((molecule) => ({ ...molecule,
          exportWarnings: warnings.filter((warning) => warning.objectId === undefined || warning.objectId === molecule.objectId) })),
        warnings: warnings.map((warning) => warning.message), exportWarnings: warnings });
      writeProgress(io, `Wrote ${files.join(", ")}`);
      return cliExitCode.ok;
    } catch (error) {
      writeJsonLine(io, { name, document: file, ok: false, error: error instanceof Error ? error.message : String(error) });
      return cliExitCode.failed;
    }
  } catch (error) { return handleCliError(error, io, "render-document"); }
}

export const renderDocumentCommand = {
  name: "render-document", summary: "Render styled native documents through the shared exporter.", run: runRenderDocumentCommand
} as const;
