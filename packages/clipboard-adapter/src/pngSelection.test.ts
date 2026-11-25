import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { Resvg } from "@resvg/resvg-js";
import { describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_OBJECT_BYTES, readPngInfo } from "@chemdraft/chem-core";
import { CHEMDRAFT_PNG_SELECTION_KEYWORD, pngWithChemDraftSelection, readChemDraftSelectionFromPng } from "./index";

const keyword = CHEMDRAFT_PNG_SELECTION_KEYWORD;

function chunks(png: Uint8Array) {
  const buffer = Buffer.from(png);
  const result: { type: string; data: Buffer; bytes: Buffer }[] = [];
  for (let offset = 8; offset < buffer.length;) {
    const end = offset + buffer.readUInt32BE(offset) + 12;
    result.push({ type: buffer.toString("ascii", offset + 4, offset + 8),
      data: buffer.subarray(offset + 8, end - 4), bytes: buffer.subarray(offset, end) });
    offset = end;
  }
  return result;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4, "ascii");
  chunk.set(data, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function insertChunks(png: Uint8Array, ...extra: Buffer[]): Buffer {
  return Buffer.concat([png.subarray(0, -12), ...extra, png.subarray(-12)]);
}

describe("PNG selection carrier", () => {
  const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><path d="M1 1L19 9" stroke="black"/></svg>').render().asPng();
  it("embeds exact UTF-8 JSON in a standard CRC-checked iTXt chunk, preserving every image chunk", () => {
    const json = JSON.stringify({ kind: "chemdraft-selection", version: 1, text: "Δ Na⁺ 日本語" });
    const result = pngWithChemDraftSelection(png, json);
    const output = chunks(result);
    const metadata = output.find(chunk => chunk.type === "iTXt")!;
    expect(metadata.data.toString("utf8")).toBe(`${CHEMDRAFT_PNG_SELECTION_KEYWORD}\0\0\0\0\0${json}`);
    expect(metadata.bytes.readUInt32BE(metadata.bytes.length - 4)).toBe(crc32(metadata.bytes.subarray(4, -4)));
    expect(output.filter(chunk => chunk !== metadata)).toEqual(chunks(png));
    expect(output.at(-2)).toBe(metadata);
    expect(readPngInfo(result)).toEqual(readPngInfo(png));
    const replaced = chunks(pngWithChemDraftSelection(result, "{}"));
    expect(replaced.filter(chunk => chunk.type === "iTXt")).toHaveLength(1);
    expect(replaced.find(chunk => chunk.type === "iTXt")!.data.toString().endsWith("{}")).toBe(true);
  });
  it("refuses malformed PNG and over-limit carriers before writing the clipboard", () => {
    expect(() => pngWithChemDraftSelection(png.subarray(0, 33), "{}")).toThrow("PNG failed validation");
    expect(() => pngWithChemDraftSelection(png, "x".repeat(MAX_IMAGE_OBJECT_BYTES))).toThrow("25 MB picture limit");
  });

  it("reads the writer's byte-exact JSON, including whitespace and non-ASCII text", async () => {
    const json = '{\n  "kind": "chemdraft-selection", "text": "Δ Na⁺ 日本語"\n}\n';
    const bytes = pngWithChemDraftSelection(png, json);
    expect(await readChemDraftSelectionFromPng(bytes)).toEqual({ kind: "found", chunk: "iTXt", json });
  });

  const fixtureDir = new URL("../../fixtures/office/carriers/", import.meta.url);
  const fixtureManifest: { file: string; sha256: string }[] = JSON.parse(readFileSync(new URL("manifest.json", fixtureDir), "utf8"));
  const fixtureJson = readFileSync(new URL("../sample-envelope.json", fixtureDir), "utf8");

  it.each(fixtureManifest.filter(({ file }) => file.endsWith(".png")))("recovers the compressed payload from $file with the production keyword", async ({ file, sha256 }) => {
    const fixture = readFileSync(new URL(file, fixtureDir));
    expect(createHash("sha256").update(fixture).digest("hex")).toBe(sha256);
    expect(await readChemDraftSelectionFromPng(fixture)).toEqual({ kind: "absent" });

    // The spike used the test keyword "chemdraft". Replace only that keyword and recompute
    // its CRC, keeping the compressed selection and every other PNG chunk intact.
    let carrierType: string | undefined;
    const rewritten = chunks(fixture).map(({ type, bytes, data }) => {
      const spikeKeyword = Buffer.from("chemdraft\0");
      if (!data.subarray(0, spikeKeyword.length).equals(spikeKeyword)) return bytes;
      carrierType = type;
      return pngChunk(type, Buffer.concat([Buffer.from(`${keyword}\0`), data.subarray(spikeKeyword.length)]));
    });
    expect(carrierType).toBe(file === "png-itxt.png" ? "iTXt" : "zTXt");
    const result = await readChemDraftSelectionFromPng(Buffer.concat([fixture.subarray(0, 8), ...rewritten]));
    expect(result).toEqual({ kind: "found", chunk: carrierType, json: fixtureJson });
  });

  it("ignores padding and even chunk-shaped bytes after IEND", async () => {
    const result = pngWithChemDraftSelection(png, "{}");
    const carrier = chunks(result).at(-2)!.bytes;
    const padded = Buffer.concat([result, Buffer.of(0), carrier]);
    expect(await readChemDraftSelectionFromPng(padded)).toEqual({ kind: "found", chunk: "iTXt", json: "{}" });
  });

  it("rejects a CRC mismatch on image data even when the carrier itself is intact", async () => {
    const result = Buffer.from(pngWithChemDraftSelection(png, "{}"));
    const idat = result.indexOf("IDAT", 8, "ascii");
    result[idat + 4] ^= 1;
    expect(await readChemDraftSelectionFromPng(result)).toEqual({ kind: "invalid", reason: expect.stringMatching(/IDAT CRC/) });
  });

  it("reports absent for a valid PNG and a look-alike keyword", async () => {
    expect(await readChemDraftSelectionFromPng(png)).toEqual({ kind: "absent" });
    const other = pngChunk("iTXt", Buffer.from(`${keyword}-other\0\0\0\0\0{}`));
    expect(await readChemDraftSelectionFromPng(insertChunks(png, other))).toEqual({ kind: "absent" });
  });

  it("rejects duplicate carriers across chunk types", async () => {
    const withCarrier = pngWithChemDraftSelection(png, "{}");
    const data = Buffer.concat([Buffer.from(`${keyword}\0\0`), deflateSync("{}")]);
    const duplicate = pngChunk("zTXt", data);
    expect(await readChemDraftSelectionFromPng(insertChunks(withCarrier, duplicate))).toEqual({
      kind: "invalid", reason: expect.stringMatching(/duplicate/i),
    });
  });

  it.each([
    ["iTXt", Buffer.from(`${keyword}\0\x02\0\0\0{}`)],
    ["iTXt", Buffer.from(`${keyword}\0\0\0missing terminators`)],
    ["zTXt", Buffer.from(`${keyword}\0\x01`)],
    ["zTXt", Buffer.concat([Buffer.from(`${keyword}\0\0`), Buffer.of(1, 2, 3)])],
    ["zTXt", Buffer.concat([Buffer.from(`${keyword}\0\0`), deflateSync(Buffer.of(0xff))])],
  ] as const)("rejects malformed %s carrier data", async (type, data) => {
    expect(await readChemDraftSelectionFromPng(insertChunks(png, pngChunk(type, data)))).toMatchObject({ kind: "invalid" });
  });

  it.each([
    ["missing DecompressionStream", undefined, /lacks DecompressionStream/],
    ["unsupported format", class { constructor() { throw new TypeError("Unsupported format"); } }, /does not support.*deflate/],
  ] as const)("reports %s as unsupported only for compressed carriers", async (_label, decoder, reason) => {
    const compressed = pngChunk("zTXt", Buffer.concat([Buffer.from(`${keyword}\0\0`), deflateSync("{}")]));
    vi.stubGlobal("DecompressionStream", decoder);
    try {
      expect(await readChemDraftSelectionFromPng(insertChunks(png, compressed))).toEqual({
        kind: "unsupported", reason: expect.stringMatching(reason),
      });
      expect(await readChemDraftSelectionFromPng(pngWithChemDraftSelection(png, "{}"))).toEqual({
        kind: "found", chunk: "iTXt", json: "{}",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("enforces the 25 MB limit on the input and the inflated carrier independently", async () => {
    expect(await readChemDraftSelectionFromPng(new Uint8Array(MAX_IMAGE_OBJECT_BYTES + 1))).toEqual({
      kind: "invalid", reason: expect.stringMatching(/25 MB picture limit/),
    });
    const compressed = deflateSync(Buffer.alloc(MAX_IMAGE_OBJECT_BYTES + 1, 0x30));
    const bomb = pngChunk("zTXt", Buffer.concat([Buffer.from(`${keyword}\0\0`), compressed]));
    expect(await readChemDraftSelectionFromPng(insertChunks(png, bomb))).toEqual({
      kind: "invalid", reason: expect.stringMatching(/25 MB inflated limit/),
    });
  });
});
