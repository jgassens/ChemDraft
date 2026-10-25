import { figurePlacementFrame, nativeMoleculeRings } from "@chemdraft/layout-engine";
import { stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { assistantScope, requireDocument, type AssistantToolContext } from "./AssistantToolContext";

export const SUMMARY_MAX_BYTES = 256 * 1024;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Bounded even when metadata, captions, title, or selection in an imported document are huge. */
export async function documentSummary(context: AssistantToolContext, options: {
  includeSmiles?: boolean; maxObjects?: number; objectIds?: readonly string[];
} = {}) {
  const document = requireDocument(context);
  const scope = assistantScope(context);
  const filter = options.objectIds ? new Set(options.objectIds) : undefined;
  const counts: Record<string, number> = {};
  const selected = context.getSelectionAtSend();
  const selectionIds: string[] = [];
  let selectionBytes = 0;
  for (const id of selected.slice(0, 500)) {
    const cost = bytes(id) + 1;
    if (selectionBytes + cost <= 64 * 1024) { selectionIds.push(id); selectionBytes += cost; }
  }
  const summary = {
    title: document.title.slice(0, 2000),
    pages: [] as { id: string; width: number; height: number }[],
    objects: [] as Record<string, unknown>[],
    selection: { objectIds: selectionIds },
    truncated: document.title.length > 2000 || selected.length !== selectionIds.length,
    counts, empty: true
  };
  let eligibleCount = 0;
  const maxObjects = Math.max(1, Math.min(options.maxObjects ?? 200, 500));
  // Reserve headroom for counts and envelope fields instead of serializing the growing result per object.
  let budget = SUMMARY_MAX_BYTES - bytes(summary) - 8192;
  for (const page of document.pages) {
    const info = { id: page.id, width: page.width, height: page.height };
    const cost = bytes(info) + 1;
    if (cost <= budget) { summary.pages.push(info); budget -= cost; }
    else summary.truncated = true;
    for (const object of page.objects) {
      counts[object.type] = (counts[object.type] ?? 0) + 1;
      if (filter && !filter.has(object.id)) continue;
      eligibleCount++;
      summary.empty = false;
      if (summary.objects.length >= maxObjects || budget <= 0) continue;
      const entry: Record<string, unknown> = {
        id: object.id, type: object.type, pageId: page.id, x: object.x, y: object.y,
        width: object.width, height: object.height, inScope: scope.has(object.id)
      };
      if (object.type === "text") {
        entry.text = object.text.slice(0, 2000);
        if (object.text.length > 2000) summary.truncated = true;
      }
      if (object.type === "reaction-arrow") entry.arrowKind = object.arrowKind;
      if (object.type === "molecule") {
        entry.atomCount = object.atoms.length;
        const labels = object.atoms.filter(atom => atom.labelLiteral);
        if (labels.length) entry.atomLabels = labels.slice(0, 100).map(atom => ({ atomId: atom.id, label: atom.element, literal: true }));
        if (labels.length > 100) summary.truncated = true;
        const rings = nativeMoleculeRings(object).slice(0, 100);
        entry.ringKeys = rings.map(ring => ring.ringKey);
        entry.rings = rings.map(ring => ({ ringKey: ring.ringKey, atomCount: ring.atomIds.length,
          bondIds: ring.bondIds, ...figurePlacementFrame(object, ring) }));
        entry.bonds = object.bonds.slice(0, 1000).map(bond => ({ bondId: bond.id, fromAtomId: bond.fromAtomId, toAtomId: bond.toAtomId }));
        if (object.bonds.length > 1000) summary.truncated = true;
        if (options.includeSmiles !== false) {
          try {
            const warnings: string[] = [];
            const molfile = stereoPerceptionMolfile(object, warnings);
            const result = await context.chemistry.inspectStructure("molfile", molfile);
            if (result.valid && warnings.length === 0) {
              entry.smiles = result.canonicalSmiles; entry.formula = result.formula;
              entry.warnings = result.warnings;
            } else entry.warnings = result.valid ? warnings : [result.reason, ...warnings];
          } catch (error) { entry.warnings = [error instanceof Error ? error.message : String(error)]; }
        }
      }
      const cost = bytes(entry) + 1;
      if (cost <= budget) { summary.objects.push(entry); budget -= cost; }
      else summary.truncated = true;
    }
  }
  summary.truncated ||= summary.objects.length < eligibleCount;
  // Imported ids have no length bound. Keep the actual wire payload bounded too.
  while (bytes(summary) > SUMMARY_MAX_BYTES) {
    summary.truncated = true;
    if (summary.objects.length) summary.objects.pop();
    else if (summary.pages.length) summary.pages.pop();
    else if (summary.selection.objectIds.length) summary.selection.objectIds.pop();
    else break;
  }
  return summary;
}
