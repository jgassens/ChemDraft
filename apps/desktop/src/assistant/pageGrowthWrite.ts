import type { ChemDraftDocument } from "@chemdraft/chem-core";
import type { AssistantPageGrowth } from "./AssistantToolContext";
import { applyPageFitDecision, planDocumentPageFit } from "../pageEnlargement";

/** Shared by local tools and the document's broker commit. Page translation is host-owned and
 * does not widen the set selected by the assistant transaction. */
export function applyAssistantPageGrowth(document: ChemDraftDocument, patched: ChemDraftDocument, growth?: AssistantPageGrowth): ChemDraftDocument {
  if (!growth) return patched;
  const plan = planDocumentPageFit(document, patched);
  for (const size of growth.pages ?? [growth]) {
    const measured = plan.growth.find(page => page.pageId === size.pageId);
    if (measured) {
      measured.width = Math.max(measured.width, size.width);
      measured.height = Math.max(measured.height, size.height);
    } else {
      const page = document.pages.find(page => page.id === size.pageId)!;
      plan.growth.push({ ...size, width: Math.max(page.width, size.width), height: Math.max(page.height, size.height) });
    }
  }
  return applyPageFitDecision(plan, true);
}
