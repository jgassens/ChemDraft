import { CSS_PX_PER_INCH, createCustomPageLayout, readPngInfo, type ChemDraftDocument } from "@chemdraft/chem-core";
import { pngWithChemDraftSelection } from "@chemdraft/clipboard-adapter";
import { rasterizeSvgInBrowser } from "../clipboard";
import {
  copyAsScopedDocument, createPhase4Document, createSelectionClipboardPayload, exportPhase4Svg,
  parseSelectionClipboardPayload, selectDocumentObjects, serializeSelectionClipboardPayload,
  type ChemDraftSelectionClipboardPayload,
} from "../documentWorkflow";

export function openOfficeDrawing(json: string) {
  const payload = parseSelectionClipboardPayload(json, { allowEmpty: true });
  if (!payload || !Object.values(payload.bounds).every(Number.isFinite)) {
    throw new Error("This picture contains invalid or unsupported ChemDraft drawing data.");
  }
  const draft = payload.nativeSource ?? createPhase4Document("Office structure");
  const page = draft.pages[0]!;
  // Use the validated native objects directly. Clipboard paste remints IDs and relinks objects,
  // which is unnecessary when opening the complete drawing in its own editor.
  const doc = copyAsScopedDocument({
    ...draft, pages: [{ ...page, objects: payload.objects }],
    selection: { pageId: page.id, objectIds: [] },
  });
  // The copy scope leaves out group wrappers, which only frame their children. Put them back in
  // page order, moved by the same offset as the drawing, so an Update keeps the grouping.
  const fitted = new Map(doc.pages[0]!.objects.filter(object => object.type !== "group").map(object => [object.id, object]));
  const moved = payload.objects.find(object => object.type !== "group");
  const placed = moved && fitted.get(moved.id);
  const dx = placed ? placed.x - moved.x : 0;
  const dy = placed ? placed.y - moved.y : 0;
  const objects = payload.objects.map(object =>
    object.type === "group" ? { ...object, x: object.x + dx, y: object.y + dy } : fitted.get(object.id));
  if (fitted.size !== objects.filter(object => object?.type !== "group").length || objects.some(object => !object)) {
    throw new Error("Some ChemDraft drawing objects could not be opened.");
  }
  const fit = { ...doc.pages[0]!, objects: objects as typeof payload.objects };
  const width = Math.max(fit.width, 640);
  const height = Math.max(fit.height, 640);
  const layout = createCustomPageLayout(width, height, "css-px", { top: 0, right: 0, bottom: 0, left: 0 });
  return { document: { ...doc, pages: [{ ...fit, width, height, layout }] }, warnings: payload.warnings ?? [] };
}

const emptySelection: ChemDraftSelectionClipboardPayload = {
  kind: "chemdraft-selection", version: 1, objects: [], selectionIds: [],
  bounds: { x: 0, y: 0, width: 0, height: 0, centerX: 0, centerY: 0 },
};

export function officeSelectionPayload(document: ChemDraftDocument) {
  const page = document.pages[0]!;
  const selection = page.objects.length
    ? createSelectionClipboardPayload(selectDocumentObjects(document, page.id, page.objects.map(object => object.id)))
    : emptySelection;
  if (selection?.objects.length !== page.objects.length) {
    throw new Error("Some drawing objects could not be included in the replacement.");
  }
  return selection;
}

export async function prepareOfficePicture(document: ChemDraftDocument) {
  const payload = officeSelectionPayload(document);
  const json = serializeSelectionClipboardPayload(payload);
  const frame = copyAsScopedDocument({
    ...document,
    pages: [{ ...document.pages[0]!, objects: payload.objects }],
    selection: { ...document.selection, objectIds: [] },
  });
  const svg = await exportPhase4Svg(frame, { includeWarnings: false });
  const raster = await rasterizeSvgInBrowser(svg.contents, 4, CSS_PX_PER_INCH, 8192);
  const size = readPngInfo(raster);
  if (!size) throw new Error("The edited drawing could not be encoded as a PNG.");
  return { json, size: { width: size.pixelWidth, height: size.pixelHeight }, png: pngWithChemDraftSelection(raster, json),
    warnings: [...new Set([...(payload.warnings ?? []), ...svg.warnings.map(warning => warning.message)])] };
}
