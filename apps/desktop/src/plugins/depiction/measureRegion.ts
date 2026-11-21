import { nativeDrawingStyleFromObjectStyle, type DocumentPage } from "@chemdraft/chem-core";
import { representativeNativeMoleculeBondLength } from "@chemdraft/document-workflow-core";
import {
  measureObjectDepiction, objectFrameBoundsForPageFit, resolveArrowAttachments,
  unionLayoutBounds, type LayoutBounds
} from "@chemdraft/layout-engine";
import type { PluginRequestArguments } from "@chemdraft/plugin-api";
import { RequestWriteError, type RequestDepictionProviders } from "@chemdraft/plugin-host";
import { prepareDepictionPage } from "./previewPage";

export type DepictionTarget = PluginRequestArguments<"depiction", "measure">["target"];

export function checkRegion(bounds: LayoutBounds): void {
  const { x, y, width, height } = bounds;
  if (![x, y, width, height, x + width, y + height].every(Number.isFinite) || x + width <= x || y + height <= y) {
    throw new RequestWriteError("invalid", "Expected a finite rectangle with positive width and height.");
  }
}

function intersects(a: LayoutBounds, b: LayoutBounds): boolean {
  return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

export function measurePageTarget(source: DocumentPage, target: DepictionTarget) {
  if (target.kind === "region") checkRegion(target.bounds);
  const page = resolveArrowAttachments(source);
  const byId = new Map(page.objects.map(object => [object.id, object]));
  const candidates = target.kind === "objects" ? target.objectIds.map(id => {
    const object = byId.get(id);
    if (!object) throw new RequestWriteError("invalid", `Object "${id}" does not exist on page "${page.id}".`);
    return object;
  }) : page.objects;
  const unsupported: { objectId: string; type: string }[] = [];
  const objects = candidates.flatMap(object => {
    const entry = measureObjectDepiction(page, object);
    if (!entry) {
      if (target.kind === "objects" || intersects(objectFrameBoundsForPageFit(object), target.bounds)) {
        unsupported.push({ objectId: object.id, type: object.type });
      }
      return [];
    }
    if (target.kind === "region" && (!entry.bounds || !intersects(entry.bounds, target.bounds))) return [];
    const base = { ...entry, objectId: object.id };
    return object.type === "molecule" ? [{ ...base, bondLength: {
      nominal: nativeDrawingStyleFromObjectStyle(object.style).bondLengthPx,
      measured: representativeNativeMoleculeBondLength(object) ?? null
    } }] : [base];
  });
  const bounds = unionLayoutBounds(objects.flatMap(object => object.bounds ? [object.bounds] : []));
  return { units: "document" as const, bounds, objects, unsupported, warnings: [] };
}

export const measure: RequestDepictionProviders["measure"] = (input, binding) => {
  binding.signal.throwIfAborted();
  const { page } = prepareDepictionPage(binding.document, input.pageId, input.preview);
  return { ok: true, value: measurePageTarget(page, input.target) };
};
