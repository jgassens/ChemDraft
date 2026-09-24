import { MoleculeObjectSchema, createEmptyDocument } from "@chemdraft/chem-core";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import type { NormalizedProposedDocumentPatch } from "@chemdraft/plugin-api";

const PREVIEW_PADDING_PX = 12;
const previewCache = new WeakMap<NormalizedProposedDocumentPatch, string | null>();

/**
 * A picture of the molecule a recognition proposal would insert, drawn by the host's own SVG exporter
 * from the validated patch object — never markup supplied by the plugin. Returned as an
 * `image/svg+xml` data URI so the review shows it through `<img>`, where an SVG cannot run script.
 * Anything that is not a single molecule insertion gets no picture rather than a guessed one.
 */
export function recognitionStructurePreview(proposal: NormalizedProposedDocumentPatch): string | undefined {
  if (!proposal.recognition) return undefined;
  const cached = previewCache.get(proposal);
  if (cached !== undefined) return cached ?? undefined;
  const preview = renderPreview(proposal);
  previewCache.set(proposal, preview ?? null);
  return preview;
}

function renderPreview(proposal: NormalizedProposedDocumentPatch): string | undefined {
  const patch = proposal.patch as { op?: unknown; object?: unknown };
  if (patch.op !== "addObject") return undefined;
  const parsed = MoleculeObjectSchema.safeParse(patch.object);
  if (!parsed.success) return undefined;
  const molecule = parsed.data;
  try {
    const document = createEmptyDocument({ title: "Recognized structure" });
    document.pages[0]!.objects = [molecule];
    const svg = exportDocumentToSvg(document, { background: "#ffffff" }).contents;
    const x = molecule.x - PREVIEW_PADDING_PX;
    const y = molecule.y - PREVIEW_PADDING_PX;
    const width = Math.max(molecule.width, 1) + PREVIEW_PADDING_PX * 2;
    const height = Math.max(molecule.height, 1) + PREVIEW_PADDING_PX * 2;
    const cropped = svg.replace(
      /^<svg([^>]*?) width="[^"]*" height="[^"]*" viewBox="[^"]*"/,
      `<svg$1 width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}"`
    );
    if (cropped === svg) return undefined;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cropped)}`;
  } catch {
    return undefined;
  }
}
