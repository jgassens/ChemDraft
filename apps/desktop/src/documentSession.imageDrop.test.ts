// @vitest-environment jsdom
/**
 * The autosaved session with dropped pictures in it: how large it is, that it holds each picture
 * once and encoded once, and that sessions written before (by RC5 and earlier) still restore.
 */
import { describe, expect, it } from "vitest";
import { createEmptyDocument, type ChemDraftDocument, type GraphicObject } from "@chemdraft/chem-core";
import { sha256Utf8Hex } from "@chemdraft/cdx-compat";
import { createNativeSavePayload, moveDocumentObjects, openNativeDocument } from "./documentWorkflow";
import {
  buildDocumentSessionEnvelope, buildDocumentTabsSession, createDocumentSessionSource, documentSessionRestoreCandidates,
  parseDocumentSessionEnvelope, shouldRestoreDocumentSession, type DocumentSessionEnvelope
} from "./documentSession";
import { insertDroppedImages } from "./imageDrop/insertDroppedImages";
import { syntheticJpeg } from "./imageDrop/jpegTestImages";
import { prepareDroppedImage, type PreparedDroppedImage } from "./imageDrop/prepareDroppedImage";
import type { DroppedImageDecoders } from "./imageDrop/rasterDecode";
import { pngBytes } from "./imageDrop/testFixtures";

/** The tester's photo: 1.7 MB, 3264 × 2448 stored, EXIF orientation 6. */
const PHOTO = syntheticJpeg({ width: 3264, height: 2448, orientation: 6, scanBytes: 1_700_000 });

const decoders: DroppedImageDecoders = {
  rasterToPng: async () => ({ png: pngBytes(), width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, downscaled: false }),
  decodeCheck: async () => ({ width: 3264, height: 2448 })
};

async function prepared(name: string, bytes: Uint8Array): Promise<PreparedDroppedImage> {
  const result = await prepareDroppedImage(name, bytes, decoders);
  if (!result.ok) throw new Error(result.reason);
  return result.image;
}

const pictures = (document: ChemDraftDocument) =>
  document.pages[0]!.objects.filter((object): object is GraphicObject => object.type === "graphic" && object.graphicKind === "image");

/** Two separate drops of the photo, as the tester did. */
async function twoDrops(): Promise<ChemDraftDocument> {
  const image = await prepared("IMG_0896.JPG", PHOTO);
  const once = insertDroppedImages(createEmptyDocument({ title: "Photos" }), [image], { x: 300, y: 300 }).document;
  return insertDroppedImages(once, [image], { x: 500, y: 600 }).document;
}

function tab(contents: { contents: string; payloadHash: string }, extra: Partial<DocumentSessionEnvelope> = {}): DocumentSessionEnvelope {
  return { ...buildDocumentSessionEnvelope(contents, { dirty: true }, "Photos", false, new Date("2026-11-27T12:00:00Z")),
    pristine: false, ...extra };
}

/** What `save_document_session` receives: the Tauri IPC sends `JSON.stringify` of the envelope. */
const written = (session: unknown) => JSON.stringify(session);
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

/** Restore exactly as MainWindow does: every candidate tab through the current parser, then File > Open's reader. */
function restore(raw: unknown): ChemDraftDocument[] {
  const envelope = parseDocumentSessionEnvelope(raw);
  if (!envelope) throw new Error("unreadable session");
  expect(shouldRestoreDocumentSession(envelope)).toBe(true);
  return documentSessionRestoreCandidates(envelope).map(candidate => {
    const session = parseDocumentSessionEnvelope(candidate, true);
    if (!session) throw new Error("unreadable tab");
    const opened = openNativeDocument(session.contents);
    if (!opened.document) throw new Error(opened.warnings.map(warning => warning.message).join("; "));
    return opened.document;
  });
}

