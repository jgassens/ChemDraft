import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createZipFixture, sidecarFor, type ZipFixtureEntry } from "../../apps/desktop/src/testSupport/zipFixture";
import { main, stageWebPlugins, WebPluginStageError } from "./stage";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stage-web-plugins-"));
  dirs.push(dir);
  return dir;
}

function manifest(id: string, version: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id,
    name: "Staging Fixture",
    version,
    apiVersion: "^0.1.0",
    entry: "entry.js",
    permissions: [],
    contributes: {},
    chemdraftPackage: {
      sdk: "@chemdraft/plugin-api",
      sdkVersion: "0.1.28",
      sourceCommit: "0fd3eceec674f207fe2651fe7a19f6438a55fb17",
      sourceTree: "clean",
      licenseFile: "LICENSE",
      packagedAt: "2026-11-27T00:00:00.000Z"
    },
    ...overrides
  });
}

/** Write `<name>.zip` (and its sidecar unless `sidecar: false`) into `dir`. */
async function writePackage(
  dir: string,
  name: string,
  entries: ZipFixtureEntry[],
  options: { sidecar?: string | false } = {}
): Promise<string> {
  const zip = await createZipFixture(entries);
  const path = join(dir, `${name}.zip`);
  writeFileSync(path, zip);
  if (options.sidecar !== false) writeFileSync(`${path}.sha256`, options.sidecar ?? (await sidecarFor(zip, `${name}.zip`)));
  return path;
}

const goodEntries = (version = "1.0.0", marker = "one"): ZipFixtureEntry[] => [
  { path: "manifest.json", content: manifest("org.example.staged", version) },
  { path: "entry.js", content: `export const marker = "${marker}";` },
  { path: "assets/chunk.js", content: "export const nested = true;", deflate: true },
  { path: "LICENSE", content: "MIT" }
];

async function refusal(promise: Promise<unknown>): Promise<WebPluginStageError> {
  const error = await promise.then(() => undefined, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(AggregateError);
  const [first] = (error as AggregateError).errors;
  expect(first).toBeInstanceOf(WebPluginStageError);
  return first as WebPluginStageError;
}

describe("stageWebPlugins", () => {
  it("unpacks a verified package to <out>/<id>/ and writes the index", async () => {
    const work = tempDir();
    const out = join(work, "out");
    const zip = await writePackage(work, "staged-1.0.0", goodEntries());

    const result = await stageWebPlugins([zip], { outDir: out });

    expect(readFileSync(join(out, "org.example.staged", "entry.js"), "utf8")).toContain('"one"');
    expect(existsSync(join(out, "org.example.staged", "assets", "chunk.js"))).toBe(true);
    const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
    expect(index).toEqual({
      version: 1,
      plugins: [{ id: "org.example.staged", version: "1.0.0", dir: "org.example.staged", sha256: result.staged[0].sha256 }]
    });
    expect(result.staged[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    // No staging temp directories are left behind.
    expect(readdirSync(out).sort()).toEqual(["index.json", "org.example.staged"]);
  });

  it("re-staging replaces the plugin's directory, dropping files the new package lacks", async () => {
    const work = tempDir();
    const out = join(work, "out");
    await stageWebPlugins([await writePackage(work, "v1", [...goodEntries("1.0.0", "one"), { path: "old-only.js", content: "x" }])], { outDir: out });
    await stageWebPlugins([await writePackage(work, "v2", goodEntries("1.1.0", "two"))], { outDir: out });

    expect(readFileSync(join(out, "org.example.staged", "entry.js"), "utf8")).toContain('"two"');
    expect(existsSync(join(out, "org.example.staged", "old-only.js"))).toBe(false);
    const index = JSON.parse(readFileSync(join(out, "index.json"), "utf8"));
    expect(index.plugins.map((entry: { version: string }) => entry.version)).toEqual(["1.1.0"]);
    expect(readdirSync(out).sort()).toEqual(["index.json", "org.example.staged"]);
  });

  it("refuses a package whose sha256 does not match, naming the zip and the gate", async () => {
    const work = tempDir();
    const out = join(work, "out");
    const zip = await writePackage(work, "bad-sum", goodEntries(), { sidecar: `${"0".repeat(64)}  bad-sum.zip\n` });
    const error = await refusal(stageWebPlugins([zip], { outDir: out }));
    expect(error.gate).toBe("sha256");
    expect(error.message).toContain(zip);
    expect(error.message).toMatch(/sha256 gate failed/);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a package with no sidecar", async () => {
    const work = tempDir();
    const zip = await writePackage(work, "no-sum", goodEntries(), { sidecar: false });
    const error = await refusal(stageWebPlugins([zip], { outDir: join(work, "out") }));
    expect(error.gate).toBe("sha256");
    expect(error.message).toContain(".sha256");
  });

  it("refuses a path-traversal entry and writes nothing", async () => {
    const work = tempDir();
    const out = join(work, "out");
    const zip = await writePackage(work, "evil", [...goodEntries(), { path: "../escape.js", content: "boom" }]);
    const error = await refusal(stageWebPlugins([zip], { outDir: out }));
    expect(error.gate).toBe("path traversal");
    expect(existsSync(join(work, "escape.js"))).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses an invalid manifest", async () => {
    const work = tempDir();
    const zip = await writePackage(work, "bad-manifest", [
      { path: "manifest.json", content: manifest("org.example.staged", "1.0.0", { apiVersion: 7 }) },
      { path: "entry.js", content: "x" }
    ]);
    const error = await refusal(stageWebPlugins([zip], { outDir: join(work, "out") }));
    expect(error.gate).toBe("manifest");
    expect(error.message).toMatch(/manifest\.json is not valid/);
  });

  it("refuses a corrupted entry (CRC)", async () => {
    const work = tempDir();
    const zip = await writePackage(work, "crc", [...goodEntries().slice(0, 1), { path: "entry.js", content: "x", crcOverride: 0x1234 }]);
    const error = await refusal(stageWebPlugins([zip], { outDir: join(work, "out") }));
    expect(error.gate).toBe("CRC");
  });

  it("stages nothing when any one of several zips is refused", async () => {
    const work = tempDir();
    const out = join(work, "out");
    const good = await writePackage(work, "good", goodEntries());
    const bad = await writePackage(work, "bad", goodEntries(), { sidecar: false });
    await refusal(stageWebPlugins([good, bad], { outDir: out }));
    expect(existsSync(out)).toBe(false);
  });
});

describe("main", () => {
  it("exits 0 with relative paths resolved against cwd, 1 on refusal, 2 on bad arguments", async () => {
    const work = tempDir();
    await writePackage(work, "cli", goodEntries());
    const lines: string[] = [];
    const errors: string[] = [];
    const io = { cwd: work, log: (line: string) => lines.push(line), error: (line: string) => errors.push(line) };

    expect(await main(["--", "cli.zip", "--out", "staged"], io)).toBe(0);
    expect(existsSync(join(work, "staged", "org.example.staged", "manifest.json"))).toBe(true);
    expect(lines.join("\n")).toMatch(/Staged org\.example\.staged 1\.0\.0/);

    expect(await main(["missing.zip"], io)).toBe(1);
    expect(errors.join("\n")).toMatch(/missing\.zip: read gate failed/);
    expect(await main([], io)).toBe(2);
    expect(await main(["--bogus"], io)).toBe(2);
  });
});
