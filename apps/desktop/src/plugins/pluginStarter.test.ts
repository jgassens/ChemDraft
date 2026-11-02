import { readFileSync } from "node:fs";
import { dangerousPluginPermissions, PluginApiVersion } from "@chemdraft/plugin-api";
import { describe, expect, it } from "vitest";
import {
  buildPluginStarterMarkdown, pluginStarterAuthoringHeadings, pluginStarterAuthoringSection, sanitizePluginStarterProse
} from "./pluginStarter";

const appVersion = "9.8.7-dev";
const markdown = buildPluginStarterMarkdown({ appVersion });
const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8").replace(/\r\n?/g, "\n");

describe("plugin starter Markdown", () => {
  it("includes non-empty slices for every required authoring heading", () => {
    expect(pluginStarterAuthoringHeadings).toEqual([
      "The one rule", "Package shape", "Manifest + registration", "Command handler",
      "Direct document writes versus proposals", "Worker entry", "Distribute"
    ]);
    for (const heading of pluginStarterAuthoringHeadings) {
      expect(read("docs/plugin-architecture/AUTHORING.md")).toContain(`\n## ${heading}\n`);
      const section = pluginStarterAuthoringSection(heading);
      expect(section.trim().length).toBeGreaterThan(0);
      expect(markdown).toContain(section);
      expect(pluginStarterAuthoringSection(heading,
        read("docs/plugin-architecture/AUTHORING.md").replace(/\n/g, "\r\n"))).toBe(section);
    }
    expect(() => pluginStarterAuthoringSection("Missing heading")).toThrow("missing");
    expect(() => pluginStarterAuthoringSection("Empty", "## Empty\n\n## Next\ntext")).toThrow("empty");
    expect(pluginStarterAuthoringSection("Distribute")).toContain("pnpm plugin:package");
    expect(pluginStarterAuthoringSection("Distribute")).toContain("pnpm plugin:extract");
    expect(markdown).not.toContain("\r");
  });

  it("pins the human-to-agent outline order", () => {
    // Ignore code fences: the distributed example and guide contain source comments.
    const prose = markdown.replace(/```[^\n]*\n[\s\S]*?```/g, "");
    expect([...prose.matchAll(/^# (.+)$/gm)].map(match => match[1])).toEqual([
      "To you", "Brief for the agent", "Rules", "Minimal working example", "Build, test, package and install"
    ]);
  });

  it("uses the supplied app version and live SDK version and permission list", () => {
    expect(markdown).toContain(`ChemDraft ${appVersion}`);
    expect(markdown).toContain(`git checkout v${appVersion}`);
    expect(markdown).toContain(`apiVersion to "^${PluginApiVersion}"`);
    for (const permission of dangerousPluginPermissions) expect(markdown).toContain(`\`${permission}\``);
  });

  it("inlines the actual complete example runtime, license and test", () => {
    for (const file of [
      "package.json", "LICENSE", "src/index.ts", "src/manifest.ts", "src/register.ts", "src/workerEntry.ts",
      "src/application/analyzeSelectedStructureMass.ts", "src/massAnalysis.ts", "src/composeMassReport.ts",
      "src/tests/massAnalysis.test.ts"
    ]) {
      expect(markdown).toContain(`## ${file}`);
      if (file !== "LICENSE") expect(markdown).toContain(read(`examples/plugins/mass-fragment-demo/${file}`)
        .replace(/\/\*\*[\s\S]*?\*\//g, sanitizePluginStarterProse).trimEnd());
    }
  });

  it("names existing root scripts and pnpm's install/test commands", () => {
    const { scripts, devDependencies } = JSON.parse(read("package.json"));
    const steps = markdown.split("# Build, test, package and install\n")[1]!;
    const commands = [...steps.matchAll(/\bpnpm ([\w:-]+)/g)].map(match => match[1]);
    expect(commands).toContain("plugin:package");
    expect(commands).toContain("vitest");
    expect(commands).toContain("install");
    for (const command of commands) {
      if (command === "install") continue; // pnpm builtin
      if (command === "vitest") { expect(devDependencies.vitest).toBeTruthy(); continue; }
      expect(scripts[command], `pnpm ${command} must be a root script`).toBeTruthy();
    }
    // The source guide also refers to the source-distribution script.
    for (const command of ["plugin:package", "plugin:extract"]) expect(scripts[command]).toBeTruthy();
  });

  it("keeps the Node requirement aligned with the README", () => {
    expect(read("README.md")).toMatch(/Prerequisites: Node 24\b/);
    expect(markdown).toContain("Use Git, Node 24, and pnpm");
  });

  it("creates the package before installing and stages the lockfile before packaging on both platforms", () => {
    const steps = markdown.split("# Build, test, package and install\n")[1]!;
    const rows = steps.split("\n").filter(line => line.startsWith("| "));
    const row = (label: string) => rows.findIndex(line => line.startsWith(`| ${label} |`));
    const create = row("Create plugin and tests");
    const install = row("Install workspace dependencies from the repo root");
    const test = row("Test your plugin");
    const stage = row("Stage plugin and lockfile");
    const commit = row("Commit plugin and lockfile");
    const pack = row("Build package");
    expect(create).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(create);
    expect(test).toBeGreaterThan(install);
    expect(stage).toBeGreaterThan(test);
    expect(commit).toBeGreaterThan(stage);
    expect(pack).toBeGreaterThan(stage);
    expect(pack).toBeGreaterThan(commit);
    for (const column of [2, 3]) {
      expect(rows[create]!.split("|")[column]).toContain("package.json");
      expect(rows[install]!.split("|")[column]).toContain("`pnpm install`");
      expect(rows[stage]!.split("|")[column]).toContain("`git add -- examples/plugins/<your-plugin> pnpm-lock.yaml`");
      expect(rows[commit]!.split("|")[column]).toContain("`git commit");
    }
  });

  it("includes the trust warning, fallback, goal and real install path without misleading advice", () => {
    expect(markdown).toContain("A plugin you build runs on your computer with the permissions it declares, so only install plugins that you or your agent wrote and that you trust.");
    expect(markdown).toContain("\nGoal: Describe your plugin here\n");
    expect(markdown).toContain('Replace the text after "Goal:" below');
    expect(markdown).toContain(`If \`git checkout v${appVersion}\` fails`);
    expect(markdown).toContain("git checkout main");
    expect(markdown).toContain("Main may be newer than the installed app");
    expect(markdown).toContain("PowerShell");
    expect(markdown).toContain("Plugins ▸ Add or Remove Plugins…");
    expect(markdown).toContain("Add plugin from package…");
    expect(markdown).toContain("Packages over 32 MB are refused");
    expect(markdown).not.toContain("npm install @chemdraft");
    expect(markdown).not.toContain("ChemDraw");
  });

  it("removes internal references cleanly", () => {
    expect(markdown).not.toMatch(/\bADR-\d+\b|\bM\d{2}\b|\bD-\d{2}\b|reports\/\d+|planning workspace|registerBundledPlugins/i);
    expect(sanitizePluginStarterProse("Keep this. See reports/0030 in the planning workspace. Keep that.").replace(/\s+/g, " ")).toBe("Keep this. Keep that.");
  });

  it("preserves prose that resembles internal references", () => {
    for (const prose of ["Use an ADR-compatible format.", "an M3 screw", "D-glucose", "version 0.1.20", "C10H18"]) {
      expect(sanitizePluginStarterProse(prose)).toBe(prose);
    }
  });

  it("personalizes the license and explains the example entries", () => {
    const license = read("examples/plugins/mass-fragment-demo/LICENSE");
    const [, , holder] = license.match(/^Copyright \(c\) (\d{4}) (.+)$/m)!;
    expect(markdown).not.toContain(holder);
    expect(markdown).toContain("Copyright (c) <year> <your name>");
    expect(markdown).not.toMatch(/Copyright \(c\) \d{4}/);
    expect(markdown).toContain("Put the plugin author's name and the current year");
    const pkg = JSON.parse(read("examples/plugins/mass-fragment-demo/package.json"));
    const entry = read("examples/plugins/mass-fragment-demo/src/manifest.ts").match(/entry: "([^"]+)"/)![1];
    expect(markdown).toContain(`Rename the example package \`${pkg.name}\``);
    expect(markdown).toContain("never under the `@chemdraft` scope");
    expect(markdown).toContain(`\`${pkg.exports["."].default.slice(2)}\` is the source entry`);
    expect(markdown).toContain(`\`${entry}\` is the built entry`);
  });
});
