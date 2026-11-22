import { describe, expect, it } from "vitest";
import {
  CHEMDRAFT_OLE_CLASSES, isChemDraftOleClassId, isChemDraftOleProgId, readChemDraftOleObject,
} from "./index";
import { writeTestCompoundFile } from "./oleObject.testUtils";

const STABLE = "{CE37136C-13F0-4A5A-954F-0EF6DFE359D0}";
const DEV = "{8D23DEDA-8B23-4D62-BEEC-6C6168D48BB4}";
const EQUATION = "{0002CE02-0000-0000-C000-000000000046}";
const MB = 1024 * 1024;
const json = JSON.stringify({ kind: "chemdraft-selection", version: 1, objects: [], label: "β-D-glucose, café" });
// The streams ChemDraft's server writes, plus a preview, around the drawing.
const objectStreams = (document: string | Uint8Array) => [
  { name: "\u0001CompObj", data: new Uint8Array(40) },
  { name: "\u0001Ole", data: new Uint8Array(20) },
  { name: "ChemDraftDocument", data: document },
  { name: "ChemDraftPreview", data: new Uint8Array(5000).fill(7) },
];

describe("ChemDraft's OLE classes", () => {
  it("knows the stable and dev classes and ProgIDs, and nothing else", () => {
    expect(CHEMDRAFT_OLE_CLASSES.map((known) => known.clsid)).toEqual([STABLE, DEV]);
    for (const clsid of [STABLE, DEV, STABLE.toLowerCase(), DEV.slice(1, -1)]) expect(isChemDraftOleClassId(clsid)).toBe(true);
    for (const clsid of [EQUATION, "{00000000-0000-0000-0000-000000000000}", "{9555AC51-4097-416B-8588-E2BA35E8AF94}", `{${STABLE}}`, "", undefined]) {
      expect(isChemDraftOleClassId(clsid)).toBe(false);
    }
    for (const progId of ["ChemDraft.Structure.1", "chemdraft.structure", "ChemDraft.DevStructure.1", "ChemDraft.DevStructure"]) {
      expect(isChemDraftOleProgId(progId)).toBe(true);
    }
    for (const progId of ["ChemDraft.Structure.Probe", "Equation.3", "ChemDraw.Document.6.0", "", undefined]) expect(isChemDraftOleProgId(progId)).toBe(false);
  });
});

