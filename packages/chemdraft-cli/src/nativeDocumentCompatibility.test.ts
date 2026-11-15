import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyDocument, serializeDocument } from "@chemdraft/chem-core";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { runRenderDocumentCommand } from "./commands/renderDocument";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe("native document compatibility JSON results", () => {
  it.each(["json", "envelope"])("reports named warnings and minimum and round-trips a future %s file", async inputFormat => {
    const directory = await mkdtemp(join(tmpdir(), "chemdraft-forward-")); directories.push(directory);
    const raw = { ...createEmptyDocument(), formatVersion: "1.10.0", minAppVersion: "1.10.2",
      conditionsLabel: { text: "future conditions" }, styles: { drawing: { stylePresetId: "future-preset" } } };
    const json = JSON.stringify(raw);
    const input = join(directory, "input.chemdraft"), output = join(directory, "output.chemdraft");
    const contents = inputFormat === "json" ? json
      : (await import("@chemdraft/cdx-compat")).exportDocumentToCdxml(openChemDraftPayload(json).document!).contents;
    await writeFile(input, contents);
    const stdout: string[] = [], stderr: string[] = [];
    const code = await runRenderDocumentCommand(["--document", input, "--out", output], {
      stdout: line => stdout.push(line), stderr: line => stderr.push(line)
    });
    expect(code).toBe(0);
    expect(stdout).toHaveLength(1);
    const result = JSON.parse(stdout[0]!);
    expect(result).toMatchObject({ ok: true, minAppVersion: "1.10.2" });
    expect(result.documentWarnings).toHaveLength(2);
    expect(result.documentWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "NATIVE_UNKNOWN_FIELD_PRESERVED", path: ["conditionsLabel"],
        originalValue: { text: "future conditions" } }),
      expect.objectContaining({ code: "NATIVE_STYLE_PRESET_FALLBACK", path: ["styles", "drawing", "stylePresetId"],
        originalValue: "future-preset" })
    ]));
    expect(result.warnings).toEqual(expect.arrayContaining(result.documentWarnings.map((warning: { message: string }) => warning.message)));
    const reopened = openChemDraftPayload(await readFile(output, "utf8"));
    const saved = JSON.parse(serializeDocument(reopened.document!));
    expect(saved.conditionsLabel).toEqual(raw.conditionsLabel);
    expect(saved.styles.drawing.stylePresetId).toBe("future-preset");
    expect(saved.minAppVersion).toBe("1.10.2");
    expect(stderr.join("\n")).not.toContain("This file was made with");
  });

  it.each([undefined, "1.1.1", "1.2.0"])("reports a minimum and no warnings for known minimum %s", async minimum => {
    const directory = await mkdtemp(join(tmpdir(), "chemdraft-forward-")); directories.push(directory);
    const input = join(directory, "input.json"), output = join(directory, "output.svg");
    await writeFile(input, JSON.stringify({ ...createEmptyDocument(), minAppVersion: minimum }));
    const stdout: string[] = [];
    expect(await runRenderDocumentCommand(["--document", input, "--out", output], {
      stdout: line => stdout.push(line), stderr: () => {}
    })).toBe(0);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ minAppVersion: minimum ?? "1.1.1", documentWarnings: [], warnings: [] });
  });

  it("keeps read warnings and minimum in the JSON failure when the output cannot be written", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chemdraft-forward-")); directories.push(directory);
    const input = join(directory, "input.json"), output = join(directory, "is-a-directory.chemdraft");
    await mkdir(output);
    await writeFile(input, JSON.stringify({ ...createEmptyDocument(), minAppVersion: "1.10.2",
      conditionsLabel: { text: "preserved" } }));
    const stdout: string[] = [];
    expect(await runRenderDocumentCommand(["--document", input, "--out", output], {
      stdout: line => stdout.push(line), stderr: () => {}
    })).toBe(1);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: false, minAppVersion: "1.10.2",
      documentWarnings: [expect.objectContaining({ code: "NATIVE_UNKNOWN_FIELD_PRESERVED", path: ["conditionsLabel"] })],
      error: expect.any(String) });
  });
});
