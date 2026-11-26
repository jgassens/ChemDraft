// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImageGraphicObject, serializeDocument, type ChemDraftDocument, type GraphicObject } from "@chemdraft/chem-core";
import { MainWindow, objectResizeStretches } from "./MainWindow";
import { createPhase4Document } from "./documentWorkflow";
import { DOCUMENT_FILE_DROP_EVENT } from "./imageDrop/dropPosition";
import { browserDecodeCheck, browserRasterToPng } from "./imageDrop/rasterDecode";
import { damagedDropFixture } from "./imageDrop/pngTestImages";
import { jpegHeader, pngBytes, svgBytes } from "./imageDrop/testFixtures";
import { setNativePromptProvider } from "./nativePrompt";
import { picturePngBase64 } from "./testSupport/imageFixture";
import { MemoryStorage } from "./testSupport/memoryStorage";

const native = vi.hoisted(() => ({
  desktop: false,
  events: new Map<string, (payload: unknown) => void>(),
  /** Every listen and unlisten, by event name, in order. */
  subscriptions: [] as string[],
  files: new Map<string, Uint8Array>(),
  stat: vi.fn<(path: string) => Promise<{ size: number }>>(),
  /** When set, a native read waits for it: a slow disk. */
  gate: undefined as Promise<void> | undefined
}));

vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));
// jsdom has no canvas: the webview decoder is replaced by one returning a real 1 × 1 PNG.
vi.mock("./imageDrop/rasterDecode", async (original) => {
  const { pngBytes: png } = await import("./imageDrop/testFixtures");
  const browserRasterToPng = vi.fn(async () => ({ png: png(), width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, downscaled: false }));
  // The PNG and SVG decode checks: jsdom cannot decode, so every picture decodes.
  const browserDecodeCheck = vi.fn(async () => ({ width: 1, height: 1 }));
  return { ...await original<typeof import("./imageDrop/rasterDecode")>(),
    browserRasterToPng, browserDecodeCheck, browserImageDecoders: { rasterToPng: browserRasterToPng, decodeCheck: browserDecodeCheck } };
});
vi.mock("./window-manager", async (original) => ({
  ...await original<typeof import("./window-manager")>(),
  isDesktopRuntime: () => native.desktop,
  loadDocumentSession: async () => undefined,
  saveDocumentSession: async () => undefined
}));
vi.mock("./window-manager/tauriEvents", async (original) => {
  const listen = async (name: string, handler: (event: { payload: unknown }) => void) => {
    const callback = (payload: unknown) => handler({ payload });
    native.events.set(name, callback);
    native.subscriptions.push(`listen ${name}`);
    return () => {
      native.subscriptions.push(`unlisten ${name}`);
      if (native.events.get(name) === callback) native.events.delete(name);
    };
  };
  return { ...await original<typeof import("./window-manager/tauriEvents")>(), listenTauriEvent: listen, listenCurrentWindowEvent: listen };
});
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn(async () => null)
}));
vi.mock("@tauri-apps/plugin-fs", async (original) => ({
  ...await original<typeof import("@tauri-apps/plugin-fs")>(),
  stat: native.stat,
  readFile: async (path: string) => native.files.get(path)!,
  open: async (path: string) => {
    const bytes = native.files.get(path)!;
    let offset = 0;
    return {
      read: async (buffer: Uint8Array) => {
        await native.gate;
        const count = Math.min(buffer.length, bytes.length - offset);
        buffer.set(bytes.subarray(offset, offset + count));
        offset += count;
        return count;
      },
      close: async () => {}
    };
  }
}));

type DropFile = { name: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> };

function dropFile(name: string, bytes: Uint8Array, size = bytes.length): DropFile & { reads: () => number } {
  let reads = 0;
  return { name, size, reads: () => reads, arrayBuffer: async () => { reads += 1; return bytes.slice().buffer as ArrayBuffer; } };
}

const documentFile = (title: string) => {
  const bytes = new TextEncoder().encode(serializeDocument(createPhase4Document(title)));
  return dropFile(`${title}.chemdraft`, bytes);
};

const SVG = svgBytes('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><script>alert(1)</script><rect width="40" height="20" fill="red"/></svg>');

/** How long a drop may take on a loaded runner before a positive assertion gives up. */
const DROP_WAIT_MS = 10_000;