describe("readChemDraftOleObject", () => {
  it("reads the drawing from the mini stream and from regular sectors", () => {
    expect(readChemDraftOleObject(writeTestCompoundFile(STABLE, objectStreams(json)).bytes, MB))
      .toEqual({ kind: "chemdraft", clsid: STABLE, json });
    const large = JSON.stringify({ kind: "chemdraft-selection", version: 1, objects: [], label: "x".repeat(9000) });
    expect(readChemDraftOleObject(writeTestCompoundFile(DEV, objectStreams(large)).bytes, MB))
      .toEqual({ kind: "chemdraft", clsid: DEV, json: large });
  });

  it("leaves another program's object, or one without a class, unread", () => {
    for (const clsid of [EQUATION, "{00000000-0000-0000-0000-000000000000}"]) {
      expect(readChemDraftOleObject(writeTestCompoundFile(clsid, objectStreams(json)).bytes, MB)).toEqual({ kind: "other", clsid });
    }
  });

  it("reports a drawing over the limit without reading it", () => {
    const read = readChemDraftOleObject(writeTestCompoundFile(STABLE, objectStreams(json)).bytes, 16);
    expect(read).toEqual({ kind: "too-large", clsid: STABLE, documentBytes: new TextEncoder().encode(json).length });
  });

  it("says what is wrong with a ChemDraft object that has no usable drawing", () => {
    const missing = writeTestCompoundFile(STABLE, objectStreams(json).filter((stream) => stream.name !== "ChemDraftDocument"));
    expect(readChemDraftOleObject(missing.bytes, MB)).toEqual({ kind: "invalid", clsid: STABLE, reason: "the ChemDraft object has no ChemDraftDocument stream" });
    const binary = writeTestCompoundFile(STABLE, objectStreams(new Uint8Array([0x7b, 0xff, 0x7d])));
    expect(readChemDraftOleObject(binary.bytes, MB)).toMatchObject({ kind: "invalid", reason: "ChemDraftDocument is not UTF-8 text" });
  });

  it("refuses files that are not compound files, or are cut short", () => {
    const whole = writeTestCompoundFile(STABLE, objectStreams(json)).bytes;
    for (const bytes of [new Uint8Array(0), new Uint8Array(1024), new TextEncoder().encode("%PDF-1.7".padEnd(600, " "))]) {
      expect(readChemDraftOleObject(bytes, MB)).toEqual({ kind: "invalid", reason: "the embedded object is not an OLE compound file" });
    }
    expect(readChemDraftOleObject(whole.subarray(0, 1536), MB)).toMatchObject({ kind: "invalid" });
    const wrongVersion = whole.slice();
    wrongVersion[26] = 5;
    expect(readChemDraftOleObject(wrongVersion, MB)).toEqual({ kind: "invalid", reason: "the embedded object uses an unsupported compound file layout" });
    expect(readChemDraftOleObject(new Uint8Array(50 * MB + 1), MB)).toMatchObject({ kind: "invalid", reason: "the embedded object is larger than the 50 MB limit" });
  });

  it("refuses looping sector chains, mini sector chains and directory trees", () => {
    const large = JSON.stringify({ kind: "chemdraft-selection", version: 1, objects: [], label: "x".repeat(9000) });
    const regular = writeTestCompoundFile(STABLE, objectStreams(large));
    const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const start = regular.starts[2]!;
    view(regular.bytes).setUint32(regular.fatOffset + 4 * (start + 1), start, true);
    expect(readChemDraftOleObject(regular.bytes, MB)).toMatchObject({ kind: "invalid", reason: "the ChemDraftDocument sector chain is damaged" });

    const mini = writeTestCompoundFile(STABLE, objectStreams(json));
    const miniStart = mini.starts[2]!;
    view(mini.bytes).setUint32(mini.miniFatOffset + 4 * miniStart, miniStart, true);
    expect(readChemDraftOleObject(mini.bytes, MB)).toMatchObject({ kind: "invalid", reason: "the ChemDraftDocument mini sector chain is damaged" });

    const tree = writeTestCompoundFile(STABLE, objectStreams(json));
    view(tree.bytes).setUint32(tree.directoryOffset + 128 * 2 + 72, 1, true); // entry 2's right sibling is entry 1
    expect(readChemDraftOleObject(tree.bytes, MB)).toEqual({ kind: "invalid", clsid: STABLE, reason: "the directory is damaged" });

    const outside = writeTestCompoundFile(STABLE, objectStreams(json));
    view(outside.bytes).setUint32(outside.directoryOffset + 128 + 72, 9999, true);
    expect(readChemDraftOleObject(outside.bytes, MB)).toMatchObject({ kind: "invalid", reason: "a directory entry points past the directory" });
  });

  it("reads version 4 files (4096-byte sectors) and FAT sectors listed in a DIFAT chain", () => {
    const large = JSON.stringify({ kind: "chemdraft-selection", version: 1, objects: [], label: "x".repeat(9000) });
    for (const document of [json, large]) {
      const v4 = writeTestCompoundFile(STABLE, objectStreams(document), { version: 4 });
      expect(v4.sectorBytes).toBe(4096);
      expect(readChemDraftOleObject(v4.bytes, MB)).toEqual({ kind: "chemdraft", clsid: STABLE, json: document });
    }
    // 240 FAT sectors: 109 in the header, the rest in two DIFAT sectors (127 slots each).
    const chained = writeTestCompoundFile(STABLE, objectStreams(large), { minFatSectors: 240 });
    expect(chained.difatSectors).toHaveLength(2);
    expect(readChemDraftOleObject(chained.bytes, MB)).toEqual({ kind: "chemdraft", clsid: STABLE, json: large });
    const v4Chained = writeTestCompoundFile(STABLE, objectStreams(large), { version: 4, minFatSectors: 110 });
    expect(v4Chained.difatSectors).toHaveLength(1);
    expect(readChemDraftOleObject(v4Chained.bytes, MB)).toEqual({ kind: "chemdraft", clsid: STABLE, json: large });
  });

  it("refuses a looping DIFAT chain", () => {
    const looped = writeTestCompoundFile(STABLE, objectStreams(json), { minFatSectors: 240 });
    const [first, second] = looped.difatSectors as [number, number];
    const view = new DataView(looped.bytes.buffer);
    view.setUint32((second + 1) * 512 + 508, first, true); // the second DIFAT sector points back to the first
    view.setUint32(72, 5, true);
    expect(readChemDraftOleObject(looped.bytes, MB)).toEqual({ kind: "invalid", reason: "the sector tables are damaged" });
  });

  it("walks a crafted DIFAT chain as long as the file allows in linear time", () => {
    // 50 MiB of version 3 sectors, nearly all of them one DIFAT chain of empty slots.
    const bytes = new Uint8Array(50 * MB).fill(0xff);
    const view = new DataView(bytes.buffer);
    bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    bytes.fill(0, 8, 76);
    view.setUint16(24, 0x3e, true);
    view.setUint16(26, 3, true);
    view.setUint16(28, 0xfffe, true);
    view.setUint16(30, 9, true);
    view.setUint16(32, 6, true);
    view.setUint32(44, 1, true); // one FAT sector, sector 0
    view.setUint32(48, 0xfffffffe, true);
    view.setUint32(56, 4096, true);
    view.setUint32(60, 0xfffffffe, true);
    const sectorCount = bytes.length / 512 - 1;
    view.setUint32(68, 1, true);
    view.setUint32(72, sectorCount - 1, true);
    view.setUint32(76, 0, true);
    for (let id = 1; id < sectorCount; id++) view.setUint32((id + 1) * 512 + 508, id + 1 < sectorCount ? id + 1 : 0xfffffffe, true);
    view.setUint32(512, 0xfffffffd, true);
    const started = performance.now();
    expect(readChemDraftOleObject(bytes, MB)).toEqual({ kind: "invalid", reason: "the sector tables are damaged" });
    // About 100,000 DIFAT sectors: a quadratic membership check took over a second here, a Set about 0.1 s.
    expect(performance.now() - started).toBeLessThan(750);
  });
});
