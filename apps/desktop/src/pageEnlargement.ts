import { applyPatch, createCustomPageLayout, cssPxToPageSize, pageLayoutSourceUnit, type ChemDraftDocument } from "@chemdraft/chem-core";
import type { ShortcutPlatform } from "@chemdraft/shortcut-engine";
import { moleculeVisualBoundsForArrangement, objectFrameBoundsForPageFit, tableVisualBoundsForArrangement, textVisualBoundsForPageFit } from "@chemdraft/layout-engine";
import { nativePrompt } from "./nativePrompt";
import { documentObjectVisualBounds, translateDocumentPage } from "./documentWorkflow";

export type PageEnlargementDecision = "enlarge" | "keep" | "unanswered";

/** One decision per action (or assistant request), including concurrent/batched writes.
 * An abandoned question stays unanswered for the action; a late native answer cannot authorize it.
 */
export class PageEnlargementConsent {
  private decision?: Promise<PageEnlargementDecision>;
  private readonly promptAbort = new AbortController();
  constructor(private readonly platform?: ShortcutPlatform) {}
  async confirm(signal?: AbortSignal): Promise<PageEnlargementDecision> {
    if (signal?.aborted) {
      this.promptAbort.abort();
      this.decision ??= Promise.resolve("unanswered");
      return "unanswered";
    }
    const decision = this.decision ??= nativePrompt({ title: "ChemDraft", owner: "document", kind: "info",
      message: "This doesn't fit on the page. Enlarge the page to fit? Content on the page may shift to make room.",
      choices: [{ id: "enlarge", label: "Enlarge" }, { id: "keep", label: "Keep Page Size", cancel: true }]
    }, async () => "keep", this.promptAbort.signal, undefined, this.platform)
      .then(choice => this.promptAbort.signal.aborted ? "unanswered" : choice === "enlarge" ? "enlarge" : "keep");
    if (!signal) return decision;
    let stop!: () => void;
    try {
      return await Promise.race([decision, new Promise<PageEnlargementDecision>(resolve => {
        stop = () => {
          this.promptAbort.abort();
          resolve("unanswered");
        };
        signal.addEventListener("abort", stop, { once: true });
        if (signal.aborted) stop();
      })]);
    } finally { signal.removeEventListener("abort", stop); }
  }
}

export interface PageFitPlan {
  keep: ChemDraftDocument;
  growth: { pageId: string; width: number; height: number; shiftX?: number; shiftY?: number; objectIds?: string[] }[];
}

const visualBounds = (object: ChemDraftDocument["pages"][number]["objects"][number],
  objects: ChemDraftDocument["pages"][number]["objects"]) =>
  object.type === "table" ? tableVisualBoundsForArrangement(object)
    : object.type === "text" ? textVisualBoundsForPageFit(object)
    : object.type === "graphic" || object.type === "mechanism-arrow" ? documentObjectVisualBounds(object, objects)
      : object.type === "molecule" ? moleculeVisualBoundsForArrangement(object) : objectFrameBoundsForPageFit(object);

/** Inspect only added or geometrically changed objects. Existing off-page content and explicit
 * Page Setup changes must not turn a selection, deletion or colour edit into a question.
 * Builders may propose a larger layout; strip that growth until consent, retaining their exact
 * placement for Keep Page Size. Once triggered, measure the whole affected page so a uniform
 * left/top translation also fits pre-existing content at the opposite edge.
 */
