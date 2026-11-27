// @vitest-environment jsdom
/**
 * A timing proxy for the hands-on report on 1.2.3 RC5: dropping IMG_0896.JPG (1.7 MB JPEG, 3264 × 2448,
 * EXIF orientation 6) took 4.2-4.5 s to appear on an Intel iMac, and every later edit then kept the app
 * busy for 2.5-3 s. This runs the app's own drop handler, insertion, a 1 px nudge and the autosave's
 * serialization on a picture of that size. The webview's work (decoding the JPEG, painting) is not in
 * it: the decoders here answer at once. The RC5 route is measured beside it as the baseline: the photo
 * re-encoded to a 7 MB PNG (9.35 MB as base64) and the session written as RC5 wrote it.
 */
import { describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, GraphicObject } from "@chemdraft/chem-core";
import { createNativeSavePayload, createPhase4Document, moveDocumentObjects } from "../documentWorkflow";
import { buildDocumentSessionEnvelope, buildDocumentTabsSession, createDocumentSessionSource } from "../documentSession";
import { savedDocumentBytes } from "./dropDocumentBudget";
import { handleDroppedFiles, type DroppedFilesHandler } from "./dropHandler";
import { insertDroppedImages } from "./insertDroppedImages";
import { syntheticJpeg } from "./jpegTestImages";
import type { DroppedImageDecoders, RasterToJpeg, RasterToPng } from "./rasterDecode";
import { jpegHeader } from "./testFixtures";

const PHOTO = syntheticJpeg({ width: 3264, height: 2448, orientation: 6, scanBytes: 1_700_000 });
/** A JPEG header without image data still takes the PNG conversion route, so it stands in for RC5's handling of the photo. */
const RC5_PHOTO = jpegHeader(3264, 2448);

/** A PNG of `width` × `height` whose image data is `dataBytes` long: RC5's re-encode of the photo was 7 MB. */
function largePng(width: number, height: number, dataBytes: number): Uint8Array {
  const out = new Uint8Array(8 + 25 + 12 + dataBytes + 12);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  view.setUint32(8, 13);
  out.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  out.set([8, 6, 0, 0, 0], 24);
  view.setUint32(33, dataBytes);
  out.set([73, 68, 65, 84], 37);
  for (let index = 0; index < dataBytes; index += 1) out[41 + index] = (index * 2654435761) >>> 24;
  out.set([73, 69, 78, 68], 41 + dataBytes + 8);
  return out;
}

const pictures = (document: ChemDraftDocument) =>
  document.pages[0]!.objects.filter((object): object is GraphicObject => object.type === "graphic" && object.graphicKind === "image");

interface Timings { dropMs: number; nudgeMs: number; autosaveMs: number; sessionBytes: number; document: ChemDraftDocument; status: string }

/** One drop through `handleDroppedFiles`, as MainWindow wires it, then one nudge and the autosave after each. */
async function measure(
  photo: Uint8Array, decoders: DroppedImageDecoders, autosave: (document: ChemDraftDocument) => string
): Promise<Timings> {
  let document = createPhase4Document("Drop");
  const statuses: string[] = [];
  const handler: DroppedFilesHandler<string> = {
    nameOf: name => name,
    imageSource: name => ({ name, size: async () => photo.length, read: async () => photo }),
    openDocuments: async () => undefined,
    documentBytes: () => savedDocumentBytes(createNativeSavePayload(document).contents),
    insertImages: images => {
      const inserted = insertDroppedImages(document, images, { x: 408, y: 528 });
      document = inserted.document;
      return { ok: true, scaledToPage: inserted.scaledToPage };
    },
    decoders,
    setStatus: status => statuses.push(status)
  };
  let started = performance.now();
  await handleDroppedFiles(["IMG_0896.JPG"], handler);
  const dropMs = performance.now() - started;
  autosave(document);
  const [picture] = pictures(document);
  started = performance.now();
  const nudged = moveDocumentObjects(document, [picture!.id], 1, 0);
  const nudgeMs = performance.now() - started;
  // The nudge left the picture's data alone: the same string, no decoder ran again.
  expect(pictures(nudged)[0]!.data.image!.dataBase64).toBe(picture!.data.image!.dataBase64);
  started = performance.now();
  const session = autosave(nudged);
  const autosaveMs = performance.now() - started;
  return { dropMs, nudgeMs, autosaveMs, sessionBytes: session.length, document: nudged, status: statuses.at(-1)! };
}

describe("dropping the tester's 1.7 MB photo", () => {
  it("appears well under a second and leaves later edits light, against the RC5 route", async () => {
    const kept = { rasterToPng: vi.fn<RasterToPng>(), rasterToJpeg: vi.fn<RasterToJpeg>(), decodeCheck: vi.fn(async () => ({ width: 3264, height: 2448 })) };
    const now = await measure(PHOTO, kept, document => {
      const tab = buildDocumentSessionEnvelope(createDocumentSessionSource(document), { dirty: true }, "Drop", false);
      return JSON.stringify(buildDocumentTabsSession([tab], 0));
    });

    const png = largePng(2448, 3264, 7_000_000);
    const converted: DroppedImageDecoders = {
      rasterToPng: async () => ({ png, width: 2448, height: 3264, sourceWidth: 2448, sourceHeight: 3264, downscaled: false }),
      rasterToJpeg: async () => { throw new Error("RC5 converted every JPEG to PNG"); },
      decodeCheck: async () => ({ width: 1, height: 1 })
    };
    const rc5 = await measure(RC5_PHOTO, converted, document => {
      const tab = buildDocumentSessionEnvelope(createNativeSavePayload(document), { dirty: true }, "Drop", false);
      return JSON.stringify({ ...tab, tabs: [tab], activeTabIndex: 0 });
    });

    console.info(`drop proxy (ms, session bytes): now drop ${now.dropMs.toFixed(0)}, nudge ${now.nudgeMs.toFixed(0)}, `
      + `autosave ${now.autosaveMs.toFixed(0)}, session ${now.sessionBytes}; RC5 route drop ${rc5.dropMs.toFixed(0)}, `
      + `nudge ${rc5.nudgeMs.toFixed(0)}, autosave ${rc5.autosaveMs.toFixed(0)}, session ${rc5.sessionBytes}`);

    expect(now.status).toBe("Inserted picture IMG_0896.JPG; scaled to fit the page: IMG_0896.JPG");
    expect(rc5.status).toBe(now.status);
    expect(pictures(rc5.document)[0]!.data.image!.mimeType).toBe("image/png");
    // The JPEG was decoded once, to check it, and never converted; nothing after the drop decoded it again.
    expect(kept.rasterToPng).not.toHaveBeenCalled();
    expect(kept.decodeCheck).toHaveBeenCalledTimes(1);
    const [picture] = pictures(now.document);
    expect(picture!.data.image!.mimeType).toBe("image/svg+xml");
    expect(picture!.height).toBeGreaterThan(picture!.width);

    // Generous bounds for shared CI runners; on Apple silicon these take a fraction of them.
    expect(now.dropMs).toBeLessThan(1000);
    expect(now.nudgeMs + now.autosaveMs).toBeLessThan(500);
    expect(now.sessionBytes).toBeLessThan(2 * PHOTO.length);
    expect(rc5.sessionBytes).toBeGreaterThan(5 * now.sessionBytes);
    expect(now.dropMs).toBeLessThan(rc5.dropMs);
    expect(now.nudgeMs + now.autosaveMs).toBeLessThan(rc5.nudgeMs + rc5.autosaveMs);
  });
});
