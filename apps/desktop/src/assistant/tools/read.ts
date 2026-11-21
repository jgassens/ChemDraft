import { stereoPerceptionMolfile } from "@chemdraft/document-workflow-core";
import { requireDocument, type AssistantToolContext } from "../AssistantToolContext";
import { documentSummary } from "../documentSummary";
import { findObject, inspectMolecule } from "../writeBuilder";
import { objectRect, unionRects } from "../placement";
import { checkPngDimensions, checkPngEncodedSize, checkPngRawSize, hasPngSignature } from "../mcpPng";
import type { ToolInput } from "./schemas";

export function getDocument(context: AssistantToolContext, input: ToolInput<"get_document">) {
  return documentSummary(context, input);
}
export function getSelection(context: AssistantToolContext) {
  return documentSummary(context, { objectIds: context.getSelectionAtSend(), maxObjects: 500 });
}
export async function getStructure(context: AssistantToolContext, input: ToolInput<"get_structure">) {
  const { object } = findObject(requireDocument(context), input.objectId);
  if (object.type !== "molecule") throw new Error(`${object.id} is not a molecule.`);
  if (input.format === "molfile") {
    const warnings: string[] = [];
    return { ...input, structure: stereoPerceptionMolfile(object, warnings), warnings };
  }
  const result = await inspectMolecule(context, object);
  return { ...input, structure: result.canonicalSmiles, warnings: result.warnings };
}
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}
export async function render(context: AssistantToolContext, input: ToolInput<"render">) {
  const document = requireDocument(context);
  const objectIds = input.target === "selection" ? context.getSelectionAtSend() : input.target === "objects" ? input.objectIds : undefined;
  if (input.target === "objects" && !objectIds?.length) throw new Error("render objects requires objectIds.");
  for (const id of objectIds ?? []) findObject(document, id);
  const page = input.pageId ? document.pages.find(page => page.id === input.pageId) :
    objectIds?.length ? findObject(document, objectIds[0]!).page : document.pages[0];
  if (!page) throw new Error(`Page "${input.pageId}" does not exist.`);
  if (objectIds?.some(id => findObject(document, id).page.id !== page.id)) throw new Error("Render objects must be on one page.");
  const objects = objectIds ? page.objects.filter(object => objectIds.includes(object.id)) : page.objects;
  if (objectIds && objects.length === 0) throw new Error("There are no selected objects to render.");
  const scoped = { ...document, pages: [{ ...page, objects }], selection: { objectIds: [] } };
  const { exportPhase4Svg } = await import("../../documentWorkflow");
  let svg = (await exportPhase4Svg(scoped, { includePageGuides: false, includeWarnings: false, background: input.background })).contents;
  if (objectIds) {
    const bounds = unionRects(objects.map(objectRect));
    const width = Math.max(bounds.width, 1) + 24;
    const height = Math.max(bounds.height, 1) + 24;
    svg = svg.replace(/<svg\b[^>]*>/, tag => tag.replace(/\bwidth="[^"]*"/, `width="${width}"`)
      .replace(/\bheight="[^"]*"/, `height="${height}"`)
      .replace(/viewBox="[^"]*"/, `viewBox="${bounds.x - 12} ${bounds.y - 12} ${width} ${height}"`));
  }
  const png = await context.render(svg, { maxDimensionPx: input.maxDimensionPx, background: input.background });
  checkPngDimensions(png.width, png.height, input.maxDimensionPx);
  checkPngRawSize(png.bytes.length);
  if (!hasPngSignature(png.bytes)) throw new Error("The renderer did not return a PNG.");
  const data = base64(png.bytes);
  checkPngEncodedSize(data.length);
  return { content: [{ type: "image" as const, mimeType: "image/png" as const, data }],
    structuredContent: { width: png.width, height: png.height } };
}
