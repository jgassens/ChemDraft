import { type ChemDraftDocument, type JournalRequest } from "@chemdraft/chem-core";
import { applyJournalStyle } from "@chemdraft/document-workflow-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { documentObjectVisualBounds } from "../documentWorkflow";
import type { ExportPreviewResult } from "../dialogs/exportOptions";
export { ensureJournalProfile } from "./catalog";
import { resolveJournalProfile } from "./catalog";
import { checkJournalExport } from "./preflight";

export function prepareJournalStyle(source: ChemDraftDocument, request: JournalRequest) {
  return applyJournalStyle(source, resolveJournalProfile(request), request);
}
export function journalStylePreview(source: ChemDraftDocument, request: JournalRequest): ExportPreviewResult {
  const profile = resolveJournalProfile(request), next = prepareJournalStyle(source, request);
  const index = Math.max(0, next.pages.findIndex(page => page.id === source.selection.pageId));
  const page = next.pages[index];
  const bounds = page.objects.filter(object => object.type !== "group").map(object => documentObjectVisualBounds(object, page.objects));
  const x = Math.min(...bounds.map(b => b.x)) - 12, y = Math.min(...bounds.map(b => b.y)) - 12;
  const width = bounds.length ? Math.max(...bounds.map(b => b.x + b.width)) - x + 12 : page.width;
  const height = bounds.length ? Math.max(...bounds.map(b => b.y + b.height)) - y + 12 : page.height;
  // Preview uses exactly the export engine's strokes and labels; cropping is display-only.
  const result = exportDocumentToSvg(next, { pageIndex: index, background: "transparent" });
  const svg = bounds.length ? result.contents.replace(/viewBox="[^"]*"/, `viewBox="${x} ${y} ${width} ${height}"`)
    .replace(/width="[^"]*"/, `width="${width}"`).replace(/height="[^"]*"/, `height="${height}"`) : result.contents;
  const bytes = new TextEncoder().encode(svg), parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  const figure = profile.figures.find(figure => figure.id === request.figureType)!;
  const warnings = [...profile.limitations, ...result.warnings.map(warning => warning.message),
    `Page ${index + 1} preview; saved page size is ${(page.width / 96 * 25.4).toFixed(1)} × ${(page.height / 96 * 25.4).toFixed(1)} mm. Preview cropping does not resize the saved page.`,
    ...checkJournalExport(figure, "svg", page.width / 96 * 25.4, page.height / 96 * 25.4).filter(message => !message.includes("listed formats"))];
  return { url: `data:image/svg+xml;base64,${btoa(parts.join(""))}`, kind: "image", width: Math.min(8192, Math.max(1, width)), height: Math.min(8192, Math.max(1, height)), warnings: warnings.slice(0, 100) };
}
