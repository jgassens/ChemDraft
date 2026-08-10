/**
 * Gate 4 — a bundled dataset may not hide under the code licence (AGENTS.md §8c).
 *
 * The failure this prevents is invisible until someone else discovers it: a plugin whose code is MIT
 * shipping a database with share-alike and attribution obligations the MIT grant never reached, in a
 * zip labelled "MIT". The nmrshiftdb2 corpus is the live instance.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PluginGateError, assertBundledDataLicensed, findBundledDataPaths } from "./gates";

const roots: string[] = [];

function plugin(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "chemdraft-datalicense-"));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

const gateError = (message: string): PluginGateError => new PluginGateError(message);

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("bundled-data detection", () => {
  it("ignores a plugin that ships only code and config", () => {
    const root = plugin({
      "package.json": JSON.stringify({ name: "p", license: "MIT" }),
      "src/index.ts": "export const a = 1;",
      "src/settings.json": "{}",
      "README.md": "# p"
    });
    // `.json` deliberately does not count: every plugin has config, and a gate that fired on all of
    // them would be switched off within a week.
    expect(findBundledDataPaths(root)).toEqual([]);
    expect(() => assertBundledDataLicensed(root, gateError)).not.toThrow();
  });

  it("sees anything inside a data directory, whatever its extension", () => {
    const root = plugin({
      "package.json": JSON.stringify({ name: "p", license: "MIT" }),
      "data/shifts.json": "[]",
      "src/index.ts": "export const a = 1;"
    });
    expect(findBundledDataPaths(root)).toEqual(["data/shifts.json"]);
  });

  it("sees a dataset extension anywhere in the tree", () => {
    const root = plugin({
      "package.json": JSON.stringify({ name: "p", license: "MIT" }),
      "src/corpus.sqlite": "binary",
      "src/index.ts": "export const a = 1;"
    });
    expect(findBundledDataPaths(root)).toEqual(["src/corpus.sqlite"]);
  });

  it("does not count build output or dependencies as shipped data", () => {
    const root = plugin({
      "package.json": JSON.stringify({ name: "p", license: "MIT" }),
      "dist/data/bundled.csv": "a,b",
      "node_modules/dep/data/x.csv": "a,b",
      "src/index.ts": "export const a = 1;"
    });
    expect(findBundledDataPaths(root)).toEqual([]);
  });
});

describe("the gate", () => {
  it("refuses a package that ships data while claiming only a code licence", () => {
    const root = plugin({
      "package.json": JSON.stringify({ name: "p", license: "MIT" }),
      "data/nmrshiftdb2-derived.csv": "shift,element"
    });
    expect(() => assertBundledDataLicensed(root, gateError)).toThrow(/declares no "dataLicenses"/);
    expect(() => assertBundledDataLicensed(root, gateError)).toThrow(/nmrshiftdb2-derived\.csv/);
  });

  it("accepts a package that declares its dataset's terms separately", () => {
    const root = plugin({
      "package.json": JSON.stringify({
        name: "p",
        license: "MIT",
        dataLicenses: [
          {
            name: "nmrshiftdb2-derived 13C shift corpus",
            license: "nmrshiftdb2 Database License (ODbL-derived; share-alike + attribution)",
            noticeFile: "data/NOTICE-nmrshiftdb2.txt"
          }
        ]
      }),
      // The notice this manifest promises. It was absent, so a fixture named "accepts a package" was
      // describing one whose attribution file ships nowhere — the case the gate now rejects.
      "data/NOTICE-nmrshiftdb2.txt": "nmrshiftdb2 Database License. Attribution: nmrshiftdb2 contributors.",
      "data/nmrshiftdb2-derived.csv": "shift,element"
    });
    expect(() => assertBundledDataLicensed(root, gateError)).not.toThrow();
  });

  it("refuses a declaration whose noticeFile is not in the package", () => {
    // A promise the distribution cannot keep: the manifest says "the terms are in this file" and the
    // file ships nowhere, so the attribution never reaches anyone the plugin is given to. Nothing
    // checked it — this gate is the only code that reads the field at all.
    const root = plugin({
      "package.json": JSON.stringify({
        name: "p",
        license: "MIT",
        dataLicenses: [
          { name: "some corpus", license: "CC BY 4.0", noticeFile: "data/NOTICE-missing.txt" }
        ]
      }),
      "data/corpus.csv": "a,b"
    });
    expect(() => assertBundledDataLicensed(root, gateError)).toThrow(/noticeFile that is not in the package/);
  });

  it("does not flag source that happens to live under a data directory", () => {
    // `src/data/parser.ts` is code. Flagging it as a shipped dataset is the false positive that
    // teaches a reader to stop believing the gate.
    const root = plugin({
      "package.json": JSON.stringify({ name: "p", license: "MIT" }),
      "src/data/parser.ts": "export const parse = () => undefined;"
    });
    expect(() => assertBundledDataLicensed(root, gateError)).not.toThrow();
  });

  it("still catches a corpus under the spellings the list was missing", () => {
    // "db" was listed and "database" was not — the most natural name for the thing being caught.
    const root = plugin({
      "package.json": JSON.stringify({ name: "p", license: "MIT" }),
      "database/shifts.csv": "shift,element"
    });
    expect(() => assertBundledDataLicensed(root, gateError)).toThrow(/declares no "dataLicenses"/);
  });

  it("refuses a declaration that names a dataset without naming its terms", () => {
    // Half a declaration is worse than none: it looks like the question was answered.
    const root = plugin({
      "package.json": JSON.stringify({
        name: "p",
        license: "MIT",
        dataLicenses: [{ name: "some corpus", license: "  " }]
      }),
      "data/corpus.csv": "a,b"
    });
    expect(() => assertBundledDataLicensed(root, gateError)).toThrow(/non-empty name and license/);
  });

  it("treats an unreadable manifest as an undeclared one rather than passing it", () => {
    const root = plugin({ "package.json": "{ not json", "data/corpus.csv": "a,b" });
    expect(() => assertBundledDataLicensed(root, gateError)).toThrow(/declares no "dataLicenses"/);
  });
});