describe("dropping picture files on the document window", { timeout: 3 * DROP_WAIT_MS }, () => {
  let container: HTMLDivElement;
  let root: Root;
  const agent = () => window.__CHEMDRAFT_AGENT__!;
  const snapshot = () => agent().snapshot().document;
  const status = () => container.querySelector("[data-status-message]")?.textContent;
  const canvas = () => container.querySelector<HTMLElement>(".canvas-region")!;
  const pictures = (document: ChemDraftDocument = snapshot()) =>
    document.pages[0]!.objects.filter((object): object is GraphicObject => object.type === "graphic" && object.graphicKind === "image");
  const tabs = () => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

  beforeEach(() => {
    native.desktop = false;
    native.events.clear();
    native.subscriptions.length = 0;
    native.files.clear();
    native.stat.mockReset();
    native.gate = undefined;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
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

  async function mount(initialDocument = createPhase4Document("Drop target"), platform: "macos" | "windows" | "linux" = "macos",
    options: { scrollbar?: number } = {}) {
    await act(async () => root.render(<MainWindow initialDocument={initialDocument} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} initialCrosshairsVisible={false}
      nativePalette={false} shortcutPlatform={platform} />));
    stubLayout(options.scrollbar ?? 0);
    await settle();
  }

  /** jsdom has no layout: the page and canvas are drawn 1:1 from (0, 0), less any scrollbars. */
  function stubLayout(scrollbar: number) {
    const rect = { x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 700, width: 900, height: 700, toJSON() {} };
    for (const element of container.querySelectorAll(".page, .canvas-region")) {
      vi.spyOn(element, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
    }
    vi.spyOn(canvas(), "clientWidth", "get").mockReturnValue(rect.width - scrollbar);
    vi.spyOn(canvas(), "clientHeight", "get").mockReturnValue(rect.height - scrollbar);
  }

  async function settle() {
    await act(async () => { for (let index = 0; index < 30; index += 1) await new Promise(resolve => setTimeout(resolve, 0)); });
  }

  /**
   * Settles until `assertion` holds. A drop finishes on its own clock (the write gate polls on a real
   * timer while a gesture is live), so a fixed number of ticks is no proof it has finished.
   */
  async function eventually(assertion: () => void) {
    await vi.waitFor(async () => { await settle(); assertion(); }, { timeout: DROP_WAIT_MS, interval: 0 });
  }

  async function browserDrop(files: DropFile[], client?: { x: number; y: number }, target: Element = canvas()) {
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } });
    if (client) Object.defineProperties(event, { clientX: { value: client.x }, clientY: { value: client.y } });
    await act(async () => { target.dispatchEvent(event); });
    await settle();
    return event;
  }

  async function command(id: string) {
    await act(async () => { await agent().command(id); });
  }

  const centre = (object: GraphicObject) => ({ x: object.x + object.width / 2, y: object.y + object.height / 2 });

  it("inserts PNG, JPEG and SVG at the drop point as one selected 'Insert Image' entry, undone and redone exactly", async () => {
    await mount();
    const before = snapshot();
    const client = agent().resolvePoint({ page: { x: 300, y: 200 } }).client;
    const event = await browserDrop([dropFile("a.png", pngBytes()), dropFile("b.jpg", jpegHeader(8, 8)), dropFile("c.svg", SVG)], client);
    expect(event.defaultPrevented).toBe(true);
    await eventually(() => expect(status()).toBe("Inserted 3 pictures (a.png, b.jpg, c.svg); c.svg: scripts and animation were removed"));
    expect(vi.mocked(browserRasterToPng)).toHaveBeenCalledTimes(1);
    const inserted = pictures();
    expect(inserted.map(object => object.data.image!.mimeType)).toEqual(["image/png", "image/png", "image/svg+xml"]);
    expect(centre(inserted[0]!)).toEqual({ x: 300, y: 200 });
    expect(centre(inserted[1]!)).toEqual({ x: 324, y: 224 });
    expect([inserted[2]!.width, inserted[2]!.height]).toEqual([40, 20]);
    expect(atob(inserted[2]!.data.image!.dataBase64)).not.toContain("script");
    expect(snapshot().selection.objectIds).toEqual(inserted.map(object => object.id));
    expect(document.activeElement).toBe(canvas());
    const after = snapshot();

    await command("edit.undo");
    expect(status()).toBe("Undid Insert Image");
    expect(snapshot()).toEqual(before);
    await command("edit.redo");
    expect(snapshot()).toEqual(after);
    await command("edit.undo");
    expect(snapshot()).toEqual(before);
  });

  it("puts a drop over a toolbar at the nearest visible page point and keeps the picture on the page", async () => {
    await mount();
    await browserDrop([dropFile("edge.png", pngBytes())], { x: -50, y: -80 }, container.querySelector("main") ?? canvas());
    await eventually(() => expect(pictures()).toHaveLength(1));
    const [picture] = pictures();
    expect(picture).toMatchObject({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("puts a drop over a ruler or a scrollbar at the nearest drawable point, as the pointer check reads the canvas", async () => {
    await mount(createPhase4Document("Rulers"), "macos", { scrollbar: 15 });
    // The ruler widget needs a real canvas to draw; the strips it occupies are what matter here.
    canvas().classList.add("rulers-visible");
    // Over the top ruler (32 px), then over the bottom scrollbar (the last 15 px).
    await browserDrop([dropFile("ruler.png", pngBytes())], { x: 300, y: 5 });
    await browserDrop([dropFile("scrollbar.png", pngBytes())], { x: 400, y: 695 });
    await eventually(() => expect(pictures()).toHaveLength(2));
    expect(pictures().map(centre)).toEqual([{ x: 300, y: 32 }, { x: 400, y: 685 }]);
  });

  it("waits for a live resize to finish, then inserts the picture as its own entry on top", async () => {
    const drawing = createPhase4Document("Gesture");
    drawing.pages[0]!.objects = [{
      id: "rect-a", type: "graphic", graphicKind: "rect", x: 100, y: 100, width: 80, height: 50, rotation: 0, style: {}, data: {}
    }];
    drawing.selection.objectIds = ["rect-a"];
    await mount(drawing);
    const page = container.querySelector<HTMLElement>(".page")!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: DropFile = { name: "slow.png", size: pngBytes().length, arrayBuffer: async () => { await gate; return pngBytes().buffer as ArrayBuffer; } };
    // The decode check is the drop's last asynchronous step: once it has returned, the commit is
    // queued at the write gate within the same microtask run.
    let decoded = false;
    vi.mocked(browserDecodeCheck).mockImplementationOnce(async () => { decoded = true; return { width: 1, height: 1 }; });
    await browserDrop([slow], { x: 400, y: 400 });
    async function pointer(target: Element, type: string, x: number, y: number) {
      const event = new MouseEvent(type, { button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y, bubbles: true, cancelable: true });
      Object.defineProperty(event, "pointerId", { value: 7 });
      await act(async () => target.dispatchEvent(event));
    }
    const handle = container.querySelector('[data-object-resize-corner="bottom-right"]')!;
    expect(handle).not.toBeNull();
    await pointer(handle, "pointerdown", 180, 150);
    await pointer(page, "pointermove", 220, 175);
    // The picture is read and decoded while the resize is still live: nothing is written yet.
    release();
    await eventually(() => expect(decoded).toBe(true));
    await settle();
    expect(pictures()).toHaveLength(0);
    await pointer(page, "pointermove", 260, 200);
    await pointer(page, "pointerup", 260, 200);
    await eventually(() => expect(status()).toMatch(/^Inserted picture slow\.png/));
    const [picture] = pictures();
    expect(picture).toBeDefined();
    const resized = snapshot().pages[0]!.objects.find(object => object.id === "rect-a") as GraphicObject;
    expect(resized.width).toBeGreaterThan(80);
    // Two entries: the picture on top of the resize, each undone on its own.
    await command("edit.undo");
    expect(pictures()).toHaveLength(0);
    expect((snapshot().pages[0]!.objects.find(object => object.id === "rect-a") as GraphicObject).width).toBe(resized.width);
    await command("edit.undo");
    expect((snapshot().pages[0]!.objects.find(object => object.id === "rect-a") as GraphicObject).width).toBe(80);
  });

  it("refuses BMP, TIFF and oversize files by name before reading them, and inserts the rest", async () => {
    await mount();
    const bmp = dropFile("scan.bmp", new Uint8Array(30));
    const big = dropFile("huge.png", pngBytes(), 20 * 1024 * 1024 + 1);
    const fake = dropFile("fake.jpg", new TextEncoder().encode("not a picture"));
    await browserDrop([bmp, big, fake, dropFile("ok.png", pngBytes())], { x: 100, y: 100 });
    await eventually(() => expect(status()).toBe([
      "Inserted picture ok.png",
      "Couldn't drop \"scan.bmp\": BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first",
      "Couldn't drop \"huge.png\": it is just over 20.0 MB; a dropped picture can be at most 20.0 MB",
      "Couldn't drop \"fake.jpg\": its contents are not a PNG, JPEG, GIF, WebP or SVG picture."
    ].join("; ")));
    // Checked once the drop has finished, so no later read could still be on its way.
    expect(bmp.reads()).toBe(0);
    expect(big.reads()).toBe(0);
    expect(pictures()).toHaveLength(1);
  });

  it("names every refused file in the status and its tooltip, the sixth included", async () => {
    await mount();
    const scans = ["a", "b", "c", "d", "e"].map(name => dropFile(`${name}.bmp`, new Uint8Array(30)));
    await browserDrop([...scans, dropFile("fake.png", new TextEncoder().encode("not a picture"))], { x: 100, y: 100 });
    const last = "Couldn't drop \"fake.png\": its contents are not a PNG, JPEG, GIF, WebP or SVG picture.";
    await eventually(() => expect(status()?.endsWith(last)).toBe(true));
    const title = container.querySelector("[data-status-message]")!.getAttribute("title")!;
    expect(title.endsWith(last)).toBe(true);
    expect(title).toContain("Couldn't drop \"a.bmp\"");
    expect(title).not.toMatch(/more files/);
  });

  it("still opens a dropped document exactly as before, and does both for a mixed drop", async () => {
    await mount();
    await browserDrop([documentFile("Only document")]);
    await eventually(() => expect(snapshot().title).toBe("Only document"));
    expect(tabs()).toHaveLength(1);

    await browserDrop([dropFile("mixed.png", pngBytes()), dropFile("scan.bmp", new Uint8Array(30)), documentFile("Mixed document")], { x: 200, y: 200 });
    // The picture went into the tab under the drop; the document then opened in a tab of its own,
    // which shows the whole outcome, naming the document as its own open would.
    const pictureStatus = "Inserted picture mixed.png; Couldn't drop \"scan.bmp\": BMP and TIFF pictures can't be dropped yet; save it as PNG or JPEG first.";
    await eventually(() => expect(snapshot().title).toBe("Mixed document"));
    await eventually(() => expect(status()).toBe(`${pictureStatus.replace(/\.$/, "")}; Opened Mixed document.chemdraft as legacy ChemDraft JSON`));
    expect(tabs()).toHaveLength(2);
    // The receiving tab keeps the pictures' own result, never "Reading…".
    await act(async () => { tabs()[0]!.click(); });
    await eventually(() => expect(snapshot().title).toBe("Only document"));
    expect(status()).toBe(pictureStatus);
    expect(pictures()).toHaveLength(1);
  });

  /** Two tabs, the first holding "First"; the first is active, as the drop's target. */
  async function twoTabs() {
    await mount();
    await browserDrop([documentFile("First")]);
    await eventually(() => expect(snapshot().title).toBe("First"));
    await command("document.new");
    await act(async () => { tabs()[0]!.click(); });
    await eventually(() => expect(snapshot().title).toBe("First"));
  }

  function slowPicture() {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const file: DropFile = { name: "slow.png", size: pngBytes().length, arrayBuffer: async () => { await gate; return pngBytes().buffer as ArrayBuffer; } };
    return { file, release };
  }

  const leftTab = "\"slow.png\" was not inserted: the document of the drop is no longer the active tab; try the drop again.";

  it("reports a drop refused because the user switched tabs on both tabs, never leaving its own on Reading", async () => {
    await twoTabs();
    const slow = slowPicture();
    await browserDrop([slow.file], { x: 100, y: 100 });
    expect(status()).toBe("Reading the dropped picture…");
    await act(async () => { tabs()[1]!.click(); });
    await eventually(() => expect(snapshot().title).not.toBe("First"));
    slow.release();
    // The tab now in front tells the refusal, so it is not missed.
    await eventually(() => expect(status()).toBe(leftTab));
    await act(async () => { tabs()[0]!.click(); });
    await eventually(() => expect(snapshot().title).toBe("First"));
    expect(status()).toBe(leftTab);
    expect(pictures()).toHaveLength(0);
  });

  it("shows the outcome on the active tab when the tab the drop landed on has closed", async () => {
    await twoTabs();
    const slow = slowPicture();
    await browserDrop([slow.file], { x: 100, y: 100 });
    await act(async () => { tabs()[1]!.click(); });
    await act(async () => { container.querySelectorAll<HTMLButtonElement>(".document-tab-close")[0]!.click(); });
    await eventually(() => expect(tabs()).toHaveLength(1));
    slow.release();
    await eventually(() => expect(status()).toBe(leftTab));
    expect(pictures()).toHaveLength(0);
  });

  it("never inserts into a document that replaced the drop target while the picture was read", async () => {
    await mount();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: DropFile = { name: "slow.png", size: pngBytes().length, arrayBuffer: async () => { await gate; return pngBytes().buffer as ArrayBuffer; } };
    await browserDrop([slow], { x: 100, y: 100 });
    // The blank tab is reused by this open: same tab, different document.
    await browserDrop([documentFile("Replacement")]);
    await eventually(() => expect(snapshot().title).toBe("Replacement"));
    release();
    await eventually(() => expect(status()).toBe(leftTab));
    expect(pictures()).toHaveLength(0);
    expect(tabs()).toHaveLength(1);
  });

  it("names the picture and the document of a mixed drop whose tab changed while the picture was read", async () => {
    await twoTabs();
    const slow = slowPicture();
    await browserDrop([slow.file, documentFile("Arrived")], { x: 100, y: 100 });
    await act(async () => { tabs()[1]!.click(); });
    await eventually(() => expect(snapshot().title).not.toBe("First"));
    slow.release();
    await eventually(() => expect(status()).toBe(`${leftTab.replace(/\.$/, "")}; Opened Arrived.chemdraft as legacy ChemDraft JSON`));
    await act(async () => { tabs()[0]!.click(); });
    await eventually(() => expect(snapshot().title).toBe("First"));
    expect(status()).toBe(leftTab);
    expect(pictures()).toHaveLength(0);
  });

  it("refuses a web link or a shortcut by name, without reading it or navigating", async () => {
    await mount();
    const link = dropFile("link.url", new TextEncoder().encode("[InternetShortcut]\nURL=https://example.com/\n"));
    const event = await browserDrop([link], { x: 100, y: 100 });
    expect(event.defaultPrevented).toBe(true);
    await eventually(() => expect(status()).toBe("Couldn't drop \"link.url\": it is a web link, not a picture or a drawing."));
    expect(link.reads()).toBe(0);
    expect(tabs()).toHaveLength(1);
    const shortcut = dropFile("Drawing.lnk", new Uint8Array(76));
    await browserDrop([dropFile("page.webloc", new Uint8Array(40)), dropFile("ok.png", pngBytes()), shortcut], { x: 100, y: 100 });
    await eventually(() => expect(status()).toBe([
      "Inserted picture ok.png",
      "Couldn't drop \"page.webloc\": it is a web link, not a picture or a drawing",
      "Couldn't drop \"Drawing.lnk\": it is a shortcut; drop the file it points to instead."
    ].join("; ")));
    expect(shortcut.reads()).toBe(0);
    expect(pictures()).toHaveLength(1);
  });

  it("prevents navigation for a file dropped outside the canvas and shows copy over the canvas", async () => {
    await mount();
    const over = new Event("dragover", { bubbles: true, cancelable: true });
    const transfer = { types: ["Files"], dropEffect: "none" };
    Object.defineProperty(over, "dataTransfer", { value: transfer });
    await act(async () => { canvas().dispatchEvent(over); });
    expect(over.defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe("copy");
    const outside = await browserDrop([], undefined, document.body);
    expect(outside.defaultPrevented).toBe(false);
    const files = await browserDrop([documentFile("From the tab strip")], undefined, container.querySelector('[role="tablist"]') ?? document.body);
    expect(files.defaultPrevented).toBe(true);
    await eventually(() => expect(snapshot().title).toBe("From the tab strip"));
  });

  it("refuses PNGs whose image data is damaged, by name, and inserts a good one dropped with them", async () => {
    await mount();
    const damaged = "the PNG could not be decoded: its image data is damaged";
    await browserDrop([dropFile("r8-damaged.png", damagedDropFixture("r8-damaged.png")),
      dropFile("r9-midcorrupt.png", damagedDropFixture("r9-midcorrupt.png"))], { x: 100, y: 100 });
    await eventually(() => expect(status()).toBe(`No pictures were inserted; Couldn't drop "r8-damaged.png": ${damaged}; `
      + `Couldn't drop "r9-midcorrupt.png": ${damaged}.`));
    expect(pictures()).toHaveLength(0);
    await browserDrop([dropFile("r8-damaged.png", damagedDropFixture("r8-damaged.png")), dropFile("ok.png", pngBytes()),
      dropFile("r9-midcorrupt.png", damagedDropFixture("r9-midcorrupt.png"))], { x: 100, y: 100 });
    await eventually(() => expect(status()).toBe(`Inserted picture ok.png; Couldn't drop "r8-damaged.png": ${damaged}; `
      + `Couldn't drop "r9-midcorrupt.png": ${damaged}.`));
    expect(pictures().map(picture => picture.data.image!.dataBase64)).toEqual([btoa(String.fromCharCode(...pngBytes()))]);
  });

  describe("a mixed drop names the picture and every document", () => {
    const cdxml = (atoms = '<n id="10" Element="6" p="20 30"/><n id="11" Element="8" p="40 30"/>') =>
      `<?xml version="1.0" encoding="UTF-8"?><CDXML><page id="1" BoundingBox="0 0 612 792"><fragment id="2">${atoms}`
      + '<b id="20" B="10" E="11" Order="1"/></fragment></page></CDXML>';
    // The second atom lies past the declared Letter page, so opening it asks about the page size.
    const oversized = cdxml('<n id="10" Element="6" p="75 75"/><n id="11" Element="6" p="975 75"/>');
    const cdxmlFile = (name: string, source = cdxml()) => dropFile(name, new TextEncoder().encode(source));
    // `cdxml()` names no atom labels the import keeps, so its open reports two warnings.
    const opened = (name: string, warnings = " with 2 warnings") => `Opened ${name} as external CDXML subset${warnings}`;
    const warningButton = () => container.querySelector("[data-open-warnings-button]");
    /** The tab in front, by its title (a CDXML document's own title is not its file name). */
    const front = () => container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;

    it("names both on the browser route, and the receiving tab keeps the picture's own status", async () => {
      await mount();
      await browserDrop([dropFile("mixed.png", pngBytes()), cdxmlFile("mixed.cdxml")], { x: 100, y: 100 });
      await eventually(() => expect(front()).toBe("mixed.cdxml"));
      await eventually(() => expect(status()).toBe(`Inserted picture mixed.png; ${opened("mixed.cdxml")}`));
      await act(async () => { tabs()[0]!.click(); });
      await eventually(() => expect(status()).toBe("Inserted picture mixed.png"));
      expect(pictures()).toHaveLength(1);
    });

    it("names both on the native route", async () => {
      native.desktop = true;
      native.files.set("/Users/me/Drops/mixed.png", pngBytes());
      native.files.set("/Users/me/Drops/mixed.cdxml", new TextEncoder().encode(cdxml()));
      native.stat.mockImplementation(async path => ({ size: native.files.get(path)?.length ?? 0 }));
      await mount(createPhase4Document("Desktop"), "windows");
      await eventually(() => expect(native.events.has(DOCUMENT_FILE_DROP_EVENT)).toBe(true));
      await act(async () => native.events.get(DOCUMENT_FILE_DROP_EVENT)!({ paths: ["/Users/me/Drops/mixed.png", "/Users/me/Drops/mixed.cdxml"],
        position: { x: 10, y: 10 }, units: "physical", topInsetRemoved: 0 }));
      await eventually(() => expect(status()).toBe(`Inserted picture mixed.png; ${opened("mixed.cdxml")}`));
      expect(front()).toBe("mixed.cdxml");
    });

    it("names each of two documents with its own status, warnings included, and leaves the warnings on the tab", async () => {
      await mount();
      const metals = readFileSync("packages/fixtures/cdxml/ten-metals.cdxml", "utf8");
      await browserDrop([cdxmlFile("plain.cdxml"), dropFile("one.png", pngBytes()), cdxmlFile("metals.cdxml", metals)], { x: 100, y: 100 });
      await eventually(() => expect(front()).toBe("metals.cdxml"));
      await eventually(() => expect(status()).toBe(`Inserted picture one.png; ${opened("plain.cdxml")}; ${opened("metals.cdxml", " with 11 warnings")}`));
      expect(warningButton()?.textContent).toContain("11 warnings");
      expect(tabs()).toHaveLength(3);
    });

    it("names a document that was already open as such", async () => {
      await mount();
      await browserDrop([documentFile("Kept")]);
      await eventually(() => expect(snapshot().title).toBe("Kept"));
      await command("document.new");
      await eventually(() => expect(tabs()).toHaveLength(2));
      await browserDrop([dropFile("again.png", pngBytes()), documentFile("Kept")], { x: 100, y: 100 });
      await eventually(() => expect(status()).toBe("Inserted picture again.png; Kept.chemdraft was already open"));
      expect(snapshot().title).toBe("Kept");
      expect(tabs()).toHaveLength(2);
    });

    it("leaves out the page-size clause once its prompt has been answered", async () => {
      const prompts: string[] = [];
      const restore = setNativePromptProvider(async prompt => {
        prompts.push(prompt.title);
        return "keep";
      });
      try {
        await mount();
        await browserDrop([dropFile("wide.png", pngBytes()), cdxmlFile("wide.cdxml", oversized)], { x: 100, y: 100 });
        await eventually(() => expect(status()).toBe(`Inserted picture wide.png; ${opened("wide.cdxml")}`));
        expect(front()).toBe("wide.cdxml");
        expect(prompts).toEqual(["Imported Content Exceeds Page"]);
      } finally { restore(); }
    });

    it("names a document that fails, and the one that opened beside it", async () => {
      await mount();
      await browserDrop([dropFile("p.png", pngBytes()), cdxmlFile("broken.cdxml", "not a document")], { x: 100, y: 100 });
      await eventually(() => expect(status()).toMatch(/^Inserted picture p\.png; Could not open broken\.cdxml: ./));
      await browserDrop([dropFile("q.png", pngBytes()), cdxmlFile("good.cdxml"), cdxmlFile("broken.cdxml", "not a document")], { x: 100, y: 100 });
      await eventually(() => expect(status()).toMatch(
        new RegExp(`^Inserted picture q\\.png; ${opened("good.cdxml").replaceAll(".", "\\.")}; Opened 1 of 2 files\\. Could not open broken\\.cdxml: .`)));
    });

    it("leaves a drop of documents alone showing what it showed before", async () => {
      await mount();
      await browserDrop([cdxmlFile("only.cdxml")]);
      await eventually(() => expect(front()).toBe("only.cdxml"));
      await eventually(() => expect(status()).toBe(opened("only.cdxml")));
      await browserDrop([cdxmlFile("a.cdxml"), cdxmlFile("b.cdxml")]);
      await eventually(() => expect(front()).toBe("b.cdxml"));
      await eventually(() => expect(status()).toBe(opened("b.cdxml")));
    });
  });

  describe("desktop document file drop event", () => {
    it.each([
      // macOS: Rust has already taken the 28-point title-bar inset off y; it is not taken off again.
      ["macos", 2, { x: 300, y: 200 }, "css", 28],
      ["linux", 1.5, { x: 300, y: 200 }, "css", 0],
      ["windows", 1.5, { x: 450, y: 300 }, "physical", 0],
      ["windows", 2, { x: 600, y: 400 }, "physical", 0]
    ] as const)("places the picture at the converted %s position (scale %s)", async (platform, scale, position, units, topInsetRemoved) => {
      native.desktop = true;
      vi.stubGlobal("devicePixelRatio", scale);
      native.files.set("/Users/me/Pictures/mol.png", pngBytes());
      native.stat.mockImplementation(async path => ({ size: native.files.get(path)?.length ?? 0 }));
      await mount(createPhase4Document("Desktop"), platform);
      await eventually(() => expect(native.events.has(DOCUMENT_FILE_DROP_EVENT)).toBe(true));
      // Tauri's own event, measured from under the macOS title bar, is not listened to: one insertion per drop.
      expect(native.events.has("tauri://drag-drop")).toBe(false);
      await act(async () => native.events.get(DOCUMENT_FILE_DROP_EVENT)!({ paths: ["/Users/me/Pictures/mol.png"], position, units, topInsetRemoved }));
      await eventually(() => expect(status()).toBe("Inserted picture mol.png"));
      expect(pictures()).toHaveLength(1);
      expect(centre(pictures()[0]!)).toEqual({ x: 300, y: 200 });
    });

    it("refuses an oversize native file from stat, without opening it, and still opens a dropped document", async () => {
      native.desktop = true;
      native.files.set("C:\\Drawings\\doc.chemdraft", new TextEncoder().encode(serializeDocument(createPhase4Document("Native document"))));
      native.stat.mockImplementation(async path => ({ size: path.endsWith(".png") ? 21 * 1024 * 1024 : native.files.get(path)!.length }));
      await mount(createPhase4Document("Desktop"), "windows");
      await eventually(() => expect(native.events.has(DOCUMENT_FILE_DROP_EVENT)).toBe(true));
      await act(async () => native.events.get(DOCUMENT_FILE_DROP_EVENT)!({ paths: ["C:\\Pictures\\big.png", "C:\\Drawings\\doc.chemdraft"],
        position: { x: 10, y: 10 }, units: "physical", topInsetRemoved: 0 }));
      await eventually(() => expect(status()).toBe("No pictures were inserted; Couldn't drop \"big.png\": it is 21.0 MB; a dropped picture can be at most 20.0 MB; "
        + "Opened doc.chemdraft as legacy ChemDraft JSON"));
      expect(snapshot().title).toBe("Native document");
    });

    it("names the picture and the document of a mixed native drop whose tab changed while the picture was read", async () => {
      native.desktop = true;
      let release!: () => void;
      native.gate = new Promise<void>(resolve => { release = resolve; });
      native.files.set("/Users/me/Drops/slow.png", pngBytes());
      native.files.set("/Users/me/Drops/doc.chemdraft", new TextEncoder().encode(serializeDocument(createPhase4Document("Arrived"))));
      native.stat.mockImplementation(async path => ({ size: native.files.get(path)?.length ?? 0 }));
      await mount(createPhase4Document("First"), "windows");
      await eventually(() => expect(native.events.has(DOCUMENT_FILE_DROP_EVENT)).toBe(true));
      await command("document.new");
      await act(async () => { tabs()[0]!.click(); });
      await eventually(() => expect(snapshot().title).toBe("First"));
      await act(async () => native.events.get(DOCUMENT_FILE_DROP_EVENT)!({ paths: ["/Users/me/Drops/slow.png", "/Users/me/Drops/doc.chemdraft"],
        position: { x: 10, y: 10 }, units: "physical", topInsetRemoved: 0 }));
      await eventually(() => expect(status()).toBe("Reading the dropped picture…"));
      await act(async () => { tabs()[1]!.click(); });
      await eventually(() => expect(snapshot().title).not.toBe("First"));
      release();
      await eventually(() => expect(status()).toBe(`${leftTab.replace(/\.$/, "")}; Opened doc.chemdraft as legacy ChemDraft JSON`));
      await act(async () => { tabs()[0]!.click(); });
      await eventually(() => expect(snapshot().title).toBe("First"));
      expect(pictures()).toHaveLength(0);
    });

    it("refuses native web links and shortcuts by name without reading them, and still opens a dropped document", async () => {
      native.desktop = true;
      native.files.set("C:\\Drawings\\doc.chemdraft", new TextEncoder().encode(serializeDocument(createPhase4Document("Native document"))));
      native.stat.mockImplementation(async path => ({ size: native.files.get(path)?.length ?? 0 }));
      await mount(createPhase4Document("Desktop"), "windows");
      await eventually(() => expect(native.events.has(DOCUMENT_FILE_DROP_EVENT)).toBe(true));
      await act(async () => native.events.get(DOCUMENT_FILE_DROP_EVENT)!({ paths: ["C:\\Users\\me\\Desktop\\link.url", "C:\\Users\\me\\Desktop\\Drawing.lnk",
        "C:\\Drawings\\doc.chemdraft"], position: { x: 10, y: 10 }, units: "physical", topInsetRemoved: 0 }));
      await eventually(() => expect(status()).toBe([
        "Couldn't drop \"link.url\": it is a web link, not a picture or a drawing",
        "Couldn't drop \"Drawing.lnk\": it is a shortcut; drop the file it points to instead",
        "Opened doc.chemdraft as legacy ChemDraft JSON"
      ].join("; ")));
      expect(snapshot().title).toBe("Native document");
      expect(native.stat.mock.calls.map(([path]) => path).filter(path => !path.endsWith(".chemdraft"))).toEqual([]);
    });

    it("listens once per mount, so a page-size change leaves no gap, and a later drop uses the current page", async () => {
      native.desktop = true;
      const wide = createPhase4Document("Wide page");
      const page = wide.pages[0]!;
      wide.pages[0] = { ...page, width: page.width * 2, height: page.height * 2,
        ...page.layout ? { layout: { ...page.layout, widthPx: page.width * 2, heightPx: page.height * 2 } } : {} };
      native.files.set("/Users/me/Drawings/wide.chemdraft", new TextEncoder().encode(serializeDocument(wide)));
      native.files.set("/Users/me/Pictures/mol.png", pngBytes());
      native.stat.mockImplementation(async path => ({ size: native.files.get(path)?.length ?? 0 }));
      await mount(createPhase4Document("Desktop"), "linux");
      await eventually(() => expect(native.events.has(DOCUMENT_FILE_DROP_EVENT)).toBe(true));
      const dropSubscriptions = () => native.subscriptions.filter(entry => entry.endsWith(` ${DOCUMENT_FILE_DROP_EVENT}`));
      expect(dropSubscriptions()).toEqual([`listen ${DOCUMENT_FILE_DROP_EVENT}`]);
      // A document with another page size comes to the front: the drop handler is re-created.
      await act(async () => native.events.get(DOCUMENT_FILE_DROP_EVENT)!({ paths: ["/Users/me/Drawings/wide.chemdraft"],
        position: { x: 10, y: 10 }, units: "css", topInsetRemoved: 0 }));
      await eventually(() => expect(snapshot().title).toBe("Wide page"));
      expect(snapshot().pages[0]!.width).toBe(wide.pages[0]!.width);
      await settle();
      expect(dropSubscriptions()).toEqual([`listen ${DOCUMENT_FILE_DROP_EVENT}`]);
      stubLayout(0);
      // A drop without a position lands at the visible centre, put here past the original page's
      // right edge but inside the wide page: a handler kept from mount would clamp it to the old page.
      const centreX = page.width * 1.5;
      vi.spyOn(canvas(), "clientWidth", "get").mockReturnValue(centreX * 2);
      vi.spyOn(canvas(), "clientHeight", "get").mockReturnValue(page.height);
      await act(async () => native.events.get(DOCUMENT_FILE_DROP_EVENT)!({ paths: ["/Users/me/Pictures/mol.png"],
        position: null, units: "css", topInsetRemoved: 0 }));
      await eventually(() => expect(status()).toBe("Inserted picture mol.png"));
      expect(snapshot().title).toBe("Wide page");
      expect(pictures()).toHaveLength(1);
      expect(centre(pictures()[0]!)).toEqual({ x: centreX, y: page.height / 2 });
    });
  });
});

describe("picture stretch entry", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
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
    vi.unstubAllGlobals();
  });

  it("links X and Y for a picture, so the typed value is the scale applied", async () => {
    const base = createPhase4Document("Stretch");
    const picture = createImageGraphicObject({ mimeType: "image/png", dataBase64: picturePngBase64, center: { x: 300, y: 300 }, id: "image-1" });
    const drawing = { ...base, pages: [{ ...base.pages[0]!, objects: [picture] }], selection: { ...base.selection, objectIds: ["image-1"] } };
    await act(async () => root.render(<MainWindow initialDocument={drawing} initialActiveToolCommandId="tool.select"
      initialPaletteMode="hidden" initialRulersVisible={false} initialCrosshairsVisible={false} nativePalette={false} shortcutPlatform="macos" />));
    const handle = container.querySelector('[data-object-resize-corner]');
    expect(handle).not.toBeNull();
    await act(async () => handle!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    const x = container.querySelector<HTMLInputElement>('[aria-label="X stretch percent"]')!;
    const y = container.querySelector<HTMLInputElement>('[aria-label="Y stretch percent"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(x, "200");
      x.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // The readout and the entry agree with what the picture actually does.
    expect(y.value).toBe("200");
    const stretched = window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0]!.objects[0] as GraphicObject;
    expect([stretched.width, stretched.height]).toEqual([picture.width * 2, picture.height * 2]);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(y, "50");
      y.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(x.value).toBe("50");
    const shrunk = window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0]!.objects[0] as GraphicObject;
    expect([shrunk.width, shrunk.height]).toEqual([picture.width / 2, picture.height / 2]);
  });
});

describe("picture resize keeps the aspect ratio", () => {
  it("turns a Shift stretch of a picture into a uniform resize, leaving other graphics stretchable", () => {
    const document = createPhase4Document("Resize");
    const picture = { id: "image-1", type: "graphic", graphicKind: "image" } as unknown as ChemDraftDocument["pages"][number]["objects"][number];
    const rect = { id: "rect-1", type: "graphic", graphicKind: "rect" } as unknown as ChemDraftDocument["pages"][number]["objects"][number];
    const withObjects = { ...document, pages: [{ ...document.pages[0]!, objects: [picture, rect] }] };
    expect(objectResizeStretches({ startDocument: withObjects, objectId: "image-1", target: undefined }, true)).toBe(false);
    expect(objectResizeStretches({ startDocument: withObjects, objectId: "rect-1", target: undefined }, true)).toBe(true);
    expect(objectResizeStretches({ startDocument: withObjects, objectId: "image-1", target: undefined }, false)).toBe(false);
  });
});
