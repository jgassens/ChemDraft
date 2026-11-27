import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Pass-through `node:fs` with a hook that can make one rename fail, to drive the rollback paths.
const fsFaults = vi.hoisted(() => ({ rename: undefined as undefined | ((from: string, to: string) => void) }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (from: import("node:fs").PathLike, to: import("node:fs").PathLike) => {
      fsFaults.rename?.(String(from), String(to));
      return actual.renameSync(from, to);
    }
  };
});

import { createZipFixture, sidecarFor, type ZipFixtureEntry } from "../../apps/desktop/src/testSupport/zipFixture";
import { main, stageWebPlugins, WebPluginStageError } from "./stage";

const dirs: string[] = [];
afterEach(() => {
  fsFaults.rename = undefined;
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

const goodEntries = (version = "1.0.0", marker = "one", id = "org.example.staged"): ZipFixtureEntry[] => [
  { path: "manifest.json", content: manifest(id, version) },
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

describe("stageWebPlugins is all-or-nothing across the set", () => {
  /** Stage A and B at 1.0.0, returning a snapshot of everything a later failed run must leave alone. */
  async function stagedPair(work: string, out: string) {
    await stageWebPlugins(
      [
        await writePackage(work, "a-1", goodEntries("1.0.0", "a-one", "org.example.a")),
        await writePackage(work, "b-1", goodEntries("1.0.0", "b-one", "org.example.b"))
      ],
      { outDir: out }
    );
    return snapshot(out);
  }
  function snapshot(out: string) {
    return {
      listing: readdirSync(out).sort(),
      index: readFileSync(join(out, "index.json"), "utf8"),
      a: readFileSync(join(out, "org.example.a", "entry.js"), "utf8"),
      b: readFileSync(join(out, "org.example.b", "entry.js"), "utf8")
    };
  }

  it("refuses a package with a file where another entry needs a directory, before touching any plugin", async () => {
    const work = tempDir();
    const out = join(work, "out");
    const before = await stagedPair(work, out);
    const a2 = await writePackage(work, "a-2", goodEntries("2.0.0", "a-two", "org.example.a"));
    const clash = await writePackage(work, "b-2", [
      ...goodEntries("2.0.0", "b-two", "org.example.b"),
      { path: "x", content: "file" },
      { path: "x/y", content: "nested" }
    ]);
    const error = await refusal(stageWebPlugins([a2, clash], { outDir: out }));
    expect(error.gate).toBe("file collision");
    expect(error.message).toContain(clash);
    expect(error.message).toMatch(/"x" is a file, but "x\/y" needs a directory at the same path/);
    expect(snapshot(out)).toEqual(before);
  });

  it("treats a file and a directory that differ only in case as the same path", async () => {
    const work = tempDir();
    const clash = await writePackage(work, "case", [...goodEntries(), { path: "Lib", content: "file" }, { path: "lib/z.js", content: "z" }]);
    const error = await refusal(stageWebPlugins([clash], { outDir: join(work, "out") }));
    expect(error.gate).toBe("file collision");
    expect(existsSync(join(work, "out"))).toBe(false);
  });

  it("puts back every swapped plugin and leaves the index when a later swap fails", async () => {
    const work = tempDir();
    const out = join(work, "out");
    const before = await stagedPair(work, out);
    const a2 = await writePackage(work, "a-2", goodEntries("2.0.0", "a-two", "org.example.a"));
    const b2 = await writePackage(work, "b-2", goodEntries("2.0.0", "b-two", "org.example.b"));
    fsFaults.rename = (from, to) => {
      if (from.includes(".staging-org.example.b") && to.endsWith("org.example.b")) throw new Error("EIO: injected swap failure");
    };
    await expect(stageWebPlugins([a2, b2], { outDir: out })).rejects.toThrow(/injected swap failure/);
    expect(snapshot(out)).toEqual(before);
  });

  it("puts back every swapped plugin when the index cannot be written", async () => {
    const work = tempDir();
    const out = join(work, "out");
    const before = await stagedPair(work, out);
    const a2 = await writePackage(work, "a-2", goodEntries("2.0.0", "a-two", "org.example.a"));
    fsFaults.rename = (_from, to) => {
      if (to.endsWith("index.json")) throw new Error("ENOSPC: injected index failure");
    };
    await expect(stageWebPlugins([a2], { outDir: out })).rejects.toThrow(/injected index failure/);
    expect(snapshot(out)).toEqual(before);
  });

  it("reports by hand what it could not roll back", async () => {
    const work = tempDir();
    const out = join(work, "out");
    await stagedPair(work, out);
    const a2 = await writePackage(work, "a-2", goodEntries("2.0.0", "a-two", "org.example.a"));
    fsFaults.rename = (from, to) => {
      if (to.endsWith("index.json")) throw new Error("injected index failure");
      if (from.includes(".old-org.example.a")) throw new Error("injected restore failure");
    };
    await expect(stageWebPlugins([a2], { outDir: out })).rejects.toThrow(
      /injected index failure\. Rolling back also failed, so fix these by hand: org\.example\.a: the previous copy is at .*\.old-org\.example\.a/
    );
  });

  it("main does not claim everything was restored when the rollback failed", async () => {
    const work = tempDir();
    const out = join(work, "out");
    await stagedPair(work, out);
    await writePackage(work, "a-2", goodEntries("2.0.0", "a-two", "org.example.a"));
    fsFaults.rename = (from, to) => {
      if (to.endsWith("index.json")) throw new Error("injected index failure");
      if (from.includes(".old-org.example.a")) throw new Error("injected restore failure");
    };
    const errors: string[] = [];
    const io = { cwd: work, log: () => undefined, error: (line: string) => errors.push(line) };
    expect(await main(["a-2.zip", "--out", "out"], io)).toBe(1);
    const text = errors.join("\n");
    expect(text).not.toContain("were left as they were");
    expect(text).toMatch(/Rolling back also failed, so fix these by hand: org\.example\.a: the previous copy is at .*\.old-org\.example\.a/);
  });
});

describe("stageWebPlugins refuses ids equal up to letter case", () => {
  it("between two incoming packages", async () => {
    const work = tempDir();
    const out = join(work, "out");
    const lower = await writePackage(work, "lower", goodEntries("1.0.0", "l", "org.example.mixed"));
    const upper = await writePackage(work, "upper", goodEntries("1.0.0", "u", "Org.Example.Mixed"));
    const error = await refusal(stageWebPlugins([lower, upper], { outDir: out }));
    expect(error.gate).toBe("id case collision");
    expect(error.message).toContain(upper);
    expect(error.message).toMatch(/"Org\.Example\.Mixed" differs only in letter case from "org\.example\.mixed"/);
    expect(existsSync(out)).toBe(false);
  });

  it("against an id already in the index, which is left unchanged", async () => {
    const work = tempDir();
    const out = join(work, "out");
    await stageWebPlugins([await writePackage(work, "first", goodEntries())], { outDir: out });
    const indexBefore = readFileSync(join(out, "index.json"), "utf8");
    const upper = await writePackage(work, "upper", goodEntries("2.0.0", "u", "ORG.example.staged"));
    const error = await refusal(stageWebPlugins([upper], { outDir: out }));
    expect(error.gate).toBe("id case collision");
    expect(error.message).toMatch(/differs only in letter case from the already staged "org\.example\.staged"/);
    expect(readFileSync(join(out, "index.json"), "utf8")).toBe(indexBefore);
    expect(readFileSync(join(out, "org.example.staged", "entry.js"), "utf8")).toContain('"one"');
    expect(readdirSync(out).sort()).toEqual(["index.json", "org.example.staged"]);
  });

  it("still re-stages the same exact id", async () => {
    const work = tempDir();
    const out = join(work, "out");
    await stageWebPlugins([await writePackage(work, "v1", goodEntries())], { outDir: out });
    await expect(stageWebPlugins([await writePackage(work, "v2", goodEntries("1.1.0"))], { outDir: out })).resolves.toBeDefined();
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
