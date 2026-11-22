// @vitest-environment jsdom
import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { diffChemicalIdentity, snapshotChemicalIdentity, type MoleculeObject } from "@chemdraft/chem-core";
import { pngWithChemDraftSelection, type ClipboardReadPayload } from "@chemdraft/clipboard-adapter";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainWindow } from "./MainWindow";
import {
  CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, createPhase4Document, createSelectionClipboardPayload, insertNativeBracket,
  insertNativeSingleBondMolecule, insertNativeTextObject, selectDocumentObjects, serializeSelectionClipboardPayload,
} from "./documentWorkflow";
import { readClipboardPayload } from "./clipboard";
import { officePasteBackDecision } from "./officePasteBack";
import { DOM_COMMAND_EVENT } from "./window-manager";
import { MemoryStorage } from "./testSupport/memoryStorage";

const runtime = vi.hoisted(() => ({ desktop: false }));
vi.mock("./window-manager", async original => ({
  ...await original<typeof import("./window-manager")>(), isDesktopRuntime: () => runtime.desktop
}));
vi.mock("./clipboard", async original => ({ ...await original<typeof import("./clipboard")>(), readClipboardPayload: vi.fn() }));
vi.mock("./rdkitWasmLoader", () => ({ registerRdkitWasmLoader: vi.fn() }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function zip(entries: { name: string; data: Uint8Array | string; deflate?: boolean }[]): Uint8Array {
  const locals: Buffer[] = [];
  const records: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data);
    const name = Buffer.from(entry.name);
    const body = entry.deflate ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    record.writeUInt32LE(crc32(data), 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    records.push(record, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A 2×2 gray PNG with no carrier, standing in for Office's re-encoded rendition. */
function plainPng(): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2);
  header.writeUInt32BE(2, 4);
  header.set([8, 0, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 0x80, 0x80, 0, 0x80, 0x80]))), chunk("IEND", new Uint8Array())]));
}

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const rels = (targets: [type: string, target: string][]) => `<Relationships xmlns="${PKG}">${targets.map(([type, target], index) =>
  `<Relationship Id="rId${index + 1}" Type="${R}/${type}" Target="${target}"/>`).join("")}</Relationships>`;

