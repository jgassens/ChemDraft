#!/usr/bin/env node
// Read-only release gate. No build, Java, signing, or dependency installation is performed.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMachO, machOSlices, packedVersion, targetArchitecture, versionString } from "./macos-mach-o.mjs";
import { requiredLicenseFiles } from "./required-license-files.mjs";
import { COMMIT_PATTERN, gitOutput } from "./record-build.mjs";

const requiredLicensePaths = new Set(requiredLicenseFiles.map(({ target }) => `Contents/Resources/${target}`));

export function feedForTarget(target) {
  return `https://raw.githubusercontent.com/jgassens/ChemDraft/main/appcast${targetArchitecture(target) === "x86_64" ? "-intel" : ""}.xml`;
}

export function verifySourceCommit(plist, commit) {
  if (!COMMIT_PATTERN.test(plist.ChemDraftSourceCommit ?? "")) throw new Error("ChemDraftSourceCommit: missing or invalid full source commit");
  if (commit !== undefined && plist.ChemDraftSourceCommit !== commit) throw new Error(`ChemDraftSourceCommit: expected ${commit}, found ${plist.ChemDraftSourceCommit}`);
}

// Records contain bundle-relative POSIX paths and parsed slices; no filesystem needed by this gate.
export function verifyInventory({ target, plist, records, commit, allowSidecarPlaceholder = false }) {
  if (commit !== undefined || plist.ChemDraftSourceCommit !== undefined) {
    verifySourceCommit(plist, commit);
  }
  const expected = targetArchitecture(target);
  const minimum = packedVersion(plist.LSMinimumSystemVersion);
  if (plist.SUFeedURL !== feedForTarget(target)) throw new Error(`SUFeedURL: expected ${feedForTarget(target)}, found ${plist.SUFeedURL}`);
  if (typeof plist.CFBundleExecutable !== "string" || !/^[^/\\]+$/.test(plist.CFBundleExecutable)) throw new Error("Missing or invalid CFBundleExecutable");
  const required = [
    `Contents/MacOS/${plist.CFBundleExecutable}`,
    "Contents/MacOS/avogadro3d-sidecar",
    "Contents/Resources/resources/opsin/jre/bin/java",
    "Contents/Resources/resources/opsin/jre/lib/server/libjvm.dylib"
  ];
  for (const path of required) {
    const record = records.find((item) => item.path === path);
    if (allowSidecarPlaceholder && path === required[1] && record?.placeholder) continue;
    if (!record?.slices?.length) throw new Error(`${path}: required Mach-O is missing or is a placeholder`);
  }
  for (const path of requiredLicensePaths) {
    if (!records.some((item) => item.path === path)) throw new Error(`${path}: required bundled licence file is missing`);
  }
  let count = 0;
  for (const { path, slices } of records) {
    if (!slices) continue;
    count++;
    if (!slices.some((slice) => slice.architecture === expected)) throw new Error(`${path}: missing ${expected} slice`);
    // Universal Sparkle dependencies are allowed. The app, sidecar, and Java image are thin.
    if ((required.includes(path) || path.includes("/opsin/jre/")) && slices.length !== 1) throw new Error(`${path}: expected a thin ${expected} binary`);
    for (const slice of slices) {
      if (slice.minimum === undefined) throw new Error(`${path} (${slice.architecture}): no minimum macOS version command`);
      if (slice.minimum > minimum) throw new Error(`${path} (${slice.architecture}): requires macOS ${versionString(slice.minimum)}, exceeds LSMinimumSystemVersion ${plist.LSMinimumSystemVersion}`);
    }
  }
  return count;
}

export function inventoryApp(app) {
  const root = realpathSync(app);
  const visitedDirectories = new Set();
  const records = [];
  function visit(path) {
    const canonical = realpathSync(path);
    const inside = relative(root, canonical);
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error(`Bundle symlink escapes .app: ${path}`);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (visitedDirectories.has(canonical)) return;
      visitedDirectories.add(canonical);
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
    } else if (stat.isFile()) {
      const buffer = readFileSync(path);
      const bundlePath = relative(root, path).split(sep).join("/");
      try {
        if (isMachO(buffer)) records.push({ path: bundlePath, slices: machOSlices(buffer) });
        else if (bundlePath === "Contents/MacOS/avogadro3d-sidecar") records.push({ path: bundlePath, placeholder: buffer.includes(Buffer.from("avogadro3d-sidecar placeholder")) });
        else if (requiredLicensePaths.has(bundlePath)) records.push({ path: bundlePath });
      } catch (error) {
        throw new Error(`${bundlePath}: ${error.message}`);
      }
    }
  }
  visit(root);
  return records;
}

