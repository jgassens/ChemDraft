import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// This package exists so the headless CLI can build documents without loading the desktop app. It
// stays useful only while it stays pure: no desktop source, no UI framework, no Tauri, and no
// plugin or 3D-engine runtime. See README.md.

const packageSrc = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageSrc, "../../..");
const appsRoot = join(repoRoot, "apps");

const FORBIDDEN_PACKAGES = [
  "react",
  "react-dom",
  "@tauri-apps",
  "@chemdraft/desktop",
  "@chemdraft/plugin-api",
  "@chemdraft/plugin-host",
  "@chemdraft/engine3d-api"
];

const SPECIFIER_PATTERN =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

function forbiddenReason(file: string, specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    const target = resolve(dirname(file), specifier);
    return target === appsRoot || target.startsWith(appsRoot + sep) ? "desktop app source" : undefined;
  }
  const blocked = FORBIDDEN_PACKAGES.find((name) => specifier === name || specifier.startsWith(`${name}/`));
  return blocked ? `forbidden package ${blocked}` : undefined;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("document-workflow-core purity", () => {
  it("flags desktop, UI, Tauri, and plugin-runtime imports", () => {
    const file = join(packageSrc, "example.ts");
    const reasons = [
      "../../../apps/desktop/src/documentWorkflow",
      "react",
      "react-dom/client",
      "@tauri-apps/api/core",
      "@chemdraft/plugin-host",
      "@chemdraft/chem-core",
      "./shared"
    ].map((specifier) => forbiddenReason(file, specifier));
    expect(reasons.filter(Boolean)).toHaveLength(5);
  });

  it("imports nothing from apps/, React, Tauri, or the plugin and 3D runtimes", () => {
    const files = sourceFiles(packageSrc);
    expect(files.length).toBeGreaterThan(5);

    const violations = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(SPECIFIER_PATTERN)].flatMap((match) => {
        const reason = forbiddenReason(file, match[1]!);
        return reason ? [`${relative(repoRoot, file)} imports ${match[1]} (${reason})`] : [];
      })
    );
    expect(violations).toEqual([]);
  });
});
