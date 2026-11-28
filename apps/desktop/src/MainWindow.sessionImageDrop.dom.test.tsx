// @vitest-environment jsdom
/**
 * The autosaved session after the tester's two drops of IMG_0896.JPG (1.7 MB, 3264 × 2448, EXIF
 * orientation 6), written by MainWindow's own `writeDocumentSessionNow`: each tab once, as native
 * JSON, every picture's data in it once. RC5 wrote 49.9 MB for these two drops. Then the session
 * restores, and a session RC5 wrote restores too; neither restored tab says it was read as a legacy file.
 */
import { crc32, deflateSync } from "node:zlib";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChemDraftDocument, GraphicObject } from "@chemdraft/chem-core";
import { MainWindow } from "./MainWindow";
import { buildDocumentSessionEnvelope, parseDocumentSessionEnvelope, SESSION_TAB_SOURCE_LABEL } from "./documentSession";
import { createNativeSavePayload, createPhase4Document, openNativeDocument } from "./documentWorkflow";
import { DOCUMENT_FILE_DROP_EVENT } from "./imageDrop/dropPosition";
import { syntheticJpeg } from "./imageDrop/jpegTestImages";
import { MemoryStorage } from "./testSupport/memoryStorage";

const PHOTO = syntheticJpeg({ width: 3264, height: 2448, orientation: 6, scanBytes: 1_700_000 });
const PHOTO_PATH = "/Users/tester/Pictures/IMG_0896.JPG";
const PNG_PATH = "/Users/tester/Pictures/scan.png";

/** A valid PNG of `width` × `height` RGBA pixels, stored uncompressed: 3 MB at 1024 × 768. */
function largePng(width: number, height: number): Uint8Array {
  const stride = width * 4 + 1;
  const pixels = Buffer.alloc(stride * height, 200);
  for (let row = 0; row < height; row += 1) pixels[row * stride] = 0;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length, 0);
    bytes.write(type, 4, "ascii");
    data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  };
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(pixels, { level: 0 })), chunk("IEND", Buffer.alloc(0))]));
}

const native = vi.hoisted(() => ({
  session: undefined as unknown,
  /** Every session written, as the Tauri IPC sends it: `JSON.stringify` of the envelope. */
  written: [] as string[],
  events: new Map<string, (payload: unknown) => void>(),
  files: new Map<string, Uint8Array>()
}));

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
vi.mock("@scena/react-ruler", () => ({ default: () => <canvas /> }));
// jsdom decodes nothing: the photo's decode check answers with its stored size, as WebKit's does.
vi.mock("./imageDrop/rasterDecode", async original => {
  const decodeCheck = vi.fn(async () => ({ width: 3264, height: 2448 }));
  const refuse = vi.fn(async () => { throw new Error("a kept JPEG is never converted"); });
  return { ...await original<typeof import("./imageDrop/rasterDecode")>(),
    browserDecodeCheck: decodeCheck, browserImageDecoders: { rasterToPng: refuse, rasterToJpeg: refuse, decodeCheck } };
});
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => true,
  loadDocumentSession: async () => native.session,
  saveDocumentSession: async (envelope: unknown) => { native.written.push(JSON.stringify(envelope)); },
  loadToolsetLayoutState: async () => undefined,
  listToolsetWindowStates: async () => [],
  setToolbarsMenu: async () => {}
}));
vi.mock("./window-manager/tauriEvents", async original => {
  const listen = async (name: string, handler: (event: { payload: unknown }) => void) => {
    const callback = (payload: unknown) => handler({ payload });
    native.events.set(name, callback);
    return () => { if (native.events.get(name) === callback) native.events.delete(name); };
  };
  return { ...await original<typeof import("./window-manager/tauriEvents")>(), listenTauriEvent: listen, listenCurrentWindowEvent: listen };
});
vi.mock("@tauri-apps/plugin-fs", async original => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(),
  stat: async (path: string) => ({ size: native.files.get(path)!.length }),
  readFile: async (path: string) => native.files.get(path)!,
  open: async (path: string) => {
    const bytes = native.files.get(path)!;
    let offset = 0;
    return {
      read: async (buffer: Uint8Array) => {
        const count = Math.min(buffer.length, bytes.length - offset);
        buffer.set(bytes.subarray(offset, offset + count));
        offset += count;
        return count;
      },
      close: async () => {}
    };
  }
}));