export function readAppPlist(app, run = spawnSync) {
  const plistResult = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(app, "Contents", "Info.plist")], { encoding: "utf8" });
  if (plistResult.status !== 0) throw new Error(`Cannot read bundle Info.plist: ${plistResult.stderr || plistResult.error?.message}`);
  return JSON.parse(plistResult.stdout);
}

export function verifyReleaseTrust(app, dmg, { run = spawnSync, teamId = process.env.APPLE_TEAM_ID } = {}) {
  if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("Release verification requires --team-id or APPLE_TEAM_ID (10-character Apple team ID)");
  if (!dmg || !dmg.endsWith(".dmg")) throw new Error("Release verification requires --dmg <final.dmg>");
  const check = (command, args) => {
    const result = run(command, args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr || result.error?.message || "verification failed"}`);
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  };
  check("codesign", ["--verify", "--deep", "--strict", app]);
  const signature = check("codesign", ["--display", "--verbose=4", app]);
  if (!/^Authority=Developer ID Application: .+$/m.test(signature)) throw new Error("Release app requires a Developer ID Application signature");
  const actualTeam = /^TeamIdentifier=(.+)$/m.exec(signature)?.[1].trim();
  if (actualTeam !== teamId) throw new Error(`Release app team ID: expected ${teamId}, found ${actualTeam ?? "missing"}`);
  for (const path of [app, dmg]) check("xcrun", ["stapler", "validate", path]);
  check("spctl", ["--assess", "--type", "execute", app]);
  check("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", dmg]);
}

export function verifyApp(app, target, { run = spawnSync, inventory = inventoryApp, commit, allowSidecarPlaceholder = false, release = false, dmg, teamId } = {}) {
  if (release && allowSidecarPlaceholder) throw new Error("Release verification cannot allow a sidecar placeholder");
  const plist = readAppPlist(app, run);
  if (release) verifySourceCommit(plist, commit);
  if (commit === undefined && plist.ChemDraftSourceCommit !== undefined) {
    commit = gitOutput(fileURLToPath(new URL("../../", import.meta.url)), ["rev-parse", "HEAD"]);
  }
  const count = verifyInventory({ target, plist, records: inventory(app), commit, allowSidecarPlaceholder });
  if (release) verifyReleaseTrust(app, dmg, { run, teamId });
  return count;
}

function main() {
  const { values, positionals } = parseArgs({ options: { target: { type: "string" }, commit: { type: "string" }, release: { type: "boolean", default: false }, dmg: { type: "string" }, "team-id": { type: "string" }, "allow-sidecar-placeholder": { type: "boolean", default: false } }, allowPositionals: true });
  if (positionals.length !== 1 || !values.target || !positionals[0].endsWith(".app")) throw new Error("Usage: node tools/release/verify-macos-app.mjs <built.app> --target <triple> [--commit <full-sha>] [--release --dmg <final.dmg> --team-id <team-id>] [--allow-sidecar-placeholder (smoke CI only)]");
  targetArchitecture(values.target);
  const app = resolve(positionals[0]);
  const count = verifyApp(app, values.target, { commit: values.commit, allowSidecarPlaceholder: values["allow-sidecar-placeholder"], release: values.release, dmg: values.dmg && resolve(values.dmg), teamId: values["team-id"] });
  if (values["allow-sidecar-placeholder"]) console.warn("Smoke CI only: sidecar placeholder permitted; this is not release acceptance.");
  console.log(`Verified ${count} Mach-O files: ${values.target}, minimum macOS, Sparkle feed and bundled licences (${app})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`macOS release check failed: ${error.message}`); process.exitCode = 1; }
}