export function planDocumentPageFit(before: ChemDraftDocument, proposed: ChemDraftDocument): PageFitPlan {
  const growth: PageFitPlan["growth"] = [];
  let keep = proposed;
  for (const page of proposed.pages) {
    const previous = before.pages.find(candidate => candidate.id === page.id);
    if (!previous || page.objects === previous.objects) continue;
    const old = new Map(previous.objects.map(object => [object.id, object]));
    const changed = page.objects.filter(object => {
      if (object.type === "group" || object.type === "reaction") return false;
      const original = old.get(object.id);
      return !original || ((original !== object || object.type === "mechanism-arrow") &&
        JSON.stringify(visualBounds(original, previous.objects)) !== JSON.stringify(visualBounds(object, page.objects)));
    });
    if (!changed.length) continue;
    const rects = changed.map(object => visualBounds(object, page.objects));
    const outside = rects.some(rect => rect.x < -1e-6 || rect.y < -1e-6 ||
      rect.x + rect.width > previous.width + 1e-6 || rect.y + rect.height > previous.height + 1e-6);
    const grew = page.width > previous.width || page.height > previous.height;
    if (!outside && !grew) continue;
    const allRects = page.objects.filter(object => object.type !== "group" && object.type !== "reaction")
      .map(object => visualBounds(object, page.objects));
    const left = Math.max(0, ...allRects.map(rect => -rect.x));
    const top = Math.max(0, ...allRects.map(rect => -rect.y));
    const shiftX = left > 1e-6 ? left : 0;
    const shiftY = top > 1e-6 ? top : 0;
    // A translation must fit all content it moves. With no shift, retain the existing
    // right/bottom-only growth policy (unrelated pre-existing overflow stays unchanged).
    const fitRects = shiftX || shiftY ? allRects : rects;
    const width = Math.max(previous.width, page.width, ...fitRects.map(rect => rect.x + rect.width)) + shiftX;
    const height = Math.max(previous.height, page.height, ...fitRects.map(rect => rect.y + rect.height)) + shiftY;
    growth.push({ pageId: page.id, width: Math.ceil(width * 0.75) / 0.75, height: Math.ceil(height * 0.75) / 0.75,
      shiftX, shiftY,
      objectIds: changed.filter((_, index) => {
        const rect = rects[index]!;
        return rect.x < -1e-6 || rect.y < -1e-6 || rect.x + rect.width > previous.width + 1e-6 || rect.y + rect.height > previous.height + 1e-6;
      }).map(object => object.id) });
    if (page.width !== previous.width || page.height !== previous.height) {
      keep = { ...keep, pages: keep.pages.map(candidate => candidate.id === page.id
        ? { ...candidate, width: previous.width, height: previous.height, layout: previous.layout, margin: previous.margin }
        : candidate) };
    }
  }
  return { keep, growth };
}

/** Page layout and content are returned together, for ONE existing history commit. */
export function applyPageFitDecision(plan: PageFitPlan, enlarge: boolean): ChemDraftDocument {
  return applyPageFitTransform(plan.keep, enlarge ? plan.growth : []);
}

/** Replay only the host-owned resize and translation on any baseline. Use the SAME growth
 * records as the committed insertion; replanning without that insertion would give a different fit.
 */
export function applyPageFitTransform(document: ChemDraftDocument, growth: PageFitPlan["growth"]): ChemDraftDocument {
  return growth.reduce((document, growth) => {
    const page = document.pages.find(page => page.id === growth.pageId)!;
    const unit = pageLayoutSourceUnit(page.layout);
    const resized = applyPatch(document, { op: "updatePageLayout", pageId: page.id,
      layout: createCustomPageLayout(cssPxToPageSize(growth.width, unit), cssPxToPageSize(growth.height, unit), unit, page.margin) });
    return translateDocumentPage(resized, page.id, growth.shiftX ?? 0, growth.shiftY ?? 0);
  }, document);
}

/** Fitting commits stay synchronous. The caller owns history and rechecks its captured tab/document
 * after the native box: a late answer must never overwrite a gesture, edit, undo or replaced tab.
 * The commit callback also receives the applied host transform for checking writes against a baseline.
 */
export function commitWithPageFit(before: ChemDraftDocument, proposed: ChemDraftDocument,
  commit: (document: ChemDraftDocument, fitBaseline: (baseline: ChemDraftDocument) => ChemDraftDocument) => void,
  options: { consent?: PageEnlargementConsent; signal?: AbortSignal; isCurrent?: () => boolean;
    onCommit?: (document: ChemDraftDocument, outcome: { decision: "fits" | "enlarge" | "keep"; plan: PageFitPlan }) => void } = {}
): Promise<void> | undefined {
  options.signal?.throwIfAborted();
  const plan = planDocumentPageFit(before, proposed);
  if (!plan.growth.length) { commit(proposed, baseline => baseline); options.onCommit?.(proposed, { decision: "fits", plan }); return undefined; }
  return (options.consent ?? new PageEnlargementConsent()).confirm(options.signal).then(decision => {
    options.signal?.throwIfAborted();
    if (decision === "unanswered") throw new Error("No answer to the enlarge-page question; nothing was inserted.");
    if (options.isCurrent && !options.isCurrent()) throw new Error("The drawing changed while the page question was open; try the action again.");
    const document = applyPageFitDecision(plan, decision === "enlarge");
    commit(document, baseline => applyPageFitTransform(baseline, decision === "enlarge" ? plan.growth : []));
    options.onCommit?.(document, { decision, plan });
  });
}
