/**
 * `plugin:package` gate tests (ADR-0029 §5, M35).
 *
 * These cover the refusals — the paths that must never produce an artifact. They use small synthetic
 * plugin fixtures and assert failure *before* any bundling happens, so they stay fast. The successful
 * end-to-end path (real plugin source → real bundle → real load) is proved against the actual
 * mass-fragment plugin in `apps/desktop/src/plugins/packagedPluginLoad.test.ts`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_WORKER_ENTRY, packagePlugin, parseCliArgs, PluginPackagingError } from "./package";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(pluginRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: pluginRoot, encoding: "utf8" }).trim();
}

/** A minimal plugin fixture. `index.ts` exports a plain manifest object literal (no SDK import needed),
 *  so these tests never depend on module resolution outside the fixture. */
function createPluginFixture(
  options: {
    license?: boolean;
    workerEntry?: boolean;
    source?: string;
    manifests?: number;
    /** Nest the plugin under this directory, to place it relative to a would-be staging path. */
    parentDir?: string;
  } = {}
): { caseRoot: string; pluginRoot: string; sourceCommit: string } {
  const caseRoot = mkdtempSync(join(tmpdir(), "chemdraft-package-"));
  temporaryRoots.push(caseRoot);
  const pluginRoot = join(caseRoot, options.parentDir ?? ".", "plugin-fixture");
  mkdirSync(join(pluginRoot, "src"), { recursive: true });

  const manifest = (id: string, name: string): string =>
    `export const ${name} = { id: "${id}", name: "Fixture", version: "1.2.3", apiVersion: "^0.1.0", ` +
    `entry: "dist/plugin.js", permissions: [], contributes: {} };\n`;

  const manifestCount = options.manifests ?? 1;
  let indexSource = "";
  for (let i = 0; i < manifestCount; i += 1) {
    indexSource += manifest(`org.fixture.plugin${i === 0 ? "" : i}`, `fixtureManifest${i === 0 ? "" : i}`);
  }
  writeFileSync(join(pluginRoot, "src/index.ts"), options.source ?? indexSource);
  if (options.workerEntry !== false) {
    writeFileSync(join(pluginRoot, DEFAULT_WORKER_ENTRY), `export const started = true;\n`);
  }
  if (options.license !== false) writeFileSync(join(pluginRoot, "LICENSE"), "MIT test fixture license\n");
  writeFileSync(
    join(pluginRoot, "package.json"),
    `${JSON.stringify({ name: "@fixture/plugin-package", version: "1.2.3", private: true, type: "module" }, null, 2)}\n`
  );

  git(pluginRoot, ["init", "-q"]);
  git(pluginRoot, ["add", "."]);
  git(pluginRoot, ["-c", "user.name=ChemDraft Test", "-c", "user.email=tests@chemdraft.invalid", "commit", "-q", "-m", "fixture"]);
  return { caseRoot, pluginRoot, sourceCommit: git(pluginRoot, ["rev-parse", "HEAD"]) };
}

const outFor = (fixture: { caseRoot: string }): string => join(fixture.caseRoot, "out");

