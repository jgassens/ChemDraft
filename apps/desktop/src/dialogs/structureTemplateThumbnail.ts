import { createEmptyDocument } from "@chemdraft/chem-core";
import { structureTemplateMolecule } from "@chemdraft/document-workflow-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { moleculeVisualBoundsForArrangement } from "@chemdraft/layout-engine";
import type { StructureTemplate } from "@chemdraft/template-library";

const cache = new Map<string, string>();
/** Trusted built-in layouts only; shared SVG geometry, isolated in an image (no live markup). */
export function structureTemplateThumbnail(template: StructureTemplate): string {
  const cached = cache.get(template.id);
  if (cached) return cached;
  const document = createEmptyDocument({ title: template.name });
  const molecule = structureTemplateMolecule(template, { document, centre: { x: 0, y: 0 } });
  document.pages[0]!.objects = [molecule];
  const bounds = moleculeVisualBoundsForArrangement(molecule);
  const padding = 12;
  const svg = exportDocumentToSvg(document, { background: "transparent" }).contents
    .replace(/viewBox="[^"]*"/, `viewBox="${bounds.x - padding} ${bounds.y - padding} ${bounds.width + padding * 2} ${bounds.height + padding * 2}"`);
  const url = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  cache.set(template.id, url);
  return url;
}
