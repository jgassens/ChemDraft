import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEmptyDocument } from "@chemdraft/chem-core";
import { runCli } from "./cli";
import { loadAgentDocument } from "./documentInput";
import { parseNamedSmilesJob, readBatchFile } from "./output";
import { readTrustedPlugins } from "./pluginTrust";
import { decodeUserText } from "./textInput";

const encodings = [
  { name: "UTF-8", encode: (text: string) => Buffer.from(text) },
  { name: "UTF-8 BOM", encode: (text: string) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]) },
  { name: "UTF-8 CRLF", encode: (text: string) => Buffer.from(text.replace(/\n/g, "\r\n")) },
  { name: "UTF-16LE BOM", encode: (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\n/g, "\r\n"), "utf16le")]) },
  { name: "UTF-16BE BOM", encode: (text: string) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]) }
];
let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "chemdraft-encoding-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe("user text file encodings", () => {
  it.each(encodings)("accepts $name batches through CLI dispatch with JSON Lines", async ({ name, encode }) => {
    const path = join(directory, `${name}.json`);
    const jobs = [{ name: "ethanol", smiles: "CCO" }, { name: "water", smiles: "O" }];
    await writeFile(path, encode(JSON.stringify(jobs, null, 2)));
    expect(await readBatchFile(path, parseNamedSmilesJob)).toEqual(jobs);
    const stdout: string[] = [], stderr: string[] = [];
    const code = await runCli(["stereo", "--batch", path], {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line)
    });
    expect(code, stderr.join("\n")).toBe(0);
    expect(stdout.map((line) => JSON.parse(line))).toMatchObject([
      { name: "ethanol", ok: true }, { name: "water", ok: true }
    ]);
  }, 60_000);

  it.each(encodings)("accepts $name native documents and trust files", async ({ name, encode }) => {
    const document = createEmptyDocument({ title: "éthanol 🧪" });
    const path = join(directory, `${name}-document.json`);
    await writeFile(path, encode(JSON.stringify(document, null, 2)));
    expect((await loadAgentDocument(path)).document).toEqual(document);
    const trustPath = join(directory, `${name}-trust.json`);
    const entries = [{ id: "org.chemdraft.nmr.predictor", dir: directory }];
    await writeFile(trustPath, encode(JSON.stringify({ version: 1, trustedPlugins: entries }, null, 2)));
    expect(readTrustedPlugins(trustPath)).toEqual(entries);
  });

  it.each([
    { encoding: "UTF-16LE", bytes: Buffer.from([0xff, 0xfe, 0x5b]) },
    { encoding: "UTF-16BE", bytes: Buffer.from([0xfe, 0xff, 0x00]) }
  ])("refuses malformed $encoding with an encoding-specific usage error", async ({ encoding, bytes }) => {
    const path = join(directory, `${encoding}-invalid.json`);
    await writeFile(path, bytes);
    const stdout: string[] = [], stderr: string[] = [];
    expect(await runCli(["stereo", "--batch", path], {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line)
    })).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join("\n")).toContain(`Invalid ${encoding} text`);
    expect(stderr.join("\n")).toContain("Set-Content -Encoding UTF8");
    await expect(loadAgentDocument(path)).rejects.toThrow(`Invalid ${encoding} text`);
    expect(() => readTrustedPlugins(path)).toThrow(`Invalid ${encoding} text`);
  });

  it("preserves BOM-free UTF-8 and strips only the leading BOM", () => {
    const text = "é 🧪\r\nembedded \ufeff";
    expect(decodeUserText(Buffer.from(text))).toBe(text);
    expect(decodeUserText(Buffer.from("\ufeff\ufeff[]"))).toBe("\ufeff[]");
  });
});
