import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { requiredLicenseFiles } from "./required-license-files.mjs";
import { verifyBundleLicenses } from "./verify-bundle-licenses.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const tauri = join(root, "apps", "desktop", "src-tauri");
const readConfig = (name) => JSON.parse(readFileSync(join(tauri, name), "utf8"));

// Tauri v2 merges objects recursively, replaces arrays, and removes null keys.
function mergeConfig(base, overlay) {
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(overlay)) {
    if (value === null) delete merged[key];
    else if (typeof value === "object" && !Array.isArray(value)) merged[key] = mergeConfig(merged[key] ?? {}, value);
    else merged[key] = value;
  }
  return merged;
}

test("base and every platform overlay map repository licences to top-level licenses targets", () => {
  const base = readConfig("tauri.conf.json");
  const overlays = readdirSync(tauri).filter((name) => /^tauri\..+\.conf\.json$/.test(name));
  for (const name of [null, ...overlays]) {
    const config = name ? mergeConfig(base, readConfig(name)) : base;
    const resources = config.bundle.resources;
    assert.ok(resources && !Array.isArray(resources), `${name ?? "base"}: use Tauri v2 resource map`);
    for (const { source, target } of requiredLicenseFiles) {
      assert.match(target, /^licenses\/[^/]+$/);
      assert.ok(statSync(join(root, source)).isFile(), `${source}: repository source must exist`);
      const matching = Object.entries(resources).filter(([path]) => resolve(tauri, path) === resolve(root, source));
      assert.deepEqual(matching.map(([, destination]) => destination), [target], `${name ?? "base"}: ${source} must map to ${target}`);
    }
    // Map-form globs append only a basename. Directory mappings preserve descendants.
    // In particular, mapping the old naming/**/* glob would flatten naming/licenses/.
    const existing = {
      "resources/opsin/*.jar": "resources/opsin",
      "resources/opsin/*.txt": "resources/opsin",
      "resources/opsin/jre": "resources/opsin/jre",
      "resources/ocsr/*.py": "resources/ocsr",
      "resources/ocsr/*.txt": "resources/ocsr",
      "resources/naming": "resources/naming"
    };
    for (const [source, target] of Object.entries(existing)) {
      assert.equal(resources[source], target, `${name ?? "base"}: preserve installed paths for ${source}`);
    }
    assert.ok(!Object.keys(resources).some((source) => source.startsWith("resources/naming/")), "naming must use a recursive directory mapping, without flattening globs");
    // Exercise nested paths even when the generated host JRE is absent in a checkout.
    for (const source of ["resources/naming/licenses/LGPL-2.1.txt", "resources/opsin/jre/lib/server/libjvm.dylib", "resources/opsin/jre/legal/java.base/LICENSE"]) {
      const directory = source.startsWith("resources/naming/") ? "resources/naming" : "resources/opsin/jre";
      const installed = join(resources[directory], relative(directory, source)).split(sep).join("/");
      assert.equal(installed, source);
    }
  }
});

test("Windows release resource staging requires every licence file at its installed target", () => {
  const root = mkdtempSync(join(tmpdir(), "chemdraft-windows-licenses-"));
  try {
    const staging = join(root, "target", "release");
    for (const { target } of requiredLicenseFiles) {
      const file = join(staging, target);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "fixture licence");
    }
    assert.equal(verifyBundleLicenses(staging), requiredLicenseFiles.length);
    for (const { target } of requiredLicenseFiles) {
      const file = join(staging, target);
      rmSync(file);
      assert.throws(() => verifyBundleLicenses(staging), (error) => error.message.includes(file) && /required bundled licence file is missing/.test(error.message));
      mkdirSync(file);
      assert.throws(() => verifyBundleLicenses(staging), /required bundled licence file is missing/);
      rmSync(file, { recursive: true });
      writeFileSync(file, "fixture licence");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Windows release workflow verifies staged licences after NSIS packaging and before signing", () => {
  const workflow = readFileSync(join(root, ".github", "workflows", "windows-release.yml"), "utf8");
  const build = workflow.indexOf("run: pnpm --filter @chemdraft/desktop build --bundles nsis");
  const check = workflow.indexOf("node tools/release/verify-bundle-licenses.mjs apps/desktop/src-tauri/target/release");
  const signing = workflow.indexOf("- name: Check signing availability");
  assert.ok(build !== -1 && check > build && signing > check);
  assert.match(workflow.slice(check, signing), /if \(\$LASTEXITCODE -ne 0\) \{ throw 'Required bundled licences are missing/);
});
