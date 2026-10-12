import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CliUsageError, parseNamedSmilesJob, readBatchFile } from "./output";
import { decodeUserText } from "./textInput";

describe("shared text input decoder", () => {
  it.each([
    { name: "UTF-8 BOM", bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('[{"name":"ethanol","smiles":"CCO"}]')]) },
    { name: "CRLF", bytes: Buffer.from('[\r\n{"name":"ethanol","smiles":"CCO"}\r\n]\r\n') },
    { name: "UTF-16LE BOM", bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[\r\n{"name":"ethanol","smiles":"CCO"}\r\n]', "utf16le")]) }
  ])("reads $name batches", async ({ bytes }) => {
    const directory = await mkdtemp(join(tmpdir(), "chemdraft-bom-batch-"));
    try {
      const path = join(directory, "jobs.json");
      await writeFile(path, bytes);
      expect(await readBatchFile(path, parseNamedSmilesJob)).toEqual([{ name: "ethanol", smiles: "CCO" }]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves Unicode, CRLF, and embedded BOMs", () => {
    const text = "é 🧪\r\nembedded \ufeff";
    expect(decodeUserText(Buffer.from(text))).toBe(text);
    expect(decodeUserText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]))).toBe(text);
    expect(decodeUserText(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]))).toBe(text);
    expect(decodeUserText(Buffer.from("\ufeff\ufeff[]"))).toBe("\ufeff[]");
  });

  it("wraps malformed UTF-16 as a batch usage error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chemdraft-invalid-encoding-"));
    try {
      const path = join(directory, "jobs.json");
      await writeFile(path, Buffer.from([0xff, 0xfe, 0x5b]));
      await expect(readBatchFile(path, parseNamedSmilesJob)).rejects.toBeInstanceOf(CliUsageError);
      await expect(readBatchFile(path, parseNamedSmilesJob)).rejects.toThrow("Invalid UTF-16LE text. Save the file as UTF-8");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