describe("plugin:package — fail-closed gates", () => {
  it("accepts pnpm's conventional argument separator and both flags", () => {
    expect(parseCliArgs(["--", "examples/plugins/example", "--out", "dist/plugin-packages", "--entry", "src/w.ts"])).toEqual({
      pluginRoot: "examples/plugins/example",
      outDir: "dist/plugin-packages",
      entry: "src/w.ts"
    });
    expect(parseCliArgs(["examples/plugins/example"])).toEqual({
      pluginRoot: "examples/plugins/example",
      outDir: undefined,
      entry: undefined
    });
    expect(() => parseCliArgs([])).toThrow(/usage: pnpm plugin:package/);
    expect(() => parseCliArgs(["a", "b"])).toThrow(/usage: pnpm plugin:package/);
    expect(() => parseCliArgs(["a", "--out"])).toThrow(/--out requires a value/);
  });

  it("refuses a plugin that reaches outside the SDK boundary rather than packaging ChemDraft internals", async () => {
    const fixture = createPluginFixture({
      source: `import value from "@chemdraft/plugin-host/internal";\nexport const fixtureManifest = value;\n`
    });
    await expect(packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: outFor(fixture) })).rejects.toThrow(
      /@chemdraft\/plugin-host\/internal/
    );
  });

  it("refuses a dirty plugin rather than recording a source commit that does not describe the bytes", async () => {
    const fixture = createPluginFixture();
    writeFileSync(join(fixture.pluginRoot, "src/index.ts"), "export const dirty = true;\n");
    await expect(packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: outFor(fixture) })).rejects.toThrow(
      /uncommitted or untracked files/
    );
  });

  it("refuses committed symlinks before the bundler can follow them", async () => {
    const fixture = createPluginFixture();
    writeFileSync(join(fixture.caseRoot, "outside-secret.ts"), "export const secret = true;\n");
    symlinkSync(join(fixture.caseRoot, "outside-secret.ts"), join(fixture.pluginRoot, "src/local-secret.ts"));
    git(fixture.pluginRoot, ["add", "src/local-secret.ts"]);
    git(fixture.pluginRoot, [
      "-c",
      "user.name=ChemDraft Test",
      "-c",
      "user.email=tests@chemdraft.invalid",
      "commit",
      "-q",
      "-m",
      "symlink fixture"
    ]);

    await expect(packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: outFor(fixture) })).rejects.toThrow(
      /symbolic link.*src[/\\]local-secret\.ts/
    );
  });

  it("builds from the recorded commit, so an import cannot pull ignored source into the bundle", async () => {
    const fixture = createPluginFixture();
    writeFileSync(join(fixture.pluginRoot, ".gitignore"), "node_modules/\nsrc/private.cjs\n");
    writeFileSync(
      join(fixture.pluginRoot, DEFAULT_WORKER_ENTRY),
      `import { secret } from "./private.cjs";\nexport const started = secret;\n`
    );
    mkdirSync(join(fixture.pluginRoot, "node_modules"));
    writeFileSync(join(fixture.pluginRoot, "node_modules/dependency.js"), "ignored dependency fixture\n");
    git(fixture.pluginRoot, ["add", ".gitignore", DEFAULT_WORKER_ENTRY]);
    git(fixture.pluginRoot, [
      "-c",
      "user.name=ChemDraft Test",
      "-c",
      "user.email=tests@chemdraft.invalid",
      "commit",
      "-q",
      "-m",
      "ignore fixture"
    ]);
    writeFileSync(join(fixture.pluginRoot, "src/private.cjs"), "module.exports = 'secret';\n");

    await expect(packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: outFor(fixture) })).rejects.toThrow(
      /private\.cjs/
    );
  });

  it("allows unrelated ignored build output and OS metadata because neither enters the committed snapshot", async () => {
    const fixture = createPluginFixture();
    writeFileSync(join(fixture.pluginRoot, ".gitignore"), ".DS_Store\ndist/\n");
    git(fixture.pluginRoot, ["add", ".gitignore"]);
    git(fixture.pluginRoot, [
      "-c",
      "user.name=ChemDraft Test",
      "-c",
      "user.email=tests@chemdraft.invalid",
      "commit",
      "-q",
      "-m",
      "ignore build output"
    ]);
    writeFileSync(join(fixture.pluginRoot, ".DS_Store"), "local Finder metadata\n");
    mkdirSync(join(fixture.pluginRoot, "dist"));
    writeFileSync(join(fixture.pluginRoot, "dist/old-entry.js"), "must not ship\n");

    const result = await packagePlugin({
      pluginRoot: fixture.pluginRoot,
      outDir: outFor(fixture),
      repoRoot: join(import.meta.dirname, "../..")
    });
    expect(result.files.map((file) => file.path)).not.toContain("old-entry.js");
  });

  it("allows an ignored node_modules dependency tree because it is bundled, never copied wholesale", async () => {
    const fixture = createPluginFixture();
    writeFileSync(join(fixture.pluginRoot, ".gitignore"), "node_modules/\n");
    mkdirSync(join(fixture.pluginRoot, "node_modules"));
    writeFileSync(join(fixture.pluginRoot, "node_modules/dependency.js"), "ignored dependency fixture\n");
    git(fixture.pluginRoot, ["add", ".gitignore"]);
    git(fixture.pluginRoot, [
      "-c",
      "user.name=ChemDraft Test",
      "-c",
      "user.email=tests@chemdraft.invalid",
      "commit",
      "-q",
      "-m",
      "dependency fixture"
    ]);

    const result = await packagePlugin({
      pluginRoot: fixture.pluginRoot,
      outDir: outFor(fixture),
      repoRoot: join(import.meta.dirname, "../..")
    });
    expect(result.files.map((file) => file.path)).not.toContain("node_modules/dependency.js");
  });

  it("refuses to build an installable package without explicit license terms", async () => {
    const fixture = createPluginFixture({ license: false });
    await expect(packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: outFor(fixture) })).rejects.toThrow(
      /no LICENSE or LICENSE\.md/
    );
  });

  it("refuses a plugin with no worker entry, and says what a packageable plugin must ship", async () => {
    const fixture = createPluginFixture({ workerEntry: false });
    await expect(packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: outFor(fixture) })).rejects.toThrow(
      PluginPackagingError
    );
    await expect(packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: outFor(fixture) })).rejects.toThrow(
      /runPluginWorker/
    );
  });

  it("refuses an explicit --entry that does not exist", async () => {
    const fixture = createPluginFixture();
    await expect(
      packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: outFor(fixture), entry: "src/nope.ts" })
    ).rejects.toThrow(/worker entry "src\/nope\.ts" does not exist/);
  });

  it("refuses an explicit --entry outside the plugin tree", async () => {
    const fixture = createPluginFixture();
    const outsideEntry = join(fixture.caseRoot, "outside-worker.mjs");
    writeFileSync(outsideEntry, "export const outside = true;\n");

    await expect(
      packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: outFor(fixture), entry: outsideEntry })
    ).rejects.toThrow(/worker entry must be a file inside the plugin's src directory/);
  });

  it("refuses an explicit runtime entry outside src, where the boundary scanner cannot inspect it", async () => {
    const fixture = createPluginFixture();
    writeFileSync(join(fixture.pluginRoot, "worker.mjs"), "export const unscanned = true;\n");
    git(fixture.pluginRoot, ["add", "worker.mjs"]);
    git(fixture.pluginRoot, [
      "-c",
      "user.name=ChemDraft Test",
      "-c",
      "user.email=tests@chemdraft.invalid",
      "commit",
      "-q",
      "-m",
      "out-of-src entry fixture"
    ]);

    await expect(
      packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: outFor(fixture), entry: "worker.mjs" })
    ).rejects.toThrow(/worker entry must be a file inside the plugin's src directory/);
  });

  it("refuses an explicit --entry with a non-runtime extension", async () => {
    const fixture = createPluginFixture();
    writeFileSync(join(fixture.pluginRoot, "src/worker.json"), "{}\n");
    git(fixture.pluginRoot, ["add", "src/worker.json"]);
    git(fixture.pluginRoot, [
      "-c",
      "user.name=ChemDraft Test",
      "-c",
      "user.email=tests@chemdraft.invalid",
      "commit",
      "-q",
      "-m",
      "non-runtime entry fixture"
    ]);

    await expect(
      packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: outFor(fixture), entry: "src/worker.json" })
    ).rejects.toThrow(/supported JavaScript or TypeScript extension/);
  });

  it("refuses an ambiguous plugin that exports more than one manifest rather than guessing", async () => {
    const fixture = createPluginFixture({ manifests: 2 });
    await expect(packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: outFor(fixture) })).rejects.toThrow(
      /exports 2 valid PluginManifests/
    );
  });

  it("refuses a plugin whose index exports no manifest", async () => {
    const fixture = createPluginFixture({ source: "export const notAManifest = { id: 1 };\n" });
    await expect(packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: outFor(fixture) })).rejects.toThrow(
      /exports no valid PluginManifest/
    );
  });

  it("refuses an output directory that would erase the source plugin while staging", async () => {
    // Staging (`<out>/plugin-fixture-1.2.3`) is emptied before the build, so if it happened to be an
    // ancestor of the plugin it would delete the very source being packaged.
    const fixture = createPluginFixture({ parentDir: "plugin-fixture-1.2.3" });
    await expect(packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: fixture.caseRoot })).rejects.toThrow(
      /must not be the plugin directory or one of its parents/
    );
  });

  it("refuses to spray build output into the plugin's own tree", async () => {
    const fixture = createPluginFixture();
    await expect(packagePlugin({ pluginRoot: fixture.pluginRoot, outDir: fixture.pluginRoot })).rejects.toThrow(
      /must not be inside the plugin directory/
    );
  });
});
