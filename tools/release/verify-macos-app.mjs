#!/usr/bin/env node
// Read-only release gate. No build, Java, signing, or dependency installation is performed.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMachO, machOSlices, packedVersion, targetArchitecture, versionString } from "./macos-mach-o.mjs";
import { requiredLicenseFiles } from "./required-license-files.mjs";
import { gitOutput } from "./record-build.mjs";
import { readAppPlist, refuseUnsignedBuild, withDmgApps } from "./macos-dmg.mjs";
import { verifySourceCommit } from "./source-commit.mjs";

export { readAppPlist } from "./macos-dmg.mjs";
export { verifySourceCommit } from "./source-commit.mjs";

const requiredLicensePaths = new Set(requiredLicenseFiles.map(({ target }) => `Contents/Resources/${target}`));

export function feedForTarget(target) {
  return `https://raw.githubusercontent.com/jgassens/ChemDraft/main/appcast${targetArchitecture(target) === "x86_64" ? "-intel" : ""}.xml`;
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

export function verifyReleaseTrust(app, dmg, { run = spawnSync, teamId = process.env.APPLE_TEAM_ID } = {}) {
  if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("Release verification requires --team-id or APPLE_TEAM_ID (10-character Apple team ID)");
  if (!dmg || !dmg.endsWith(".dmg")) throw new Error("Release verification requires --dmg <final.dmg>");
  const check = (command, args) => {
    const result = run(command, args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr || result.error?.message || "verification failed"}`);
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  };
  check("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const signature = check("/usr/bin/codesign", ["--display", "--verbose=4", app]);
  if (!/^Authority=Developer ID Application: .+$/m.test(signature)) throw new Error("Release app requires a Developer ID Application signature");
  const actualTeam = /^TeamIdentifier=(.+)$/m.exec(signature)?.[1].trim();
  if (actualTeam !== teamId) throw new Error(`Release app team ID: expected ${teamId}, found ${actualTeam ?? "missing"}`);
  check("/usr/sbin/spctl", ["--assess", "--type", "execute", app]);
  check("/usr/bin/xcrun", ["stapler", "validate", dmg]);
  check("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", dmg]);
}

export function verifyApp(app, target, { run = spawnSync, inventory = inventoryApp, commit, allowSidecarPlaceholder = false, release = false, dmg, teamId, ...mountOptions } = {}) {
  if (release && allowSidecarPlaceholder) throw new Error("Release verification cannot allow a sidecar placeholder");
  if (release && (!dmg || !dmg.endsWith(".dmg"))) throw new Error("Release verification requires --dmg <final.dmg> to check the shipped app");
  const checkApp = (payload) => {
    const plist = readAppPlist(payload, run);
    if (release) {
      refuseUnsignedBuild(plist);
      verifySourceCommit(plist, commit);
    }
    if (commit === undefined && plist.ChemDraftSourceCommit !== undefined) {
      commit = gitOutput(fileURLToPath(new URL("../../", import.meta.url)), ["rev-parse", "HEAD"], run);
    }
    const count = verifyInventory({ target, plist, records: inventory(payload), commit, allowSidecarPlaceholder });
    if (release) verifyReleaseTrust(payload, dmg, { run, teamId });
    return count;
  };
  return release ? withDmgApps(dmg, checkApp, { ...mountOptions, run }).reduce((sum, count) => sum + count, 0) : checkApp(app);
}

function main() {
  const { values, positionals } = parseArgs({ options: { target: { type: "string" }, commit: { type: "string" }, release: { type: "boolean", default: false }, dmg: { type: "string" }, "team-id": { type: "string" }, "allow-sidecar-placeholder": { type: "boolean", default: false } }, allowPositionals: true });
  if (values.release && !values.dmg) throw new Error("Release verification requires --dmg <final.dmg> to check the shipped app");
  if (!values.target || (values.release ? positionals.length > 1 : positionals.length !== 1) || (positionals.length && !positionals[0].endsWith(".app"))) throw new Error("Usage: node tools/release/verify-macos-app.mjs [<built.app>] --target <triple> [--commit <full-sha>] [--release --dmg <final.dmg> --team-id <team-id>] [--allow-sidecar-placeholder (smoke CI only)]; <built.app> is required except with --release");
  targetArchitecture(values.target);
  const app = positionals[0] && resolve(positionals[0]);
  const count = verifyApp(app, values.target, { commit: values.commit, allowSidecarPlaceholder: values["allow-sidecar-placeholder"], release: values.release, dmg: values.dmg && resolve(values.dmg), teamId: values["team-id"] });
  if (values["allow-sidecar-placeholder"]) console.warn("Smoke CI only: sidecar placeholder permitted; this is not release acceptance.");
  console.log(`Verified ${count} Mach-O files: ${values.target}, minimum macOS, Sparkle feed and bundled licences (${values.release ? `apps inside ${resolve(values.dmg)}` : app})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`macOS release check failed: ${error.message}`); process.exitCode = 1; }
}
