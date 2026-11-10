// Use Tauri's existing infoPlist merge before signing, without modifying tracked plists.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSource } from "./record-build.mjs";

export function macosReleasePlist(args, { rootDir, target, stable }) {
  const end = args.indexOf("--");
  const options = end < 0 ? args : args.slice(0, end);
  const bundleIndex = options.indexOf("--bundles");
  const bundles = options.find((arg) => arg.startsWith("--bundles="))?.slice(10)
    ?? (bundleIndex >= 0 ? options[bundleIndex + 1] : undefined);
  if (!stable || options[0] !== "build" || options.includes("--debug") || options.includes("--no-bundle") ||
      (bundles !== undefined && !bundles.split(",").includes("dmg"))) return undefined;
  const { commit } = buildSource(rootDir);
  const source = readFileSync(join(rootDir, "apps", "desktop", "src-tauri", target === "x86_64-apple-darwin" ? "Info.intel.plist" : "Info.plist"), "utf8");
  const temp = mkdtempSync(join(tmpdir(), "chemdraft-release-plist-"));
  const plist = join(temp, "Info.plist");
  writeFileSync(plist, source.replace("</dict>", `  <key>ChemDraftSourceCommit</key>\n  <string>${commit}</string>\n</dict>`));
  const config = JSON.stringify({ bundle: { macOS: { infoPlist: plist } } });
  const output = [...args];
  output.splice(end < 0 ? output.length : end, 0, "--config", config);
  return { args: output, cleanup: () => rmSync(temp, { recursive: true, force: true }) };
}