function gvml(media: Uint8Array[]): Uint8Array {
  return zip([
    { name: "_rels/.rels", data: rels([["officeDocument", "clipboard/drawings/drawing1.xml"]]) },
    { name: "clipboard/drawings/drawing1.xml", data: "<a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"/>", deflate: true },
    { name: "clipboard/drawings/_rels/drawing1.xml.rels", data: rels(media.map((_, index) => ["image", `../media/image${index + 1}.png`])) },
    ...media.map((data, index) => ({ name: `clipboard/media/image${index + 1}.png`, data })),
  ]);
}

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const molecule = () => insertNativeSingleBondMolecule(createPhase4Document(), { x: 300, y: 300 });
const moleculeJson = () => serializeSelectionClipboardPayload(createSelectionClipboardPayload(molecule())!);
const carrier = (json: string) => pngWithChemDraftSelection(plainPng(), json);
const brokenJson = JSON.stringify({ kind: "chemdraft-selection", version: 1, selectionIds: ["m"],
  bounds: { x: 0, y: 0, width: 10, height: 10, centerX: 5, centerY: 5 },
  objects: [{ id: "m", type: "molecule", atoms: [{ id: "a1" }], bonds: [{ id: "b1", from: "a1", to: "missing" }] }] });

/** A bracketed molecule whose brackets also list a member the carrier lacks: placing it drops that membership. */
function bracketedWithGhostMember(): string {
  const drawn = insertNativeBracket(molecule(), { x: 250, y: 250 }, "square", { x: 350, y: 350 });
  const selected = selectDocumentObjects(drawn, drawn.pages[0]!.id, drawn.pages[0]!.objects.map(object => object.id));
  const raw = JSON.parse(serializeSelectionClipboardPayload(createSelectionClipboardPayload(selected)!)) as
    { objects: { type: string; containedObjectIds?: string[] }[] };
  for (const object of raw.objects) if (object.type === "bracket") object.containedObjectIds!.push("ghost");
  return JSON.stringify(raw);
}
const GHOST_WARNING = /Bracket \S+: membership ghost was dropped because the object was not copied\./;

const ARCHIVE_FORMAT = { macos: "com.microsoft.Art--GVML-ClipFormat", windows: "Art::GVML ClipFormat" } as const;

describe.each(["macos", "windows"] as const)("Office paste-back on %s", platform => {
  const format = ARCHIVE_FORMAT[platform];
  const officeClipboard = (archive: Uint8Array, png = plainPng()): ClipboardReadPayload => ({
    types: [format, platform === "windows" ? "PNG" : "public.png", platform === "windows" ? "image/emf" : "com.microsoft.emf"],
    textItems: [], officeItems: [{ type: format, bytesBase64: base64(archive) }],
    imageItems: [{ type: "image/png", bytesBase64: base64(png), pixelWidth: 2, pixelHeight: 2 }],
  });

  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    runtime.desktop = false;
    window.history.replaceState(null, "", "/?agentBridge=1");
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.mocked(readClipboardPayload).mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    runtime.desktop = false;
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });

  async function pasteInto(clipboard: ClipboardReadPayload) {
    vi.mocked(readClipboardPayload).mockResolvedValue(clipboard);
    await act(async () => root.render(<MainWindow initialDocument={createPhase4Document()} shortcutPlatform={platform}
      initialActiveToolCommandId="tool.select" initialCrosshairsVisible={false}
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette />));
    runtime.desktop = true;
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "clipboard.paste" } })); });
    await vi.waitFor(() => expect(readClipboardPayload).toHaveBeenCalled());
  }
  const objects = () => window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0]!.objects;
  const status = () => container.querySelector('[role="status"]')?.textContent ?? "";

  it("pastes the editable structure from the archive when the PNG rendition lost its carrier", async () => {
    await pasteInto(officeClipboard(gvml([carrier(moleculeJson())])));
    await vi.waitFor(() => expect(objects()).toHaveLength(1));
    const pasted = objects()[0] as MoleculeObject;
    const source = molecule().pages[0]!.objects[0] as MoleculeObject;
    expect(pasted.type).toBe("molecule");
    expect(diffChemicalIdentity(snapshotChemicalIdentity(source), snapshotChemicalIdentity(pasted)).verdict).not.toBe("changed");
    expect(status()).toContain("Pasted the ChemDraft structure from the copied picture.");
  });

  it("keeps ChemDraft's own selection ahead of the copied picture's carrier", async () => {
    const text = insertNativeTextObject(createPhase4Document(), { x: 50, y: 50 }, "From Word");
    const clipboard = officeClipboard(gvml([carrier(serializeSelectionClipboardPayload(createSelectionClipboardPayload(text)!))]));
    clipboard.types.unshift(CHEMDRAFT_SELECTION_CLIPBOARD_TYPE);
    clipboard.textItems.push({ type: CHEMDRAFT_SELECTION_CLIPBOARD_TYPE, text: moleculeJson() });
    await pasteInto(clipboard);
    await vi.waitFor(() => expect(objects()).toHaveLength(1));
    expect(objects()[0]!.type).toBe("molecule");
    expect(status()).toContain("Pasted ChemDraft selection");
  });

  it("pastes nothing and says why when the carrier fails the chemistry check", async () => {
    await pasteInto(officeClipboard(gvml([carrier(brokenJson)])));
    await vi.waitFor(() => expect(status()).toContain("Nothing was pasted."));
    expect(status()).toMatch(/^The copied structure failed the chemistry check: /);
    expect(objects()).toHaveLength(0);
  });

  it("still pastes a plain Office picture as a picture", async () => {
    await pasteInto(officeClipboard(gvml([plainPng()])));
    await vi.waitFor(() => expect(objects()).toHaveLength(1));
    expect(objects()[0]).toMatchObject({ type: "graphic", graphicKind: "image" });
  });

  it("lays out several copied structures as one paste", async () => {
    const read = officeClipboard(gvml([carrier(moleculeJson()), carrier(moleculeJson())]));
    const decision = await officePasteBackDecision(read, () => createPhase4Document());
    expect(decision).toMatchObject({ kind: "document", message: "Pasted 2 ChemDraft structures from the copied pictures." });
    expect(decision.kind === "document" && decision.document.pages[0]!.objects.map(object => object.type)).toEqual(["molecule", "molecule"]);
    const plain = await officePasteBackDecision({ ...read, officeItems: undefined }, () => createPhase4Document());
    expect(plain).toEqual({ kind: "none", details: [expect.stringContaining("EMF")] });
  });

  it("shows the warning when a copied structure's bracket data cannot be kept", async () => {
    await pasteInto(officeClipboard(gvml([carrier(bracketedWithGhostMember())])));
    await vi.waitFor(() => expect(objects().map(object => object.type).sort()).toEqual(["bracket", "bracket", "molecule"]));
    expect(status()).toContain("Pasted the ChemDraft structure from the copied picture.");
    expect(status()).toMatch(GHOST_WARNING);
  });

  it("shows the warning when one of several copied structures loses bracket data", async () => {
    const read = officeClipboard(gvml([carrier(moleculeJson()), carrier(bracketedWithGhostMember())]));
    const decision = await officePasteBackDecision(read, () => createPhase4Document());
    expect(decision.kind).toBe("document");
    if (decision.kind !== "document") return;
    expect(decision.document.pages[0]!.objects.map(object => object.type)).toEqual(["molecule", "molecule", "bracket", "bracket"]);
    expect(decision.message).toMatch(new RegExp(`^Pasted 2 ChemDraft structures from the copied pictures\\. ` +
      `Warning for the structure in copied picture 2: ${GHOST_WARNING.source} 1 more warning is in the log\\.$`));
    expect(decision.details).toEqual([expect.stringMatching(GHOST_WARNING), expect.stringMatching(GHOST_WARNING)]);
  });
});