/** Time for a drop of the photo, and the 800 ms autosave after it, on a loaded runner. */
const WAIT_MS = 20_000;

const pictures = (document: ChemDraftDocument) =>
  document.pages[0]!.objects.filter((object): object is GraphicObject => object.type === "graphic" && object.graphicKind === "image");
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe("the session MainWindow writes after two drops of a 1.7 MB photo", { timeout: 6 * WAIT_MS }, () => {
  let container: HTMLDivElement;
  let root: Root;
  const agent = () => window.__CHEMDRAFT_AGENT__!;
  const snapshot = () => agent().snapshot().document;
  const status = () => container.querySelector("[data-status-message]")?.textContent;

  beforeEach(() => {
    native.session = undefined;
    native.written.length = 0;
    native.events.clear();
    native.files.clear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    vi.spyOn(window, "focus").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
      Object.defineProperty(Element.prototype, method, { configurable: true, value: vi.fn(() => false) });
    }
    window.history.replaceState(null, "", "/?agentBridge=1");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete window.__CHEMDRAFT_AGENT__;
    window.history.replaceState(null, "", "/");
    for (const method of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) {
      Reflect.deleteProperty(Element.prototype, method);
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function settle() {
    await act(async () => { for (let index = 0; index < 20; index += 1) await new Promise(resolve => setTimeout(resolve, 0)); });
  }

  async function eventually(assertion: () => void) {
    await vi.waitFor(async () => { await settle(); assertion(); }, { timeout: WAIT_MS, interval: 20 });
  }

  async function mount(title = "Photos") {
    await act(async () => root.render(<MainWindow initialDocument={createPhase4Document(title)} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} initialCrosshairsVisible={false} nativePalette shortcutPlatform="macos" />));
    await eventually(() => expect(native.events.has(DOCUMENT_FILE_DROP_EVENT)).toBe(true));
  }

  async function dropPhoto(position: { x: number; y: number }) {
    const count = pictures(snapshot()).length;
    await act(async () => native.events.get(DOCUMENT_FILE_DROP_EVENT)!({ paths: [PHOTO_PATH], position, units: "css", topInsetRemoved: 0 }));
    await eventually(() => expect(pictures(snapshot())).toHaveLength(count + 1));
    await eventually(() => expect(status()).toBe("Inserted picture IMG_0896.JPG; scaled to fit the page: IMG_0896.JPG"));
  }

  /** The last session written once it holds `count` pictures in its active tab. */
  async function writtenSession(count: number): Promise<string> {
    let text = "";
    await eventually(() => {
      text = native.written.at(-1) ?? "";
      const session = parseDocumentSessionEnvelope(JSON.parse(text || "null"));
      expect(session && "contents" in session ? pictures(openNativeDocument(session.contents).document!).length : -1).toBe(count);
    });
    return text;
  }

  it("is within twice the picture bytes, holds each picture once, and restores both upright", async () => {
    native.files.set(PHOTO_PATH, PHOTO);
    await mount();
    await dropPhoto({ x: 300, y: 300 });
    await dropPhoto({ x: 500, y: 500 });
    const dropped = pictures(snapshot());
    expect(dropped.map(picture => picture.data.image!.mimeType)).toEqual(["image/svg+xml", "image/svg+xml"]);

    const text = await writtenSession(2);
    // Two drops of a 1.7 MB photo: base64 of an SVG that holds the JPEG in base64 (16/9 of its bytes),
    // once per picture, and nothing else of size. RC5 wrote 49.9 MB.
    const pictureBytes = 2 * PHOTO.length;
    expect(text.length).toBeLessThan(2 * pictureBytes);
    expect(text.length).toBeLessThan(10_000_000);
    console.info(`session after two drops of a ${PHOTO.length}-byte photo: ${text.length} bytes`);
    // Each picture's data once: no top-level copy of the active tab, no CDXML envelope around it.
    const file = JSON.parse(text) as { tabs: Array<{ contents: string }>; contents?: string };
    expect(Object.keys(file).sort()).toEqual(["activeTabIndex", "savedAt", "tabs", "version"]);
    expect(file.tabs).toHaveLength(1);
    expect(file.tabs[0]!.contents.startsWith("{")).toBe(true);
    expect(occurrences(text, dropped[0]!.data.image!.dataBase64.slice(0, 400))).toBe(2);
    // The save payload is what File > Save writes; the session no longer holds it.
    expect(occurrences(text, createNativeSavePayload(snapshot()).contents.slice(0, 200))).toBe(0);

    // A relaunch restores both pictures exactly, and the tab is the document it was, not a legacy JSON file.
    await act(async () => root.unmount());
    root = createRoot(container);
    native.session = JSON.parse(text);
    native.written.length = 0;
    await mount("Start");
    await eventually(() => expect(pictures(snapshot())).toHaveLength(2));
    expect(pictures(snapshot())).toEqual(dropped);
    expect(pictures(snapshot()).every(picture => picture.height > picture.width)).toBe(true);
    const rewritten = JSON.parse(await writtenSession(2)) as { tabs: Array<{ openWarnings?: { sourceLabel: string } }> };
    expect(rewritten.tabs[0]!.openWarnings?.sourceLabel).toBe(SESSION_TAB_SOURCE_LABEL);
  });

  it("nudges a dropped photo and a dropped 3 MB PNG with an arrow key without decoding either picture", async () => {
    native.files.set(PHOTO_PATH, PHOTO);
    native.files.set(PNG_PATH, largePng(1024, 768));
    await mount();
    await dropPhoto({ x: 300, y: 300 });
    await act(async () => native.events.get(DOCUMENT_FILE_DROP_EVENT)!({ paths: [PNG_PATH], position: { x: 500, y: 500 }, units: "css", topInsetRemoved: 0 }));
    await eventually(() => expect(pictures(snapshot())).toHaveLength(2));
    const canvas = container.querySelector<HTMLElement>(".canvas-region")!;
    await act(async () => canvas.focus());
    await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true, cancelable: true })));
    const before = pictures(snapshot());
    expect(snapshot().selection.objectIds).toEqual(before.map(picture => picture.id));
    expect(before.map(picture => picture.data.image!.mimeType)).toEqual(["image/svg+xml", "image/png"]);
    const atob = vi.spyOn(globalThis, "atob");
    // Uint8Array.fromBase64 is Node 25 and later; on Node 24 (CI) decoding falls back to atob alone.
    const fromBase64 = "fromBase64" in Uint8Array
      ? vi.spyOn(Uint8Array as unknown as { fromBase64: (value: string) => Uint8Array }, "fromBase64") : undefined;
    const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    await act(async () => canvas.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    const after = pictures(snapshot());
    expect(after.map(picture => picture.x)).toEqual(before.map(picture => picture.x + 1));
    expect(after.map(picture => picture.data.image!.dataBase64)).toEqual(before.map(picture => picture.data.image!.dataBase64));
    // Nothing the nudge ran (the patch, its validation, the commit, the redraw) decoded either picture.
    const large = (calls: unknown[][]) => calls.filter(([value]) => typeof value === "string" && value.length > 10_000).length;
    expect(large(atob.mock.calls) + (fromBase64 ? large(fromBase64.mock.calls) : 0)).toBe(0);
  });

  it("restores a session RC5 wrote (CDXML envelope, active tab copied to the top level) and writes it back once", async () => {
    native.files.set(PHOTO_PATH, PHOTO);
    await mount();
    await dropPhoto({ x: 300, y: 300 });
    const dropped = pictures(snapshot());
    const tab = buildDocumentSessionEnvelope(createNativeSavePayload(snapshot()), { dirty: true }, "Photos", false);
    const rc5 = JSON.parse(JSON.stringify({ ...tab, pristine: false, tabs: [{ ...tab, pristine: false }], activeTabIndex: 0 }));
    expect(rc5.contents.startsWith("<?xml")).toBe(true);

    await act(async () => root.unmount());
    root = createRoot(container);
    native.session = rc5;
    native.written.length = 0;
    await mount("Start");
    await eventually(() => expect(pictures(snapshot())).toEqual(dropped));
    const text = await writtenSession(1);
    const file = JSON.parse(text) as { tabs: Array<{ contents: string; openWarnings?: { sourceLabel: string } }> };
    expect(file.tabs[0]!.contents.startsWith("{")).toBe(true);
    // Read from its CDXML envelope, the old tab keeps the label File > Open gives that form.
    expect(file.tabs[0]!.openWarnings?.sourceLabel).toBe("ChemDraft CDXML envelope");
    expect(text.length).toBeLessThan(2 * PHOTO.length);
  });
});
