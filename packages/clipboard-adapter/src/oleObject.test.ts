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
});