describe("the session after two drops of a 1.7 MB JPEG", () => {
  it("stays within twice the picture bytes, where RC5 wrote 49.9 MB", async () => {
    const document = await twoDrops();
    const text = written(buildDocumentTabsSession([tab(createDocumentSessionSource(document))], 0));
    const pictureBytes = 2 * PHOTO.length;
    // Base64 of an SVG that holds the JPEG in base64: 16/9 of the bytes, and nothing else of size.
    expect(text.length).toBeLessThan(2 * pictureBytes);
    expect(text.length).toBeGreaterThan(1.7 * pictureBytes);

    // The same document written the way RC5 wrote it (the save payload, top-level copy included) is
    // twice again as large; with RC5's PNG re-encode of the photo it was 49.9 MB.
    const rc5Tab = tab(createNativeSavePayload(document));
    const rc5 = written({ ...rc5Tab, tabs: [rc5Tab], activeTabIndex: 0 });
    expect(rc5.length).toBeGreaterThan(2 * text.length);
  });

  it("holds each picture once, encoded once: no top-level copy and no CDXML envelope around the JSON", async () => {
    const document = await twoDrops();
    const source = createDocumentSessionSource(document);
    const session = buildDocumentTabsSession([tab(source)], 0);
    const text = written(session);
    const data = pictures(document)[0]!.data.image!.dataBase64;
    expect(pictures(document).map(picture => picture.data.image!.dataBase64)).toEqual([data, data]);
    // Each of the two pictures' data appears verbatim, exactly once per picture.
    expect(occurrences(text, data.slice(0, 200))).toBe(2);
    const file = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(file).sort()).toEqual(["activeTabIndex", "savedAt", "tabs", "version"]);
    expect(file.contents).toBeUndefined();
    // The tab's document is its native JSON, which is what a saved file embeds base64-encoded.
    expect(source.contents.startsWith("{")).toBe(true);
    expect(source.payloadHash).toBe(sha256Utf8Hex(source.contents));
    expect(createNativeSavePayload(document).payloadHash).toBe(source.payloadHash);
    // In memory the session still describes its active tab at the top level, for this app's own readers.
    expect(session.contents).toBe(source.contents);
  });

  it("restores the pictures exactly, upright, from what was written", async () => {
    const document = await twoDrops();
    const [restored] = restore(JSON.parse(written(buildDocumentTabsSession([tab(createDocumentSessionSource(document))], 0))));
    expect(pictures(restored!)).toEqual(pictures(document));
    expect(pictures(restored!).map(picture => [picture.data.image!.pixelWidth, picture.data.image!.pixelHeight]))
      .toEqual([[2448, 3264], [2448, 3264]]);
  });

  it("keeps tabs that could not be restored when they are assigned after the session is built, as MainWindow does", async () => {
    const document = await twoDrops();
    const session = buildDocumentTabsSession([tab(createDocumentSessionSource(document))], 0);
    const kept = { displayName: "Old tab", contents: "unknown format", version: 99 };
    session.unrestoredTabs = [kept];
    const file = JSON.parse(written(session));
    expect(file.unrestoredTabs).toEqual([kept]);
    expect(parseDocumentSessionEnvelope(file)!.unrestoredTabs).toEqual([kept]);
  });

  it("builds a document's session contents once, and again only for a new document", async () => {
    const document = await twoDrops();
    const source = createDocumentSessionSource(document);
    expect(createDocumentSessionSource(document)).toBe(source);
    const nudged = moveDocumentObjects(document, [pictures(document)[0]!.id], 1, 0);
    const next = createDocumentSessionSource(nudged);
    expect(next).not.toBe(source);
    expect(pictures(openNativeDocument(next.contents).document!)).toEqual(pictures(nudged));
  });
});

describe("sessions written before this change still restore", () => {
  it("RC5's multi-tab session: CDXML envelopes, the active tab copied to the top level, a PNG-converted photo", async () => {
    // RC5 stored a dropped JPEG as PNG; any PNG picture stands in for it here.
    const png = await prepared("IMG_0896.JPG", pngBytes());
    const first = insertDroppedImages(createEmptyDocument({ title: "First" }), [png], { x: 200, y: 200 }).document;
    const second = await twoDrops();
    const tabs = [tab(createNativeSavePayload(first), { displayName: "First" }), tab(createNativeSavePayload(second))];
    const rc5 = JSON.parse(JSON.stringify({ ...tabs[1]!, tabs, activeTabIndex: 1 }));
    expect(rc5.contents.startsWith("<?xml")).toBe(true);
    const restored = restore(rc5);
    expect(restored.map(pictures)).toEqual([pictures(first), pictures(second)]);
    expect(parseDocumentSessionEnvelope(rc5)!.activeTabIndex).toBe(1);
  });

  it("a version-1 single-document session with no tabs", async () => {
    const document = await twoDrops();
    const single = JSON.parse(JSON.stringify(tab(createNativeSavePayload(document))));
    expect(single.tabs).toBeUndefined();
    expect(restore(single).map(pictures)).toEqual([pictures(document)]);
  });

  it("a session mixing an old CDXML tab with a new native JSON tab", async () => {
    const document = await twoDrops();
    const session = buildDocumentTabsSession([tab(createNativeSavePayload(document)), tab(createDocumentSessionSource(document))], 0);
    const restored = restore(JSON.parse(written(session)));
    expect(restored.map(pictures)).toEqual([pictures(document), pictures(document)]);
  });
});
