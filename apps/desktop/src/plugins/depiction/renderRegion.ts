import { objectFrameBoundsForPageFit, unionLayoutBounds, type LayoutBounds } from "@chemdraft/layout-engine";
import { PluginRequestLimits } from "@chemdraft/plugin-api";
import { RequestWriteError, type RequestDepictionProviders } from "@chemdraft/plugin-host";
import { PngOutputLimitError, rasterizeSvgNative } from "../../nativeRasterExport";
import { validateBase64Png } from "../../pngValidation";
import { bytesToBase64, readPngSize } from "../../rasterPictureDecode";
import { checkRegion, measurePageTarget } from "./measureRegion";
import { prepareDepictionPage } from "./previewPage";

const rasterInputBytes = 16 * 1024 * 1024;

function checkRasterRegion(bounds: LayoutBounds, widthPx: number, heightPx: number): void {
  checkRegion(bounds);
  const { x, y, width, height } = bounds;
  if (![x, y, x + width, y + height, widthPx / width, heightPx / height].every(value => Number.isFinite(Math.fround(value))) ||
      Math.fround(x + width) <= Math.fround(x) || Math.fround(y + height) <= Math.fround(y)) {
    throw new RequestWriteError("invalid", "The region exceeds the rasterizer's coordinate precision.");
  }
}

export function createRenderRegion(
  rasterize: typeof rasterizeSvgNative = rasterizeSvgNative
): RequestDepictionProviders["renderRegion"] {
  return async (input, binding) => {
    const { widthPx, heightPx, target } = input;
    const limits = PluginRequestLimits;
    binding.signal.throwIfAborted();
    if (![widthPx, heightPx].every(value => Number.isInteger(value) && value > 0)) {
      throw new RequestWriteError("invalid", "Expected positive integer PNG dimensions.");
    }
    if (Math.max(widthPx, heightPx) > limits.pngEdge || widthPx * heightPx > limits.pngPixels) {
      throw new RequestWriteError("limit", "The requested PNG exceeds the pixel limits.");
    }
    if (target.kind === "region") checkRasterRegion(target.bounds, widthPx, heightPx);
    const { document, page } = prepareDepictionPage(binding.document, input.pageId, input.preview);
    let bounds: LayoutBounds;
    const warnings: string[] = [];
    if (target.kind === "objects") {
      const measured = measurePageTarget(page, target);
      const fallback = new Set(measured.unsupported.map(object => object.objectId));
      const frames = page.objects.filter(object => fallback.has(object.id) && object.type !== "group" && object.type !== "reaction");
      const combined = unionLayoutBounds([...(measured.bounds ? [measured.bounds] : []), ...frames.map(objectFrameBoundsForPageFit)]);
      if (!combined) throw new RequestWriteError("invalid", "The requested objects have no visible ink.");
      if (fallback.size) warnings.push("Some requested objects have no ink measurement. The crop uses their stored frames where available.");
      bounds = { ...combined, width: Math.max(combined.width, 1), height: Math.max(combined.height, 1) };
    } else {
      bounds = target.bounds;
    }
    checkRasterRegion(bounds, widthPx, heightPx);
    let pictureCharacters = 0;
    for (const object of page.objects) {
      if (object.type !== "graphic" || object.graphicKind !== "image") continue;
      pictureCharacters += object.data.image?.dataBase64.length ?? object.data.imageHref?.length ?? 0;
      if (pictureCharacters > rasterInputBytes) throw new RequestWriteError("limit", "Page picture data exceeds the raster input limit.");
    }
    const [{ exportPhase4Svg }, { SvgByteLimitError }] = await Promise.all([
      import("../../documentWorkflow"), import("@chemdraft/export-engine")
    ]);
    binding.check();
    const objectIds = target.kind === "objects" ? target.objectIds : undefined;
    const exported = await exportPhase4Svg(document, {
      outputWidth: widthPx, outputHeight: heightPx, includePageGuides: false, includeWarnings: false, background: "transparent",
      rasterRegion: { bounds, objectIds, maxSvgBytes: rasterInputBytes }
    }).catch(error => {
      if (error instanceof SvgByteLimitError) throw new RequestWriteError("limit", error.message);
      throw error;
    });
    binding.check();
    const png = await rasterize(exported.contents, "png", {
      scale: 1, maxDimensionPx: Math.max(widthPx, heightPx), pictureBudgetBytes: limits.pngPixels * 4,
      maxPngBytes: limits.pngBytes
    }).catch(error => {
      if (error instanceof PngOutputLimitError) throw new RequestWriteError("limit", error.message);
      throw error;
    });
    binding.check();
    if (png.bytes.length > limits.pngBytes) throw new RequestWriteError("limit", "The PNG exceeds the decoded byte limit.");
    const size = readPngSize(png.bytes);
    if (png.width !== widthPx || png.height !== heightPx || size?.width !== widthPx || size.height !== heightPx) {
      throw new RequestWriteError("failed", "The renderer did not return a PNG of the requested dimensions.");
    }
    const base64 = bytesToBase64(png.bytes);
    validateBase64Png(base64, limits.pngEdge);
    const selected = objectIds && new Set(objectIds);
    for (const warning of exported.warnings) {
      if (!selected || !warning.objectId || selected.has(warning.objectId)) warnings.push(warning.message);
    }
    warnings.push(...png.warnings.map(warning => warning.message));
    const boundedWarnings = warnings.slice(0, 64).map(message => message.length > 1000 ? `${message.slice(0, 999)}…` : message);
    if (warnings.length > 64) boundedWarnings[63] = `${warnings.length - 63} additional rendering warnings were omitted.`;
    return { ok: true, value: { mimeType: "image/png", base64, bounds, widthPx, heightPx, warnings: boundedWarnings } };
  };
}
