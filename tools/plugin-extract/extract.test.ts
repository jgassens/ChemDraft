import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { extractPlugin, parseCliArgs, PluginExtractionError, repositoryRoot } from "./extract";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(pluginRoot: string, args: string[]): string {
  return execFileSync("git", args, { cwd: pluginRoot, encoding: "utf8" }).trim();
}

function createPluginFixture(options: { license?: boolean; source?: string } = {}): {
  caseRoot: string;
  pluginRoot: string;
  sourceCommit: string;
} {
  const caseRoot = mkdtempSync(join(tmpdir(), "chemdraft-extract-"));
  temporaryRoots.push(caseRoot);
  const pluginRoot = join(caseRoot, "plugin-fixture");
  mkdirSync(join(pluginRoot, "src/tests"), { recursive: true });
  writeFileSync(
    join(pluginRoot, "src/index.ts"),
    options.source ?? `import type { PluginManifest } from "@chemdraft/plugin-api";\nexport type Fixture = PluginManifest;\n`
  );
  writeFileSync(join(pluginRoot, "src/tests/index.test.ts"), "throw new Error('must not ship');\n");
  writeFileSync(join(pluginRoot, "README.md"), "# Licensed extraction fixture\n");
  if (options.license !== false) writeFileSync(join(pluginRoot, "LICENSE"), "MIT test fixture license\n");
  writeFileSync(
    join(pluginRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@fixture/plugin-extraction",
        version: "1.2.3",
        private: true,
        type: "module",
        dependencies: {
          "@chemdraft/plugin-api": "workspace:*",
          "@chemdraft/plugin-host": "workspace:*",
          zod: "^3.25.76"
        },
        optionalDependencies: { "fixture-optional": "^1.0.0" },
        peerDependencies: { "fixture-peer": "^2.0.0" },
        exports: { ".": { types: "./src/index.ts", default: "./src/index.ts" } }
      },
      null,
      2
    )}\n`
  );

  git(pluginRoot, ["init", "-q"]);
  git(pluginRoot, ["add", "."]);
  git(pluginRoot, [
    "-c",
    "user.name=ChemDraft Test",
    "-c",
    "user.email=tests@chemdraft.invalid",
    "commit",
    "-q",
    "-m",
    "fixture"
  ]);
  return { caseRoot, pluginRoot, sourceCommit: git(pluginRoot, ["rev-parse", "HEAD"]) };
}

describe("plugin extraction integrity", () => {
  it("accepts pnpm's conventional argument separator", () => {
    expect(parseCliArgs(["--", "examples/plugins/example", "--out", "dist/plugins"])).toEqual({
      pluginRoot: "examples/plugins/example",
      outDir: "dist/plugins"
    });
  });

  it("creates a licensed archive with clean-commit provenance and a verified checksum sidecar", () => {
    const fixture = createPluginFixture();
    const outDir = join(fixture.caseRoot, "out");
    const result = extractPlugin({ pluginRoot: fixture.pluginRoot, outDir, repoRoot: repositoryRoot });

    expect(result.sourceCommit).toBe(fixture.sourceCommit);
    expect(result.sdkVersion).toBe("0.1.0");
    expect(result.sha256).toBe(createHash("sha256").update(readFileSync(result.zipPath)).digest("hex"));
    expect(readFileSync(result.checksumPath, "utf8")).toBe(
      `${result.sha256}  plugin-fixture-1.2.3.zip\n`
    );

    const extractedPackage = JSON.parse(
      readFileSync(join(outDir, "plugin-fixture/package.json"), "utf8")
    ) as {
      dependencies: Record<string, string>;
      optionalDependencies: Record<string, string>;
      peerDependencies: Record<string, string>;
      chemdraftPlugin: Record<string, string>;
    };
    expect(extractedPackage.dependencies).toEqual({ zod: "^3.25.76" });
    expect(extractedPackage.optionalDependencies).toEqual({ "fixture-optional": "^1.0.0" });
    expect(extractedPackage.peerDependencies).toEqual({
      "fixture-peer": "^2.0.0",
      "@chemdraft/plugin-api": "^0.1.0"
    });
    expect(extractedPackage.chemdraftPlugin).toMatchObject({
      sourceCommit: fixture.sourceCommit,
      sourceTree: "clean",
      licenseFile: "LICENSE"
    });

    const entries = execFileSync("unzip", ["-Z1", result.zipPath], { encoding: "utf8" });
    expect(entries).toContain("plugin-fixture/LICENSE");
    expect(entries).toContain("plugin-fixture/EXTRACTED.md");
    expect(entries).not.toMatch(/(?:^|\/)tests(?:\/|$)|\.test\.tsx?$/m);
    expect(execFileSync("unzip", ["-t", result.zipPath], { encoding: "utf8" })).toContain(
      "No errors detected"
    );
  });

  it("refuses a dirty plugin rather than attaching a misleading source commit", () => {
    const fixture = createPluginFixture();
    writeFileSync(join(fixture.pluginRoot, "src/index.ts"), "export const dirty = true;\n");
    expect(() =>
      extractPlugin({ pluginRoot: fixture.pluginRoot, outDir: join(fixture.caseRoot, "out") })
    ).toThrow(/uncommitted or untracked files/);
  });

  it("refuses a committed symlink rather than dereferencing local bytes into the archive", () => {
    const fixture = createPluginFixture();
    writeFileSync(join(fixture.caseRoot, "outside-secret.txt"), "must not ship\n");
    symlinkSync(join(fixture.caseRoot, "outside-secret.txt"), join(fixture.pluginRoot, "src/local-secret.txt"));
    git(fixture.pluginRoot, ["add", "src/local-secret.txt"]);
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

    expect(() =>
      extractPlugin({ pluginRoot: fixture.pluginRoot, outDir: join(fixture.caseRoot, "out") })
    ).toThrow(/symbolic link.*src[/\\]local-secret\.txt/);
  });

  it("builds from the recorded commit, so ignored source cannot enter the archive", () => {
    const fixture = createPluginFixture();
    writeFileSync(join(fixture.pluginRoot, ".gitignore"), "src/private.mjs\n");
    git(fixture.pluginRoot, ["add", ".gitignore"]);
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
    writeFileSync(join(fixture.pluginRoot, "src/private.mjs"), "export const secret = true;\n");

    const outDir = join(fixture.caseRoot, "out");
    const result = extractPlugin({ pluginRoot: fixture.pluginRoot, outDir });
    expect(existsSync(join(outDir, "plugin-fixture/src/private.mjs"))).toBe(false);
    expect(execFileSync("unzip", ["-Z1", result.zipPath], { encoding: "utf8" })).not.toContain("private.mjs");
  });

  it("refuses to make a distributable archive without an explicit plugin license", () => {
    const fixture = createPluginFixture({ license: false });
    expect(() =>
      extractPlugin({ pluginRoot: fixture.pluginRoot, outDir: join(fixture.caseRoot, "out") })
    ).toThrow(/no LICENSE or LICENSE\.md/);
  });

  it("refuses a package that reaches through a forbidden ChemDraft subpath", () => {
    const fixture = createPluginFixture({
      source: `import value from "@chemdraft/plugin-host/internal";\nexport { value };\n`
    });
    expect(() =>
      extractPlugin({ pluginRoot: fixture.pluginRoot, outDir: join(fixture.caseRoot, "out") })
    ).toThrow(/@chemdraft\/plugin-host\/internal/);
  });

  it("refuses an output directory that would erase the source plugin while staging", () => {
    const fixture = createPluginFixture();
    expect(() =>
      extractPlugin({ pluginRoot: fixture.pluginRoot, outDir: dirname(fixture.pluginRoot) })
    ).toThrow(PluginExtractionError);
    expect(() =>
      extractPlugin({ pluginRoot: fixture.pluginRoot, outDir: dirname(fixture.pluginRoot) })
    ).toThrow(/must not be the plugin directory/);
  });
});