describe("Paste of a ChemDraft embedded object copied in Word or PowerPoint on Windows", () => {
  const STABLE = "{CE37136C-13F0-4A5A-954F-0EF6DFE359D0}";
  const EQUATION = "{0002CE02-0000-0000-C000-000000000046}";
  const textCarrier = () => carrier(serializeSelectionClipboardPayload(createSelectionClipboardPayload(
    insertNativeTextObject(createPhase4Document(), { x: 50, y: 50 }, "From the picture"))!));
  /** What the native read returns once it has read the object's storage (`windows_clipboard.rs`). */
  const objectClipboard = (json: string, clsid = STABLE, archive?: Uint8Array, format = "Embedded Object"): ClipboardReadPayload => ({
    types: ["Object Descriptor", format, ...archive ? [ARCHIVE_FORMAT.windows] : [], "PNG", "image/emf"],
    textItems: [],
    officeItems: [{ type: format, clsid, bytesBase64: base64(new TextEncoder().encode(json)) },
      ...archive ? [{ type: ARCHIVE_FORMAT.windows, bytesBase64: base64(archive) }] : []],
    imageItems: [{ type: "image/png", bytesBase64: base64(plainPng()), pixelWidth: 2, pixelHeight: 2 }],
  });

  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    runtime.desktop = false;
    window.history.replaceState(null, "", "/?agentBridge=1");
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.mocked(readClipboardPayload).mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => {
    runtime.desktop = false;
    await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/"); delete window.__CHEMDRAFT_AGENT__;
  });

  async function pasteInto(clipboard: ClipboardReadPayload) {
    vi.mocked(readClipboardPayload).mockResolvedValue(clipboard);
    await act(async () => root.render(<MainWindow initialDocument={createPhase4Document()} shortcutPlatform="windows"
      initialActiveToolCommandId="tool.select" initialCrosshairsVisible={false}
      initialPaletteMode="hidden" initialRulersVisible={false} nativePalette />));
    runtime.desktop = true;
    await act(async () => { window.dispatchEvent(new CustomEvent(DOM_COMMAND_EVENT, { detail: { commandId: "clipboard.paste" } })); });
    await vi.waitFor(() => expect(readClipboardPayload).toHaveBeenCalled());
  }
  const objects = () => window.__CHEMDRAFT_AGENT__!.snapshot().document.pages[0]!.objects;
  const status = () => container.querySelector('[role="status"]')?.textContent ?? "";

  it.each(["Embedded Object", "Embed Source"])("pastes the identical editable structure from a ChemDraft %s", async format => {
    await pasteInto(objectClipboard(moleculeJson(), STABLE, undefined, format));
    await vi.waitFor(() => expect(objects()).toHaveLength(1));
    const pasted = objects()[0] as MoleculeObject;
    const source = molecule().pages[0]!.objects[0] as MoleculeObject;
    expect(pasted.type).toBe("molecule");
    expect(diffChemicalIdentity(snapshotChemicalIdentity(source), snapshotChemicalIdentity(pasted)).verdict).not.toBe("changed");
    expect(status()).toContain("Pasted the ChemDraft structure from the copied object.");
  });

  it("prefers the object over the picture archive's carrier", async () => {
    await pasteInto(objectClipboard(moleculeJson(), STABLE, gvml([textCarrier()])));
    await vi.waitFor(() => expect(objects()).toHaveLength(1));
    expect(objects()[0]!.type).toBe("molecule");
  });

  it("ignores another program's object and pastes from the picture archive", async () => {
    await pasteInto(objectClipboard(moleculeJson(), EQUATION, gvml([textCarrier()])));
    await vi.waitFor(() => expect(objects()).toHaveLength(1));
    expect(objects()[0]!.type).toBe("text");
    expect(status()).toContain("Pasted the ChemDraft structure from the copied picture.");
  });

  it("pastes nothing and says why when the object's drawing fails the chemistry check", async () => {
    await pasteInto(objectClipboard(brokenJson));
    await vi.waitFor(() => expect(status()).toContain("Nothing was pasted."));
    expect(status()).toMatch(/^The copied structure failed the chemistry check: /);
    expect(objects()).toHaveLength(0);
  });

  it("refuses an object from a newer ChemDraft with the carrier's words", async () => {
    const decision = await officePasteBackDecision(objectClipboard(JSON.stringify({ ...JSON.parse(moleculeJson()), version: 2 })),
      () => createPhase4Document());
    expect(decision).toEqual({ kind: "refused", details: [expect.any(String)],
      message: "The copied structure was made by a newer or unknown ChemDraft (data version 2). Nothing was pasted." });
  });
});
